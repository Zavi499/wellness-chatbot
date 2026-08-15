# Wellness World AI Chatbot — Technical Documentation

Companion to `README.md`. Section numbers in parentheses refer to the *Master
Guidelines & Technical Build Specification v1.0*.

---

## 1. Architecture

```
Storefront browser
      │  (widget: no secret, no OpenAI, no localStorage)
      ▼
WordPress + WooCommerce  ──── wellness-chatbot plugin
      │  HMAC-signed, server-to-server
      ▼
Backend service (Node/TS/Fastify)
      │
      ├── SQLite: products, embeddings, sessions, KB, escalations, events, audit
      └── OpenAI: chat + tools, structured-output labeling, embeddings
```

The widget never holds the shared secret. WordPress mints a short-lived,
session-bound token for the browser and signs the real request itself (§11).

**Why this split** (§1.1): the OpenAI key stays off the WordPress host;
embeddings-based bilingual retrieval is awkward in PHP/MySQL; the conversation
state machine and escalation engine are testable outside WordPress's request
lifecycle; and the parts that will change weekly ship without a plugin release.

### Deviations from the spec, and why

| Spec suggestion | What was built | Reason |
| --- | --- | --- |
| SQLite + `sqlite-vec` | Node's built-in `node:sqlite`, Float32 BLOBs, cosine in process | No native build step on the host. At a few thousand SKUs this is sub-millisecond. `search/vector.ts` is the only file to change if the catalogue outgrows it. |
| Redis for sessions | A `sessions` table in the same SQLite file | Avoids a second service for a single-country store. Same TTL semantics. |
| Node 20+ | Node 22.5+ | Required by `node:sqlite`. Documented in `package.json` `engines`. |
| Backend pulls the catalogue via WooCommerce REST | Backend has no REST client at all; WordPress pushes | The original design (`products/woocommerce.ts`, since removed) pulled products on every webhook that lacked a full payload, meaning each save cost a second full WordPress + WooCommerce boot to service the pull — untenable on constrained/shared hosting. Traffic is now strictly one-directional: the plugin's queue (`WWC_Queue`) batches full product data on save, and the initial/bulk load is a file (`WWC_Exporter` → `/api/admin/catalogue/import`), not an API pull. `products/normalize.ts` is the one place a `WooRawProduct` becomes a stored row, regardless of which path delivered it. |

---

## 2. Data model

### Products (`backend/src/db/schema.sql`)

WooCommerce natives plus the `_wwc_*` extension schema (§3.2). The WordPress
plugin registers the same fields as post meta so WooCommerce stays the system of
record for anything a human confirmed.

Two halves, deliberately separate:

- `upsertWooFields()` writes only WooCommerce-owned columns. A re-sync can
  **never** undo a pharmacist's verification.
- `updateWwcFields()` writes only the extension schema.

### Verification states

| State | Meaning | Recommendable? |
| --- | --- | --- |
| `verified` | A human confirmed the data | Yes |
| `partial` | Human-confirmed but incomplete | Yes, if `ALLOW_PARTIAL_VERIFICATION=1` |
| `unverified` | AI draft, or never labeled | No |
| `needs_pharmacist_review` | Awaiting a pharmacist | No |

A product with `requires_pharmacist_review = true` is held to the exact same
bar as any other product — any admin's `verified` is enough. The flag is
informational (surfaced in the review queue so a reviewer knows to look
closer); `verified_by_pharmacist` only records whether a user holding
`wwc_pharmacist_review` actually did the approval, used as a scoring signal
for child-suitable products (§4.6), not an eligibility requirement.

---

## 3. AI auto-labeling (§3.3, §13)

`backend/src/labeling/`

1. `pipeline.ts` resolves the product's category from the store taxonomy. If it
   cannot, it does **not** guess — the queue shows "category unresolved".
2. A structured-output call using the per-category schema in `schemas.ts`. Every
   field is nullable so "I cannot tell from the source text" is expressible.
3. `gate.ts` applies the pharmacist gate: the whole Vitamins & Wellness shelf,
   anything mentioning pregnancy / breastfeeding / children / medicines, or the
   model raising `mentions_sensitive_topic` itself.
4. Values are written with `verification_status = 'unverified'`,
   `ai_generated = true`, and the model's self-reported confidence.
5. A `label_drafts` row queues it for review, lowest confidence first.

Vitamins get an extra instruction never to infer dosage safety or interactions —
those fields stay null for a reviewer to fill in.

`applyReview()` is the only path to `verified`. Pharmacist review is
informational, not a requirement — any admin may approve any product,
gated or not; the review queue just flags gated products for a closer look.

---

## 4. Conversation engine (§4)

