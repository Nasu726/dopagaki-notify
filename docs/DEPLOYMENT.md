# Cloudflare staging deployment runbook

Status: **ready for owner-assisted staging, not yet deployed** (2026-10-11).

This Worker has no public UI, no HTTP API, and only one Cron Trigger (`* * * * *`).
It uses D1 for checkpoints and outbox, and an independent Discord Webhook Secret for
each **source**. All example monitors remain disabled until explicitly enabled.

## Step 0 — prerequisites and safety

- Ensure the Cloudflare account has a Workers Free plan and room for one
  account-wide Cron Trigger. No owned domain is necessary.
- Keep this repository's `src/config.ts` example monitors **disabled** throughout
  the initial deployment. The deployed scheduled handler should do no work
  while every monitor is disabled.
- Never paste Discord Webhook URLs, API tokens or Cloudflare credentials into
  GitHub commits, issues, CI logs, or ChatGPT.
- Before setting up Workers Builds, verify that `main` is the intended deployment
  branch and that D1 binding configuration points to the **staging** database.
- There is currently no automated release rollback/migration rollback procedure.
  D1 migrations should be applied consciously; changes to source identities
  require a new monitor ID instead of reusing an existing one.

## Step 1 — clone and authenticate

From a terminal with Node.js 22+:

```sh
git clone https://github.com/Nasu726/dopagaki-notify.git
cd dopagaki-notify
npm install
npm run check
npm run bundle:check
npx wrangler login
```

The final login opens Cloudflare OAuth in the browser.

## Step 2 — create and bind D1

```sh
npx wrangler d1 create dopagaki-notify
```

Copy the returned D1 `database_id` into the existing `DB` binding in
`wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
Do not add a second database binding for the same database. This ID is not a
credential; the Cloudflare account login controls access.

Apply every schema migration in order against the *remote* D1 instance:

```sh
npx wrangler d1 migrations list dopagaki-notify --remote
npx wrangler d1 migrations apply dopagaki-notify --remote
```

The migration set currently runs from `0001_init.sql` through
`0008_source_webhook_state.sql`. Verify successful completion. Do **not**
substitute `--local` for `--remote` when preparing the deployed Worker.

## Step 3 — deploy with monitors disabled

Option A (initial manual staging deploy):

```sh
npx wrangler deploy
```

Option B (preferred steady-state): connect the GitHub repository to Cloudflare
Workers Builds and enable automatic deployment from `main` **after** the
D1 ID has been committed and the initial configuration has been checked.
Use Wrangler to deploy rather than GitHub Actions cron. Build settings
may vary in the Cloudflare dashboard.

**Do not enable a monitor before its matching Discord Secret exists.**
Confirm the Worker is created and the one Cron Trigger is registered.
Cron Trigger changes may take up to 15 minutes to propagate. The Worker
intentionally returns HTTP 404 and does not require `workers.dev` or a domain.

## Step 4 — create one Webhook per Discord destination channel

A single Discord server is sufficient:

- A channel for Qiita → secret `DISCORD_WEBHOOK_QIITA`
- A channel for Wikipedia → secret `DISCORD_WEBHOOK_WIKIPEDIA`
- A channel for arXiv → secret `DISCORD_WEBHOOK_ARXIV`
- A channel for Zenn → secret `DISCORD_WEBHOOK_ZENN`
- A channel for YouTube → secret `DISCORD_WEBHOOK_YOUTUBE`

Create the incoming Webhook inside each destination channel and save its URL
**directly as a Cloudflare Worker Secret**. Example, using the interactive CLI
prompt rather than putting the URL in a command:

```sh
npx wrangler secret put DISCORD_WEBHOOK_QIITA
```

Repeat for each source you intend to enable. Distinct sources must use
different URLs, because source-level Discord 429 cooldown and disabled-webhook
state are intentionally shared across monitor IDs of the same source.
Do not store these URLs in D1 or `.dev.vars` in a public repository.

## Step 5 — one-monitor smoke test

1. Choose one low-volume source/monitor for staging, with its Webhook Secret
   configured. Keep the other monitors disabled.
2. In `src/config.ts`, enable only that monitor. In `config/intervals.json`,
   set an integer monitoring interval in minutes. Never place intervals in
   `src/config.ts`.
3. Deploy this change. On its first successful scan the Worker records a
   **silent baseline**; old articles should not generate Discord alerts.
4. Confirm a genuinely newly published matching item is detected, queued,
   sent to the right Discord channel, and marked `sent` in D1.
5. Verify the scan cursor survives scheduled invocations, retries preserve
   existing messages, and a subsequent repeat scan does not duplicate the
   same article ID.
6. Inspect Cloudflare invocation CPU time (not wall-clock time), subrequests,
   errors and D1 row operations. Capture both quiet ticks and due scans.
   Workers Free CPU **10 ms** is a *runtime gate*, not yet a verified result.
7. Enable remaining monitors one by one, only after the preceding smoke test
   passes. Watch `incomplete_count` / `last_incomplete_at` for capped feeds.

The Cron schedule is once per minute, but each monitor's effective interval
is **best effort** and can be delayed by pagination or an overdue backlog.
An API 429 schedules a later retry without sleeping.

## Recovery / stop procedure

- To stop sending alerts immediately, set all monitors `enabled: false`
  and redeploy. Do not delete D1 or notifications to suspend the Worker.
- For a deleted/unauthorized Discord Webhook, replace its Secret and then,
  **only after replacement**, clear the relevant source block via authenticated
  D1 console or `wrangler d1 execute --remote`:

```sql
UPDATE webhook_source_state
SET blocked_status = NULL, blocked_at = NULL
WHERE source = 'qiita';
```

- Verify the renewed sends and pending backlog. A successful Discord POST
  followed by a failed D1 acknowledgement can still cause a duplicate alert.
- Do not erase `monitor_state` or `deliveries` merely to clear a webhook
  error. They contain the deduplication history and pending notifications.

## Handoff gate

Owner action needed before live verification: Cloudflare account connection
(or a manually prepared Worker with D1 binding), Webhook Secrets for the test
source, and authorization to enable one test monitor.

Developer verification before declaring production ready: source-format smoke
test against real API responses, D1 migrations on remote D1, at least 100
representative scheduled invocations with CPU and D1 metrics, live Discord
delivery/retry, and inspection of incomplete-coverage warnings.

Cloudflare documentation:
- https://developers.cloudflare.com/d1/wrangler-commands/
- https://developers.cloudflare.com/workers/wrangler/commands/d1/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/platform/limits/
