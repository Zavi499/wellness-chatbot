# Installation, Deployment & Product Training Guide

Wellness World AI Chatbot. Follow the parts in order — each one ends with a check
you can run before moving on.

- **Part 1** — Backend service
- **Part 2** — WordPress plugin
- **Part 3** — Connect and verify
- **Part 4** — Production deployment
- **Part 5** — Training the assistant on your products
- **Part 6** — AI auto-labeling
- **Part 7** — Keeping it current
- **Part 8** — Troubleshooting

---

## Before you start

You need:

| What | Why | Notes |
| --- | --- | --- |
| A server for the backend | Runs the AI service | Small VPS or container, 1 vCPU / 1 GB RAM is enough. **Not serverless** — it needs to stay warm. |
| **Node.js 22.5 or newer** | The service uses Node's built-in SQLite | `node -v` must be ≥ 22.5. Node 24 LTS recommended. |
| An OpenAI API key with billing enabled | Chat, labeling, embeddings | Lives only on the backend server. |
| WordPress 6.0+ with WooCommerce, PHP 8.0+ | The store | Existing live store is fine. |
| Admin access to WordPress | Install the plugin, assign roles | |
| A subdomain + TLS certificate | e.g. `chatbot.wellnesspharmacykw.com` | The widget will not work over plain HTTP on an HTTPS store. |

**The backend never connects to your website.** There is no WooCommerce REST
client in this codebase and nothing to authenticate it with — product data
only ever arrives by push (the plugin queues and forwards it after a save) or
by file (Part 3.3). This matters most on shared/constrained hosting: pulling
the catalogue over the REST API used to cost a second full WordPress +
WooCommerce boot for every product a webhook had already pushed once.

**Do a staging run first.** Point the backend at a staging copy of the store,
run the labeling pass, and look at the results before touching production.

---

# Part 1 — Backend service

## 1.1 Get the code onto the server

```bash
cd /opt
git clone <your-repo> wellness-chatbot
cd wellness-chatbot/backend
npm install --omit=dev
```

If you are copying files rather than cloning, copy the whole project directory
and run `npm install --omit=dev` inside `backend/`.

## 1.2 Generate the shared secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save the output. The same value goes in two places: the backend `.env` and
WordPress's `wp-config.php`. It is what proves a request came from your store.

## 1.3 Configure

```bash
cp .env.example .env
nano .env
```

Fill in at minimum:

```ini
OPENAI_API_KEY=sk-...
WP_BASE_URL=https://www.wellnesspharmacykw.com
WP_SHARED_SECRET=<the secret from 1.2>
DATABASE_PATH=/opt/wellness-chatbot/data/wellness-chatbot.db
PORT=8787
NODE_ENV=production
```

Everything else has a working default. The ones worth knowing about:

| Setting | Default | What it does |
| --- | --- | --- |
| `OPENAI_MODEL_CHAT` | `gpt-5.6-terra` | Model for live conversation turns |
| `OPENAI_MODEL_CHEAP` | `gpt-5.6-luna` | Language detection and other high-volume work |
| `OPENAI_MODEL_LABEL` | `gpt-5.6-sol` | Product auto-labeling, where accuracy matters most |
| `OPENAI_MODEL_EMBED` | `text-embedding-3-small` | Search embeddings |
| `LABEL_CONFIDENCE_THRESHOLD` | `0.6` | Below this, a draft is flagged as low-confidence in the review queue |
| `ALLOW_PARTIAL_VERIFICATION` | `1` | Whether `partial` products can be recommended. Set to `0` for a stricter launch. |
| `SESSION_TTL_MINUTES` | `45` | How long an idle conversation survives |
| `RATE_LIMIT_SESSION_PER_MIN` | `20` | Protects your OpenAI bill |

> **Model IDs were verified on 2026-08-03.** OpenAI retires model names roughly
> monthly. If the service logs "model not found", check the current list and
> change these four lines — no code change needed.

Lock the file down:

```bash
chmod 600 .env
```

## 1.4 Build and seed

```bash
npm run build
npm run seed
```

