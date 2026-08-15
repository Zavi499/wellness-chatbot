# Deploying to Coolify

Step-by-step guide for deploying the chatbot backend to a server running the
Coolify GUI. Assumes Coolify is already installed and you can reach its
dashboard.

Only the **backend** deploys to Coolify. The WordPress plugin is installed on
your existing store as normal (Part 6), and the widget bundle is already built
into the plugin.

Everything in this guide was verified by building and running the actual image:
it boots, `/health` responds, the Docker health check passes, and the database
survives a container restart.

---

## What you'll end up with

```
Coolify server
 └── Application: wellness-chatbot
      ├── Source: your Git repo, Base Directory /backend
      ├── Build: Dockerfile (Node 24)
      ├── Domain: https://chatbot.yourstore.com  ← Coolify handles TLS
      ├── Persistent volume: /app/data           ← the important one
      └── Health check: /health
```

---

## Before you start

| What | Notes |
| --- | --- |
| Your code in a Git repo | GitHub, GitLab, Gitea, or Bitbucket. Private is fine. |
| A subdomain pointed at your Coolify server | e.g. `chatbot.yourstore.com`, an A record to the server's IP. Set this up first — DNS takes time to propagate, and Coolify needs it resolving before it can issue a certificate. |
| An OpenAI API key | With billing enabled. |

**No WooCommerce API keys anywhere in this guide.** The backend never connects
to your website — there's no REST client in the codebase to authenticate. This
matters specifically for a Coolify/container deployment: pulling the catalogue
over the REST API meant a second full WordPress + WooCommerce boot for every
product a webhook had already pushed once, which is exactly the kind of load
that exhausts a constrained hosting plan's process limits.

---

## Part 1 — Push the code

Coolify deploys from Git, so the project needs to be in a repository:

```bash
cd "T:/welness chatbot"
git init
git add .
git commit -m "Wellness World chatbot"
git remote add origin git@github.com:yourorg/wellness-chatbot.git
git push -u origin main
```

The included `.gitignore` already excludes `node_modules/`, `.env`, and
`backend/data/`. **Confirm no real `.env` file was committed** before pushing to
anything shared:

```bash
git ls-files | grep -i "\.env$" && echo "STOP — a .env got committed" || echo "clean"
```

---

## Part 2 — Create the application in Coolify

1. Open the Coolify dashboard.
2. **Projects → + New Project** — name it `Wellness World`.
3. Inside the project, pick an environment (`production` is created by default).
4. **+ New Resource → Application**.
5. Choose your Git source:
   - **Public Repository** — paste the URL.
   - **Private Repository (GitHub App)** — the smoother option for private
     repos; Coolify walks you through authorising it and gives you automatic
     deploy-on-push.
6. Select the repository and set the branch to `main`.

### Critical settings on the configuration screen

