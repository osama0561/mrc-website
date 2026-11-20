# osama-crm

Sales CRM for نهر (nahr) and أتمتها (atmatha), running as a Cloudflare Worker + D1.
Live at: https://osama-crm.o-malshihre2023.workers.dev/

This repo is exported from the deployed source (the worker was deployed directly via
the Cloudflare API, not `wrangler deploy`, so this export is the source of truth going
forward — treat it as the real repo and deploy from it with `wrangler deploy` next time).

## What's here

- `worker/src/` — the Worker: API (`/api/*`), the 10-minute Google Sheets mirror cron,
  and static asset serving (the frontend is embedded into `static-files.js` and served
  directly — no ASSETS binding).
- `worker/migrations/0001_users_and_ownership.sql` — already applied to production.
- `worker/wrangler.jsonc` — config for `wrangler deploy` / `wrangler dev` going forward.
- `public/` — the frontend source as authored (vanilla JS/CSS, no build step). This is
  what `static-files.js` embeds; if you edit the frontend, edit here and regenerate
  `static-files.js`, or edit `static-files.js` directly and keep `public/` in sync.

## Accounts

Real per-person accounts (username + password), not a shared password:

- **manager** role: full access — all leads/deals across both businesses, team
  management (`/api/users`), settings, Kit/Publer source snapshots.
- **rep** role: only ever sees and edits deals the manager has assigned to them
  (`owner_user_id`), enforced server-side in `worker.js`, not just hidden in the UI.

The one-time `/api/setup` endpoint (keyed on the legacy `CRM_PASSWORD` secret) created
the first manager account and is now permanently locked (`already_set_up`). From here,
the manager adds/deactivates/resets reps from the Team screen in the app.

## Deploying changes

```
cd worker
wrangler deploy
```

Secrets (`CRM_PASSWORD`, `SESSION_SECRET`, optionally `KIT_API_KEY`/`PUBLER_API_KEY`) are
already set on the live Worker; `wrangler secret put <NAME>` to change one.