`seed` loads the bilingual lexicon (sunscreen / واقي شمس, acne / حب الشباب,
brand spellings) and creates ~18 FAQ topics with **empty, unapproved answers**.
That is deliberate — the build does not invent your store's delivery fees or
returns policy. You write those in Part 3.

## 1.5 Start it

```bash
npm start
```

**Check:** in another terminal,

```bash
curl http://localhost:8787/health
```

You should get JSON with `"status":"ok"`, the four model IDs, and a
`missing_settings` list (long at this stage — that is expected).

Stop it with Ctrl-C for now; Part 4 sets it up as a proper service.

---

# Part 2 — WordPress plugin

## 2.1 Install

Copy `wordpress-plugin/wellness-chatbot/` into `wp-content/plugins/` on the
store, so you end up with `wp-content/plugins/wellness-chatbot/wellness-chatbot.php`.

Or zip that one folder and use **Plugins → Add New → Upload Plugin**.

Then **Plugins → Installed Plugins → Wellness Chatbot → Activate**.

You will see a notice saying it is not connected yet. Correct so far.

## 2.2 Add the secret to wp-config.php

Above the `/* That's all, stop editing! */` line:

```php
define( 'WELLNESS_CHATBOT_SECRET', 'the-same-secret-from-step-1.2' );
define( 'WELLNESS_CHATBOT_BACKEND_URL', 'https://chatbot.wellnesspharmacykw.com' );
```

This is better than typing the secret into the settings screen, because it keeps
it out of the database. If you cannot edit `wp-config.php`, the settings screen
has fields for both — the plugin will tell you which it is using.

## 2.3 Assign the pharmacist reviewer (optional)

**Users → (choose the pharmacist) → Role → Pharmacist Reviewer**

Any admin can approve any product in the Label Review Queue, including
supplements and anything mentioning pregnancy, breastfeeding, children or
medicines — this role is not required to verify products or to get the
assistant recommending them.

What this role does do: an approval by a user holding it sets
`verified_by_pharmacist = true`, an honest record used as a small scoring
bonus for child-suitable products (§4.6). If nobody on the team has a
pharmacy background, it's fine to skip this step.

Administrators do **not** get this capability automatically — that keeps the
record meaningful rather than defaulting true for every admin. If the store
owner is also the pharmacist, give their account the role explicitly.

---

# Part 3 — Connect and verify

## 3.1 Fill in the business facts

**Wellness Chatbot → Settings**

Fill in every field. Each one is a fact the assistant is otherwise forbidden to
state:

- Delivery areas, delivery fee, free-delivery threshold, order cut-off time
- Customer service hours
- WhatsApp number (with country code — this powers the "talk to a human" button)
- Phone number, live chat note
- Accepted payment methods
- Loyalty programme rules
- **Returns / exchange / refund policy**

> The original blueprint recorded the returns policy as *"no return / no exchange
> / no refund"*. Confirm with the store owner that this is final and not a
> placeholder before it goes into the FAQ. It materially affects customer trust
> and it is the single riskiest line in the knowledge base.

Leave a field **empty** rather than guessing. An empty field makes the assistant
say "let me check with our team" — which is correct. A wrong value makes it lie
confidently.

Save. The plugin pushes these to the backend immediately.

## 3.2 Write the FAQ answers

**Wellness Chatbot → Knowledge Base**

Each seeded topic needs an English answer, an Arabic answer, and the **Approved**
box ticked. An entry cannot be approved until both languages are filled in.

Unapproved entries are never shown to a customer. When nothing approved matches
a question, the assistant uses the exact fallback wording from the specification
rather than guessing.

**Have the Arabic reviewed by a fluent speaker.** The seeded Arabic in this build
is a working draft, not launch copy.

## 3.3 Load the catalogue

There is no "sync from WooCommerce" button — the backend cannot reach your
site, by design. Three equivalent ways to load it, pick whichever fits:

**From WordPress** (simplest) — **Wellness Chatbot → Settings → Catalogue**:
click **Export catalogue** to download a file, then **Upload catalogue** to
send that same file back. It uploads in batches of 100 products, so even a
large catalogue is never one huge request.