`backend/src/chat/orchestrator.ts` — one turn, in this order:

1. Load or create the session.
2. Detect language; lock it (§6.1).
3. **Safety screen before the model** (§5). An emergency returns approved copy
   with no API call at all.
4. Assemble context: locked language, collected answers, business settings, the
   next questionnaire question, retrieved FAQ text.
5. Call OpenAI with the tool set, looping up to four tool rounds.
6. Any escalation — rule-triggered or model-triggered — lands in the same log.
7. Return structured JSON: text, quick replies, cards, progress, handoff.

### Tools (§4.3)

`get_faq_answer`, `submit_questionnaire_answer`, `get_recommendations`,
`escalate_to_human`, `search_products`.

Each executor re-validates. `get_recommendations` refuses outright when selling
is blocked; `search_products` filters to verified, in-stock products before the
model ever sees a name.

### Questionnaires (§4.4)

JSON in `backend/src/questionnaire/config/`, editable through the admin without a
deploy. Edits land in `data/questionnaire/` and override the shipped defaults.

`validateQuestionnaire()` enforces the spec's own question-writing rules so
future edits stay compliant: bilingual text, 3–7 options per screen, an "I'm not
sure" option on any question assuming product knowledge, and escalation rules
that reference real option values.

Branch questions use `show_if`, so a customer answers ~6 questions, not 20.

### Recommendation engine (§4.5, §4.6)

- `eligibility.ts` — stock, verification, category match, `not_ideal_for`
  conflicts, avoided ingredients, age. Every rejection carries a reason so a
  thin result set is explainable.
- `scoring.ts` — the 100-point weighted model, exactly as specified. The
  breakdown is retained for the widget's "Why this?" panel.
- `select.ts` — Best Overall / Best Value (≥15% cheaper or better cost-per-use) /
  Alternative (meaningfully different). Returns fewer than three rather than
  padding.

---

## 5. Safety engine (§5)

`backend/src/safety/`

- `triggers.ts` — every trigger from §5.1 and §5.2, each with English **and**
  Arabic patterns. A test asserts that no rule ships English-only.
- `templates.ts` — approved copy, returned verbatim. This is the one place the
  assistant speaks without the model.
- `engine.ts` — screening, the escalation log, and the "selling blocked" flag.

An emergency blocks selling for the whole session. A pharmacist review pauses
that topic but lets the conversation continue (§5.2).

Card numbers, CVVs, passwords and 12-digit Civil IDs are detected and never
echoed back (§5.4).

---

## 6. Bilingual behaviour (§6)

Script-ratio detection settles almost every message with no API call; only
genuinely mixed input (between 15% and 60% Arabic) escalates to the cheap model,
and if that is still unclear the customer is asked once and the language locks.

`search/normalize.ts` folds Arabic orthography (أ/إ/آ → ا, ة → ه, tashkeel,
tatweel), converts Arabic-Indic digits, and expands synonyms from
`search/lexicon.ts` — seeded with the spec's own examples (sunscreen / سن بلوك,
acne / حب الشباب, La Roche-Posay / لاروش).

**Arabic copy in this build is a working draft.** A fluent speaker must review
it before launch (launch checklist).

---

## 7. WordPress plugin

| File | Responsibility |
| --- | --- |
| `class-wwc-plugin.php` | Container |
| `class-wwc-settings.php` | Options + the business facts (§8.5) |
| `class-wwc-backend-client.php` | HMAC-signed server-to-server client |
| `class-wwc-roles.php` | `wwc_pharmacist_review` / `wwc_manage_chatbot` |
| `class-wwc-meta.php` | `_wwc_*` schema + the verification gate |
| `class-wwc-rest.php` | Widget proxy endpoints |
| `class-wwc-webhooks.php` | Save/stock/delete hooks — queues on save, pushes immediately for stock/delete |
| `class-wwc-queue.php` | The save queue: batches on `shutdown`, drains a backlog via cron |
| `class-wwc-product-payload.php` | The one place a `WC_Product` becomes the shape the backend expects |
| `class-wwc-exporter.php` | Bulk catalogue export (`wc_get_products`, not REST) |
| `class-wwc-cli.php` | `wp wellness-chatbot export` |
| `class-wwc-widget.php` | Shortcode, launcher, enqueue, bilingual chrome |
| `class-wwc-brand.php` | Brand ramp (primary `#9322AA`) |
| `admin/*.php` | The six admin screens (§8) |

Administrators get `wwc_manage_chatbot` on activation but **not**
`wwc_pharmacist_review` — any admin may still approve any product, but that
separation keeps `verified_by_pharmacist` an honest record of who actually
holds the pharmacist role, rather than defaulting true for every admin.