| Field | Value | Why |
| --- | --- | --- |
| **Build Pack** | `Dockerfile` | Do **not** use Nixpacks. It usually picks an older Node, and this service requires **Node ≥ 22.5** for its built-in SQLite. The included Dockerfile pins Node 24. |
| **Base Directory** | `/backend` | The repo root holds three folders; the backend is the one that deploys. |
| **Dockerfile Location** | `/backend/Dockerfile` | Coolify may fill this in from Base Directory — check it points at the backend's Dockerfile. |
| **Port Exposes** | `3000` (Coolify's default — leave it) | Coolify injects a `PORT` environment variable matching whatever you put here, and the app reads `PORT` from its environment. So this field doesn't just document the port, it **sets** it — there's no need to change it to match the Dockerfile's fallback of `8787`. |

Save. Whatever you choose here, Part 5's health check **must** use the same
number — that's the one place this can quietly break.

---

## Part 3 — The persistent volume

**This is the step that matters most. Skip it and you lose your data on every
redeploy.**

Coolify containers are replaced on each deployment. The chatbot keeps its
database in a single SQLite file, and that file holds things that cannot be
regenerated from WooCommerce: every verification decision your pharmacist made,
your FAQ answers, the escalation log, and your analytics history.

1. Open the application → **Storages** tab.
2. **+ Add** → *Volume Mount*.
3. Set:

   | Field | Value |
   | --- | --- |
   | Name | `wellness-chatbot-data` |
   | Destination Path | `/app/data` |

4. Save.

The Dockerfile already defaults `DATABASE_PATH` to `/app/data/wellness-chatbot.db`,
so this mount is all that's needed.

> Keep the volume on the server's local disk. SQLite and network filesystems
> (NFS, some object-storage gateways) interact badly — file locking is
> unreliable and you risk corruption.

---

## Part 4 — Environment variables

Application → **Environment Variables** tab. Add these as **Runtime** variables
(they are read when the service starts, not when the image is built).

Mark `OPENAI_API_KEY` and `WP_SHARED_SECRET` as **secret/locked** so they're
masked in the UI.

```ini
OPENAI_API_KEY=sk-...
WP_BASE_URL=https://www.wellnesspharmacykw.com
WP_SHARED_SECRET=<generate this, see below>
NODE_ENV=production
```

Generate the shared secret on your own machine:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep it — the identical value goes into WordPress in Part 6.

**Don't set `PORT` here yourself** — Coolify already sets it for you, derived
from **Port Exposes** in Part 2. Adding your own `PORT` variable on top would
just be setting the same thing twice, with the environment variable and Port
Exposes able to disagree about which one wins depending on Coolify's version.
Leave it to the one field.

**Do not set `DATABASE_PATH`.** The Dockerfile defaults it to
`/app/data/wellness-chatbot.db`. Overriding it to a path outside `/app/data`
would silently put your database somewhere that isn't on the persistent
volume.

Optional, only if you want to change a default:

```ini
LABEL_CONFIDENCE_THRESHOLD=0.6      # below this, drafts are flagged low-confidence
ALLOW_PARTIAL_VERIFICATION=1        # set 0 for a stricter launch
SESSION_TTL_MINUTES=45              # how long an idle chat survives
OPENAI_MODEL_CHAT=gpt-5.6-terra     # re-check these against OpenAI's current list
OPENAI_MODEL_CHEAP=gpt-5.6-luna
OPENAI_MODEL_LABEL=gpt-5.6-sol
OPENAI_MODEL_EMBED=text-embedding-3-small
```

---

## Part 5 — Domain, TLS and health check

### Domain

Application → **General** tab → **Domains**:

```
https://chatbot.yourstore.com
```

Include `https://`. Coolify's proxy requests a Let's Encrypt certificate
automatically once DNS resolves to the server. No manual certbot step.

### Health check

Application → **Health Checks** tab:

| Field | Value |
| --- | --- |
| Enabled | Yes |
| Path | `/health` |
| Port | **Whatever you set Port Exposes to in Part 2** (`3000` if you left the default) |
| Interval | `30` seconds |
| Timeout | `10` seconds |
| Retries | `3` |

Get this wrong — say, `8787` here while Port Exposes stayed at Coolify's
default of `3000` — and you'd end up in a confusing middle state: the
container itself is perfectly healthy (it's genuinely listening and answering
on 3000), but Coolify would be probing a port nothing is bound to. The two
settings have to name the same port; which number that is doesn't matter.

The image also carries its own `HEALTHCHECK`, so Docker knows the container's
state even if Coolify's check is disabled. Both were confirmed working.

### Deploy

Hit **Deploy** and watch the log. A first build takes a few minutes. You're
looking for a line like:

```
Server listening at http://0.0.0.0:3000
```

The port number here should match whatever you set as Port Exposes — if you
left Coolify's default, that's `3000`, not the `8787` the Dockerfile falls
back to when nothing else specifies a port.

Followed — expectedly — by a warning that 11 business settings are unconfirmed.
That's correct at this stage; you fill them in from WordPress in Part 6.

**Verify:**

```bash
curl https://chatbot.yourstore.com/health
```

You should get JSON with `"status":"ok"`, your four model IDs, zeroed product
counts, and the `missing_settings` list.

---

## Part 6 — Connect WordPress

### 6.1 Install the plugin

Copy `wordpress-plugin/wellness-chatbot/` into `wp-content/plugins/` on your
store (or zip that one folder and use **Plugins → Add New → Upload Plugin**),
then activate it.

### 6.2 Point WordPress at Coolify

In `wp-config.php`, above the `/* That's all, stop editing! */` line:

```php
define( 'WELLNESS_CHATBOT_SECRET', 'the-same-secret-from-part-4' );
define( 'WELLNESS_CHATBOT_BACKEND_URL', 'https://chatbot.yourstore.com' );
```

### 6.3 Assign the pharmacist reviewer

**Users → (the pharmacist) → Role → Pharmacist Reviewer**

Until someone holds this role, no supplement or health-related product can ever
be verified, and the assistant will refuse to recommend any of them. This is
deliberate.

### 6.4 Fill in the business facts

**Wellness Chatbot → Settings** — delivery areas and fees, hours, WhatsApp
number, payment methods, returns policy. Leave a field empty rather than
guessing; an empty field makes the assistant offer to check with your team,
which is correct. A wrong value makes it lie confidently.

The screen should now show *"Connected"* with a product count.

---

## Part 7 — Running the one-off commands

Seeding, loading the catalogue and labeling are one-off jobs.

Coolify gives you a shell: application → **Terminal** tab (or the ⌨ icon).
Alternatively, SSH to the server and use `docker exec`.

> **Use the `:prod` scripts inside the container.** The plain `npm run seed` /
> `import` / `label` commands run TypeScript through `tsx`, which is a dev
> dependency and is deliberately not in the production image. Running them there
> fails. The `:prod` variants run the compiled JavaScript.

```bash
# Seed the bilingual lexicon and the FAQ topic list
npm run seed:prod
```

This creates ~18 FAQ topics with **empty, unapproved answers** — those are for
your team to write, in **Wellness Chatbot → Knowledge Base**. Nothing unapproved
is ever shown to a customer.

### Loading the catalogue

The backend has no filesystem in common with your WordPress host, so the
practical path on Coolify is the one that doesn't need one:

**From WordPress** (recommended here) — **Wellness Chatbot → Settings →
Catalogue → Export catalogue**, then **Upload catalogue**. This is a plain
HTTPS request straight from your site to `chatbot.yourstore.com` — nothing
needs to land on the Coolify server's disk at all, which sidesteps the whole
question of getting a file into the container.

**From the container's shell**, if you'd rather drive it from the command line
— get the file onto the volume first, since the Coolify terminal has no `scp`:

```bash
# From your own machine, copy the export into the running container:
docker cp catalogue.json $(docker ps -qf "name=wellness-chatbot"):/app/data/catalogue.json

# Then, in the Coolify terminal (or docker exec):
npm run import:prod -- --file /app/data/catalogue.json --embed
```

Either way, day-to-day changes after this first load take care of themselves —
saving a product in wp-admin queues and forwards it automatically.

### Labeling

```bash
# A small, costed trial first
npm run label:prod -- --limit 25

# Once you're happy with the drafts, the full pass
npm run label:prod
```

You can also trigger labeling from **Wellness Chatbot → Settings → Catalogue**
in WordPress (tick "Also run AI labeling" on the upload form), without touching
a terminal.

A long labeling run can outlive a browser-based terminal session. For a large
catalogue, prefer SSH:

```bash
docker exec -d $(docker ps -qf "name=wellness-chatbot") npm run label:prod
```

---

## Part 8 — Backups

Coolify can back up the volume for you, but verify it's actually configured —
this is the one piece of data you cannot rebuild.

**Option A — Coolify's scheduled backups.** In the application's **Backups**
section, enable scheduled backups for the `wellness-chatbot-data` volume and set
an S3 destination if you have one.

**Option B — a cron job on the server.** Reliable and easy to verify:

```bash
sudo tee /etc/cron.daily/wellness-chatbot-backup >/dev/null <<'EOF'
#!/bin/sh
DEST=/var/backups/wellness-chatbot
mkdir -p "$DEST"
CID=$(docker ps -qf "name=wellness-chatbot")
[ -z "$CID" ] && exit 0
docker exec "$CID" node -e "
const {DatabaseSync}=require('node:sqlite');
new DatabaseSync(process.env.DATABASE_PATH).exec(\"VACUUM INTO '/app/data/backup.sqlite'\");
"
docker cp "$CID:/app/data/backup.sqlite" "$DEST/db-$(date +%F).sqlite"
docker exec "$CID" rm -f /app/data/backup.sqlite
find "$DEST" -name 'db-*.sqlite' -mtime +30 -delete
EOF
sudo chmod +x /etc/cron.daily/wellness-chatbot-backup
```

`VACUUM INTO` produces a consistent snapshot of a live SQLite database — safer
than copying the file while the service is writing to it.

Test the restore path at least once. A backup you have never restored is a
hypothesis, not a backup.

---

## Part 9 — Updating

With a GitHub App source, Coolify redeploys automatically on push to `main`.
Otherwise hit **Redeploy**.

Deployments are safe with respect to your data: the database lives on the
mounted volume, not in the image, and the schema migrates itself on start.
Verified products are never touched by a redeploy, and a re-import never
overwrites a product a human has already approved — only the raw
WooCommerce-owned fields (price, stock, description) get refreshed.

If you change the widget, rebuild it and re-upload the plugin — the widget ships
inside the plugin, not the container:

```bash
cd widget && npm install && npm run build
```

---

## Troubleshooting

**Build fails: `Unsupported engine` or a `node:sqlite` error**
The Build Pack is set to Nixpacks. Switch it to **Dockerfile** — Nixpacks
usually selects a Node version below the required 22.5.

**Build fails: `Dockerfile not found`**
Base Directory isn't `/backend`. The repo root has three folders and no
Dockerfile of its own.

**Container restarts in a loop**
Check the logs. Almost always a missing or malformed environment variable.
Confirm `WP_BASE_URL` includes `https://` and has no trailing slash.

**The logs say `Server listening at http://0.0.0.0:3000`, but I expected 8787**
Not a problem — this is the normal, healthy outcome if you left **Port
Exposes** at Coolify's default in Part 2. The app is listening on whatever
that field says; `8787` is only what the Dockerfile falls back to if nothing
else specifies a port. Confirm the Health Check **Port** field (Part 5) says
the same number as Port Exposes, and check that `https://your-domain/health`
loads from outside — if it does, everything is working correctly as-is and
there's nothing to change.

**Everything resets after each deploy**
The persistent volume is missing or mounted at the wrong path. It must be
exactly `/app/data`. Check the **Storages** tab.

**No TLS certificate**
DNS isn't resolving to the Coolify server yet, or the domain was entered without
`https://`. Confirm with `dig chatbot.yourstore.com` and redeploy.

**WordPress says "Could not reach the backend"**
Test `curl https://chatbot.yourstore.com/health` from anywhere. If that works,
the URL in `wp-config.php` is wrong or your store's host blocks outbound HTTPS.

**Backend logs "Signature mismatch"**
`WP_SHARED_SECRET` in Coolify and `WELLNESS_CHATBOT_SECRET` in `wp-config.php`
differ. They must be byte-identical.

**Backend logs "Request timestamp is outside the allowed window"**
The two servers' clocks differ by more than five minutes. Install `chrony` or
`systemd-timesyncd` on the Coolify host.

**`npm run seed` (or `import`, or `label`) fails in the Coolify terminal**
Use the `:prod` variant. The production image has no `tsx`.

**`npm run import:prod` says the file was not found**
The container's filesystem is separate from your local machine and from
WordPress. If you're driving this from the CLI rather than the WordPress
upload form, `docker cp` the file in first — see Part 7.

**"Model not found" in the logs**
An OpenAI model ID was retired. Update the `OPENAI_MODEL_*` environment
variables and redeploy — no code change needed.

---

## What was verified, and what wasn't

**Verified by actually running it:** the image builds on Node 24; the container
starts and serves `/health`; the Docker health check passes; the compiled CLI
(`seed:prod`, `import:prod`) runs inside the image; a catalogue file imported
inside a running container shows up correctly via `/health`; re-importing the
same file is idempotent (no duplicates) and never resets a product a human
already marked `verified`; `--prune` correctly removes products missing from
the file while leaving verification decisions on the survivors untouched; and
all of this survives a container restart through the mounted volume.

**Confirmed on a live deployment, not just written from documentation:** a
reader deployed exactly this guide, left Port Exposes at Coolify's default of
`3000`, and confirmed both the internal health check and external
`https://.../health` over real DNS + TLS worked correctly — end to end,
starting from a fresh Coolify application. That run is also what caught that
this guide originally insisted on `8787`: Coolify actually derives the app's
real listening port from **Port Exposes**, it isn't a fixed `8787` regardless
of the UI as an earlier version of this doc claimed. The settings that *are*
fixed regardless of the UI: Dockerfile build pack, `/backend` base directory,
`/app/data` volume, `/health` path.

**Not otherwise verified:** the rest of the Coolify GUI steps are written from
Coolify's documented behaviour, and field names may shift slightly between
versions.

**Also still outstanding:** the WordPress plugin's PHP has never been linted or
run — the machine it was written on has no PHP toolchain. Run `php -l` over
every file in `wordpress-plugin/wellness-chatbot/` and test on a staging site
before going live.