**From the command line, no web request at all** (best for a first load on
tight hosting — this runs via WP-CLI, so it costs nothing on the web server):

```bash
wp wellness-chatbot export --file=/tmp/catalogue.json
```

Copy the resulting file to the backend server (`scp` works fine), then:

```bash
cd /opt/wellness-chatbot/backend
npm run import -- --file /tmp/catalogue.json --embed
```

**Both produce the same result** — every published product, normalized and
embedded for search. Expect the WordPress-side export itself to take a few
seconds per hundred products (it reads your own product list directly, the
same way the admin product screen does — nothing like the cost of hundreds of
authenticated API calls).

**Check:** the Settings screen should now say *"Connected. N products synced,
0 recommendable, N search vectors."* Zero recommendable is correct — nothing is
verified yet. That is Part 6.

After this first load, day-to-day changes take care of themselves: saving a
product in wp-admin queues it automatically and it reaches the backend within
moments, with no REST call in either direction. Re-run an export/upload only
if you ever suspect the two have drifted out of sync — tick **Remove products
the backend has that this file does not** to also clean up anything deleted
while the backend was unreachable.

## 3.4 Turn on the widget

**Settings → Widget → Floating launcher** for a site-wide chat button, or place
`[wellness_chatbot]` on a specific page.

**Check:** open the storefront. The launcher appears bottom-right. Click it and
you should get a greeting. Ask *"what are your delivery charges?"* — you should
get the answer you wrote in 3.2, or an offer to check with the team if you left
it blank.

---

# Part 4 — Production deployment

## 4.1 Run it as a service

Create `/etc/systemd/system/wellness-chatbot.service`:

```ini
[Unit]
Description=Wellness World chatbot backend
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/wellness-chatbot/backend
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# The service only ever needs to write its own data directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/wellness-chatbot/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /opt/wellness-chatbot/data
sudo chown -R www-data:www-data /opt/wellness-chatbot
sudo systemctl daemon-reload
sudo systemctl enable --now wellness-chatbot
sudo systemctl status wellness-chatbot
```

## 4.2 Reverse proxy with TLS

Nginx, for `chatbot.wellnesspharmacykw.com`:

```nginx
server {
    listen 443 ssl http2;
    server_name chatbot.wellnesspharmacykw.com;

    ssl_certificate     /etc/letsencrypt/live/chatbot.wellnesspharmacykw.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chatbot.wellnesspharmacykw.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # A catalogue upload or a labeling run can take a while.
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    server_name chatbot.wellnesspharmacykw.com;
    return 301 https://$host$request_uri;
}
```

```bash
sudo certbot --nginx -d chatbot.wellnesspharmacykw.com
sudo nginx -t && sudo systemctl reload nginx
```

## 4.3 Firewall

Only 80/443 need to be public. Port 8787 should not be reachable from outside:

```bash
sudo ufw allow 80,443/tcp
sudo ufw deny 8787
```

The backend also rejects any request that is not HMAC-signed by your WordPress
site, so an exposed port is not immediately dangerous — but do not rely on that
alone.

## 4.4 Back up the database

```bash
sudo tee /etc/cron.daily/wellness-chatbot-backup >/dev/null <<'EOF'
#!/bin/sh
DEST=/var/backups/wellness-chatbot
mkdir -p "$DEST"
sqlite3 /opt/wellness-chatbot/data/wellness-chatbot.db ".backup '$DEST/db-$(date +%F).sqlite'"
find "$DEST" -name 'db-*.sqlite' -mtime +30 -delete
EOF
sudo chmod +x /etc/cron.daily/wellness-chatbot-backup
```

**This matters.** Raw product data can be re-exported from WordPress and
re-imported any time (Part 3.3). What cannot be regenerated is in this file:
every verification decision your reviewers made, the FAQ answers, the
escalation log, and the analytics history. Losing it means re-reviewing the
whole catalogue by hand.

## 4.5 Updating later

