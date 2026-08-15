# Wellness World AI Chatbot

AI shopping assistant for the Wellness World WooCommerce store (Kuwait) — guided
product finder, verified FAQ answers, bilingual EN/AR conversation, and a
pharmacist-gated safety engine.

Built to the *Wellness World AI Chatbot — Master Guidelines & Technical Build
Specification v1.0*. Section references throughout the code point back to it.

---

## What's here

| Directory | What it is |
| --- | --- |
| `backend/` | Node 22+ / TypeScript / Fastify service. Conversation orchestration, retrieval, recommendation scoring, safety engine, AI auto-labeling, OpenAI calls. |
| `wordpress-plugin/wellness-chatbot/` | The WordPress plugin. Thin integration layer: widget embedding, signed REST proxy, WooCommerce webhooks, `_wwc_*` meta schema, pharmacist role, six admin screens. |
| `widget/` | Storefront chat widget source (vanilla TypeScript). Builds straight into the plugin's `assets/js/widget.js`. |

The split is deliberate (spec §1.1): the OpenAI key never touches the WordPress
server, and the parts that change weekly after launch — prompts, scoring,
questionnaires — ship without a plugin release.

---

> **Installing this for real?** Follow [DEPLOYMENT.md](DEPLOYMENT.md) instead of
> the quick start below — it covers the server setup, TLS, backups, and how to
> label and verify the product catalogue.
>
> **Deploying to Coolify?** Use [COOLIFY-DEPLOYMENT.md](COOLIFY-DEPLOYMENT.md) —
> the container path, with the persistent-volume setup that keeps your
> verification decisions across redeploys.

## Quick start

### 1. Backend

```bash
cd backend && npm install && cp .env.example .env
```

Fill in `.env`: `OPENAI_API_KEY`, `WP_BASE_URL`, `WP_SHARED_SECRET`. Generate
the shared secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then seed and start:

```bash
cd backend && npm run seed && npm run dev
```

`npm run seed` loads the bilingual lexicon and creates the FAQ topic list with
**empty, unapproved answers** — those are for the store owner to write, not for
this build to invent.

**The backend never connects to your WooCommerce store.** There is no REST
client and no WooCommerce API keys anywhere in this codebase — product data
only ever arrives by push (the plugin's save queue) or by file (Part 3 below).
This is deliberate: pulling the catalogue over the REST API meant every
product save cost a second full WordPress + WooCommerce boot, which is exactly
the load this design avoids on constrained hosting.

### 2. WordPress plugin

Copy `wordpress-plugin/wellness-chatbot/` into `wp-content/plugins/` and
activate it. Then add the secret to `wp-config.php` (better than the options
table):

```php
define( 'WELLNESS_CHATBOT_SECRET', 'the-same-value-as-WP_SHARED_SECRET' );
define( 'WELLNESS_CHATBOT_BACKEND_URL', 'https://chatbot.example.com' );
```

Go to **Wellness Chatbot → Settings** and fill in the business facts. Assigning
the **Pharmacist Reviewer** role to a user is optional — it's informational
only, and any admin can approve any product regardless.

### 3. Load the catalogue

Product data arrives by push after this point — every product save
automatically queues and forwards itself. For the first load, use
**Wellness Chatbot → Settings → Catalogue**: **Export catalogue** downloads a
file, **Upload catalogue** sends it to the backend in batches. Or, from the
backend server directly:

```bash
cd backend && npm run import -- --file ./catalogue.json --embed
```

### 4. Label the catalogue

```bash
cd backend && npm run label -- --limit 25
```

Start with a limit to see the cost and quality, then run the full pass.
Labeling is direct: every product this labels becomes `verified` and
recommendable immediately — no review step, for any category. The one
exception is a product whose category can't be resolved from WooCommerce at
all; that lands in **Wellness Chatbot → AI Label Review Queue** with nothing
generated, waiting on a category/tag fix and a re-run.

### 5. Widget

The bundle is already built and committed into the plugin. To change it:

```bash
cd widget && npm install && npm run build
```

Place it with the `[wellness_chatbot]` shortcode, or switch on the site-wide
floating launcher in Settings.

---

## The rules this build treats as non-negotiable

These come from the spec and are enforced in code, not just in prompts:

- **Labeling is direct, by explicit store-owner decision.** The labeling
  pipeline writes straight to `verified` — no human review step, for any
  category, including vitamins/supplements and anything mentioning pregnancy,
  breastfeeding, children or medicines. This is a deliberate departure from
  the original spec's human-in-the-loop requirement (§3.1, §11); see
  `backend/src/labeling/pipeline.ts` for the current behavior. The one
  exception: a product whose category can't be resolved has nothing generated
  to verify, so it stays `unverified` until that's fixed.
- **`verified_by_pharmacist` stays honest regardless.** It is only ever set
  true when a user holding `wwc_pharmacist_review` did the approval — never by
  the direct-labeling path, never by a non-pharmacist admin. It currently
  feeds a small scoring bonus for child-suitable products (§4.6), nothing more.
- **Safety screening runs before the model.** An emergency short-circuits to
  approved copy with no API call, stops selling for the rest of the
  conversation, and is logged (§5.1).
- **Unconfirmed business facts stay unconfirmed.** Delivery fees, hours and the
  returns policy are read live from Business Settings. An empty field makes the
  assistant offer to check with a human rather than state a value (§8.5).
- **No padding.** If fewer than three products genuinely fit, the customer is
  told so (§4.6).
- **Never ask the same question twice.** Enforced by the questionnaire engine
  against session state, not by asking the model to remember (§4.1).

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` (backend) | Start with reload |
| `npm test` (backend) | 88 tests — safety triggers, scoring, eligibility, questionnaire, bilingual, signing, push validation |
| `npm run seed` | Lexicon + FAQ topic skeleton |
| `npm run import -- --file <path> --embed` | Load a catalogue export and build embeddings |
| `npm run label -- --limit N` | AI auto-labeling pass |
| `npm run build` (widget) | Rebuild the storefront bundle into the plugin |

---

## Before go-live

See `DOCUMENTATION.md` § "Launch checklist" and § "Open items". The short
version: seven business decisions still need a human answer, and the Arabic
copy needs a fluent reviewer.

## Known gaps

- **The PHP has never been linted or run.** This machine has no PHP toolchain.
  Run `php -l` over every file and test on a staging WordPress before handover.
- OpenAI model IDs were verified on 2026-08-03. Re-check before launch — the
  lineup moves roughly monthly.