Saving a product no longer makes an HTTP request at all — it only enqueues an
id (`WWC_Queue`). The queue flushes as one batched push on `shutdown` if it's
small, or via a five-minute cron drain if a bulk edit left a large backlog, so
saving a product in wp-admin is never slowed by the chatbot even in aggregate.
Stock changes and deletions still push immediately — they carry no product
data, so a single small request costs almost nothing. Re-labeling on save is
opt-in, because a bulk price edit would otherwise trigger catalogue-wide model
spend.

---

## 8. Widget (§9)

Vanilla TypeScript, ~14 kB minified, built by esbuild into the plugin's assets.

Implemented from the §9.2 feature table: quick replies, progress indicator with
back navigation, session-persisted answers, compare drawer, expandable
"Why this?", replace-this-option, stock badges, human-handover carrying the
transcript forward, thumbs feedback with an optional reason, and the privacy
notice.

Accessibility: focus trap, Escape to close, ARIA live region for messages,
`role="progressbar"`, visible focus rings, 40–48px tap targets,
`prefers-reduced-motion` and `forced-colors` support. RTL comes from CSS logical
properties — no second stylesheet.

The session ID lives in memory only, never `localStorage`, per the spec's
stateless-frontend constraint. Add-to-cart goes through WooCommerce's own AJAX
endpoint; the backend never touches cart state.

---

## 9. Tests

```bash
cd backend && npm test
```

88 tests, no network or API key required:

- **Safety** — every §5.1 and §5.2 trigger in both languages, emergency
  precedence, false-positive checks on ordinary shopping questions, sensitive
  data detection, the pharmacist gate.
- **Recommendation** — eligibility rules, the 100-point weights, diversity
  penalty, top-three selection, no-padding, Arabic card labels.
- **Conversation** — questionnaire validation, never-ask-twice, branch
  conditions, questionnaire escalation rules, language detection, Arabic
  normalization and synonyms, HMAC signing and replay rejection, product push
  validation (a payload naming a product without describing it is rejected,
  not treated as a reason to fetch it).

---

## 10. Operations

**Deploy**: a warm container/VPS next to the WP host, reverse-proxied via Nginx.
Avoid serverless — session state and the in-process vector index want a warm
instance.

**Back up** `DATABASE_PATH`. It holds verification decisions, the FAQ, the
escalation log and analytics. Products can be re-synced; those cannot.

**Costs**: chat turns use the balanced model, language detection the cheapest,
labeling the flagship, and labeling runs once per product. Rate limits are
per-session and per-IP.

**Monitor**: `/health` reports model IDs, product counts and unconfirmed
settings. The admin Analytics screen carries the §14 KPIs.

---

## 11. Launch checklist

- [ ] All Business Settings entered — the Settings screen shows what is missing
- [ ] Top-selling products have complete, verified data
- [ ] All four category questionnaires tested end to end
- [ ] Top-three recommendations stock-aware and explainable
- [ ] Human handover tested, including the WhatsApp path
- [ ] **Arabic wording reviewed by a fluent speaker, not machine-translated**
- [ ] Privacy notice visible in the widget
- [ ] Emergency and pharmacist escalation paths tested
- [ ] Analytics events visible on the dashboard
- [ ] A named owner for label review, KB edits and KPI review
- [ ] Returns policy explicitly confirmed with the store owner
- [ ] **`php -l` run over every plugin file, on a staging site**

---

## 12. Open items needing a human answer (§16)

1. **Returns policy** — the blueprint records "no return / no exchange / no
   refund". Confirm this is final, not a placeholder. It materially affects
   customer trust and it is currently the FAQ's single riskiest entry.
2. **Multilingual plugin** — is WPML or Polylang active? `WWC_Meta` detects both
   and exposes the `wwc_bilingual_meta` filter; without one, the flat `_ar` meta
   keys are used.
3. **Human handoff channel** — the real WhatsApp Business number, and whether a
   live-chat tool is in use.
4. **Backend hosting** — where the Node service runs, and access provisioning.
5. **Pharmacist reviewer** — optional. Assigning `wwc_pharmacist_review` to
   someone with that background keeps `verified_by_pharmacist` (and the
   child-suitability scoring bonus it feeds) meaningful, but any admin can
   already approve supplements and pregnancy/children/medicine-flagged
   products without one.
6. **Business facts** — every field on the Settings screen.
7. **Model IDs and pricing** — re-confirm against OpenAI's live list. Verified
   `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.6-sol` / `text-embedding-3-small`
   on 2026-08-03.

Items 1–3 and 5 are business decisions this build cannot make. The code is
written so each one is a settings change, not a code change.