```bash
cd /opt/wellness-chatbot
git pull
cd backend && npm install --omit=dev && npm run build
sudo systemctl restart wellness-chatbot
```

The database migrates itself on start. Verified products are not touched by
updates, and a re-import never overwrites a product a human has already
approved — only the raw WooCommerce-owned fields (price, stock, description)
get refreshed.

If the widget changed:

```bash
cd /opt/wellness-chatbot/widget && npm install && npm run build
```

then copy the updated plugin folder to WordPress.

## 4.6 Monitoring

```bash
sudo journalctl -u wellness-chatbot -f     # live logs
curl https://chatbot.wellnesspharmacykw.com/health
```

Point an uptime monitor at `/health`. It is unauthenticated and returns model
IDs, product counts, and which business settings are still blank.

---

# Part 5 — Training the assistant on your products

## 5.1 What "training" means here — and what it doesn't

The assistant is **not fine-tuned** on your catalogue, and it should not be.
Fine-tuning bakes product facts into model weights, where they cannot be
corrected, audited, or switched off when a product goes out of stock — exactly
the wrong properties for a pharmacy.

Instead it is grounded: on every question it retrieves your actual verified data
and is instructed to use only that. When the data does not exist, it says so.

The practical effect is that **the quality of the assistant is the quality of
your product data**, and improving it is a data task, not a model task. That is
good news — a pharmacist can improve it directly, with no engineer involved.

Five layers make up the assistant's knowledge:

| Layer | Where it lives | Who owns it |
| --- | --- | --- |
| 1. Product catalogue | WooCommerce | Whoever manages the store |
| 2. `_wwc_*` product labels | AI draft → human approved | Pharmacist / product owner |
| 3. FAQ knowledge base | Wellness Chatbot → Knowledge Base | Store owner |
| 4. Bilingual lexicon | `backend/src/search/lexicon.ts` | Developer |
| 5. Business facts | Wellness Chatbot → Settings | Store owner |

Layer 2 is where most of the value sits, and Part 6 is about producing it.

## 5.2 Getting layer 1 right first

The AI labeling can only work with what your product pages say. Before running a
full labeling pass, spot-check twenty of your best-selling products:

- Does the description mention **who it suits** (oily / dry / sensitive skin)?
- Does it name the **key active ingredients**?
- Does it say **what it is for** (acne, dryness, pigmentation)?
- Is the **texture** described (gel, cream, oil)?
- For supplements: is the **serving size printed on the page**?

A product whose description is *"Premium quality face cream. 50ml."* will produce
a near-empty draft with low confidence, and correctly so — the model is
instructed to return null rather than invent. Twenty minutes improving your ten
best-selling descriptions is worth more than any prompt change.

## 5.3 Teaching it customer vocabulary

Customers do not search the way your catalogue is written. The lexicon in
`backend/src/search/lexicon.ts` maps what they type to what you sell:

```ts
{
  kind: 'product_type',
  canonical: 'sunscreen',
  name_en: 'Sunscreen',
  name_ar: 'واقي شمس',
  synonyms_en: ['sunscreen', 'sunblock', 'sun block', 'spf', 'sun cream'],
  synonyms_ar: ['واقي شمس', 'صن بلوك', 'واقي الشمس', 'كريم شمس'],
}
```

Add entries for brands you carry and terms your customers actually use —
including misspellings you see in your live-chat history. After editing:

```bash
npm run seed && sudo systemctl restart wellness-chatbot
```

You do not need to enumerate everything. Embeddings handle novel phrasings; the
lexicon is for the cases where an exact term matters, especially brand names in
Arabic script.

## 5.4 The feedback loop

Once live, **Wellness Chatbot → Analytics** shows where the assistant is failing:

- **No-answer rate rising** → a topic is missing from the knowledge base
- **Thumbs-down reasons** → read them; they name the actual problem
- **Low questionnaire completion** → a question is confusing or too early
- **High handover rate** → either the safety rules are working as intended, or a
  whole category lacks verified data

Weekly during launch, monthly once stable. Fix findings in the product data and
knowledge base — not by rewriting prompts. A prompt tweak that papers over
missing data will fail differently next week.

---

# Part 6 — AI auto-labeling

## 6.1 What it does

For each product, the labeling pipeline reads the name, description, categories
and attributes, then produces a structured draft of the `_wwc_*` fields: main
concerns, suitable skin/hair types, who it is not ideal for, key ingredients,
texture, fragrance and alcohol flags, how to use, routine step, age suitability,
warnings, and Arabic search synonyms.

Three rules are enforced in code, not just asked for in the prompt:

1. **Nulls are allowed and expected.** If the source text does not support a
   field, the model must return null rather than guess. A thin description
   produces a thin draft — by design.
2. **Every draft is `unverified`.** The pipeline is structurally incapable of
   marking anything verified. Only a human action can do that.
3. **Sensitive products are flagged automatically.** Any product in Vitamins &
   Wellness, or whose text mentions pregnancy, breastfeeding, infants, children,
   or medicines, is marked so a reviewer knows to look closer — any admin may
   still approve it, this is informational, not a requirement.

Supplements get an extra instruction: never infer dosage safety, upper limits, or
interactions. Serving size and amounts are copied exactly as printed, or left
null. Those fields are worth a pharmacist's eye if one is available, but any
reviewer can fill them in from the manufacturer leaflet.

## 6.2 Run a trial batch first

Always start small so you can judge quality and cost:

```bash
cd /opt/wellness-chatbot/backend
npm run label -- --limit 25
```

You will see per-product progress with the resolved category, confidence, and a
`[pharmacist]` marker where the extra-care flag fired. At the end it reminds
you that everything is unverified.

Now open **Wellness Chatbot → AI Label Review Queue** and read those 25. If the
drafts are mostly empty, the problem is your product descriptions (see 5.2), not
the model.

## 6.3 Run the full pass

```bash
npm run label
```

This skips products that already have a pending draft and never re-labels
human-verified data. It is safe to re-run — an interrupted pass picks up where it
left off.

For a large catalogue, run it in a detached session so an SSH drop does not kill
it:

```bash
nohup npm run label > /tmp/labeling.log 2>&1 &
tail -f /tmp/labeling.log
```

You can also trigger it from **Settings → Maintenance** by ticking "Also run AI
labeling", but the command line is better for the first full run.

### Rough cost

For a catalogue of about 740 products, one full labeling pass is roughly
**$10–15** at the flagship model's current rates (~700 input + ~400 output tokens
per product). Embeddings for the same catalogue cost well under a dollar.

Both are one-off per product, not per conversation. Re-check current pricing
before budgeting — rates change.

## 6.4 Review and approve

**Wellness Chatbot → AI Label Review Queue**

Products are sorted **lowest confidence first**, so the drafts most likely to be
wrong are the ones you see first. Each card shows the currently stored value
beside the AI suggestion, with the suggestion editable.

For each product:

- **Approve as verified** — the data is complete and correct. It becomes
  recommendable.
- **Approve as partial** — correct but incomplete. Still recommendable, but the
  assistant has less to work with. Use this to get coverage quickly.
- **Reject** — the draft is wrong. The product stays unverified and invisible to
  the assistant.
- **Re-run AI labeling** — after you have improved the product description.

Editing before approving is the normal case, not the exception. What you save
becomes the truth; the AI's version is discarded.

Bilingual fields use `english | arabic` in a single box — for example
`Not ideal for sensitive skin | غير مناسب للبشرة الحساسة`. Lists are
comma-separated.

Add a review note when you check against a manufacturer leaflet. It goes into the
audit trail, which is what **Version History** shows.

### Pharmacist-flagged products in practice

A product marked *"Touches vitamins/supplements or mentions pregnancy,
children or medicines"* can still be approved by any admin — the flag is a
prompt to double-check the draft against a manufacturer leaflet, not a
restriction on who can click Approve. If you do want an actual pharmacist's
sign-off on these before they go live, that has to be a team process (route
the flagged rows to them before anyone clicks Approve) — the software will not
enforce it for you.

## 6.5 Practical order of work

You do not need the whole catalogue verified to launch.

1. Sort your products by sales volume.
2. Verify your **top 50 sellers** properly, editing as you go. That covers most
   of what customers ask about.
3. Bulk-approve low-risk face and body products as **partial** for coverage.
4. Leave the long tail unverified. The assistant simply will not offer those
   products — it will not offer them wrongly, which is the point.
5. If someone on the team has a pharmacy background, it's still worth having
   them approve the Vitamins & Wellness queue specifically — but nothing
   requires it, and any admin can do it if there's nobody to hand it to.

**Check:** Settings should now show a non-zero "recommendable" count. Open the
widget, choose Face care, and walk through the questionnaire. You should get up
to three cards with real prices and stock badges.

## 6.6 Re-labeling

Re-label a single product from the queue after improving its description.

To have every product save trigger a re-label, tick **Settings → Widget →
Re-run AI labeling on save**. It is off by default on purpose: with it on, a bulk
price update would trigger a catalogue-wide model spend. Note that re-labeling
never touches human-verified data, so switching it on will not undo your
pharmacist's work.

---

# Part 7 — Keeping it current

Once running, saving a product just queues its id — no request happens during
the save itself. That queue flushes as one batched push moments later (after
the page has already loaded), or via a background job every five minutes if
a lot of products changed at once — a 500-product bulk edit becomes a handful
of requests, not 500. Stock changes and deletions carry no product data, so
those still go out immediately; an out-of-stock product stops being
recommended within seconds either way.

What still needs a human, on a schedule:

| How often | Task |
| --- | --- |
| Daily during launch | Check the Escalation Log — emergencies also raise a notice anywhere in wp-admin |
| Weekly during launch | Review thumbs-down feedback and the no-answer rate |
| Weekly | Clear the Label Review Queue for new products |
| Monthly | Analytics review; re-test the safety flows after any big catalogue or policy change |
| After any policy change | Update Business Settings and the FAQ — never leave the assistant quoting an old policy |

---

# Part 8 — Troubleshooting

**Settings says "Could not reach the backend"**
Check the service is running (`systemctl status wellness-chatbot`) and that the
backend URL in WordPress matches your actual domain including `https://`.

**"Signature mismatch" in the backend logs**
`WP_SHARED_SECRET` and `WELLNESS_CHATBOT_SECRET` differ. They must be byte-identical.

**"Request timestamp is outside the allowed window"**
The two servers' clocks differ by more than five minutes. Install `chrony` or
`systemd-timesyncd` on the backend host.

**The widget does not appear**
The plugin refuses to load a widget it cannot connect to. Fix the connection
first. Also confirm either the floating launcher is on or the shortcode is placed.

**The assistant will not recommend anything**
Check the recommendable count in Settings. If it is zero, nothing has been
approved yet — that is Part 6.4, not a bug. Any admin can approve, including
supplements and pregnancy/children/medicine-flagged products — a Pharmacist
Reviewer is not required.

**"Model not found" in the logs**
An OpenAI model ID was retired. Update the four `OPENAI_MODEL_*` lines in `.env`
and restart.

**Labeling produces mostly empty drafts**
Your product descriptions do not contain the information. See 5.2 — this is the
model behaving correctly rather than inventing.

**Arabic replies read like machine translation**
They partly are — the seeded Arabic is a working draft. Have a fluent speaker
rewrite the FAQ answers and the approved product text.

---

## Known gaps

- **The plugin PHP has not been linted or run.** The machine it was written on
  has no PHP toolchain. Run `php -l` over every file in
  `wordpress-plugin/wellness-chatbot/` and test on a staging WordPress before
  going live on the production store.
- **There is no admin screen for editing questionnaire questions yet.** The
  backend supports it (`/api/admin/questionnaires/:id`, with validation), and the
  questions live in editable JSON at
  `backend/src/questionnaire/config/*.json` — copy a file into
  `<data-dir>/questionnaire/` to override it without touching the code tree. A
  UI for this is worth building once the question set settles after launch.
- **Model IDs and pricing** were verified on 2026-08-03 and need re-checking
  before go-live.
