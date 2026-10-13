# Cloudflare staging deployment runbook

**Configurable targets (2026-10-13):** Qiita searches and Zenn topic/user feeds now use lists in `config/targets.json`, just like arXiv/YouTube. All targets have distinct IDs, `enabled` flags and positive-minute intervals in `config/intervals.json`. The existing `qiita-rust`, `zenn-topic-typescript` and `arxiv-cs-ai` IDs/queries remain unchanged, protecting their existing D1 identities. A new `arxiv-cs-ds` monitor tracks `cs.DS` independently at 120 minutes. No D1 migration or new Discord Secret is needed beyond the existing arXiv secret. If the Worker lacks `DISCORD_WEBHOOK_ARXIV`, both arXiv monitors remain dormant. Do not enable broad new Qiita/Zenn topics before estimating notification volume and D1 row usage. See README configuration section for examples.

**Source activation update (2026-10-13):** arXiv and Zenn are enabled in code with the existing `cs.AI` and TypeScript topic targets, respectively, but are dormant until their individual Discord Webhook Secrets are present. Wikipedia now samples at most three new page creations every 120 minutes. See the README's notification policy for details.


Status: **live Cloudflare staging; Qiita D1 outbox → Discord → D1 ACK confirmed by owner; enabling Japanese Wikipedia as second source** (2026-10-12).

This Worker has no public UI or HTTP API. It has a five-minute monitoring Cron (`*/5 * * * *`) and a separate hourly bounded retention Cron (`10 * * * *`).
It uses D1 for checkpoints and outbox, and an independent Discord Webhook Secret for
each **source**. Qiita, Japanese Wikipedia, arXiv, Zenn and three selected YouTube channels are enabled in code. arXiv and Zenn remain dormant if their Discord Secrets are missing.

## Step 0 — prerequisites and safety

- Ensure the Cloudflare account has a Workers Free plan and room for one
  account-wide Cron Trigger. No owned domain is necessary.
- The initial deploy was performed with all monitors disabled. Qiita's synthetic
  notification successfully reached Discord and was recorded as sent in D1.
  This stage enables `wikipedia-ja` in addition to `qiita-rust`.
  YouTube is now enabled for the three explicitly authorized channels. Do not enable arXiv or Zenn before their respective checks are planned.
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
`0009_delivery_retention.sql` (0001–0008 were already applied by the owner; **0009 is new**). Verify successful completion. Do **not**
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
Confirm the Worker is created and the two Cron Triggers are registered.
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

The dispatcher Cron schedule is once every five minutes, but each monitor's effective interval
is **best effort** and can be delayed by pagination or an overdue backlog.
An API 429 schedules a later retry without sleeping.

## Live smoke-test observation (Qiita)

The monitor ID is `qiita-rust`, its search query is `tag:Rust`, and its
configured interval is **60 minutes**. On the first successful Cron fetch,
`initialized_at` is set and older articles are intentionally **not sent**.
A real article newly published *after that baseline* is needed to verify delivery.
Its arrival time is not predictable; the absence of a notification by itself is
not a failure.

After the Workers Builds deployment of this configuration succeeds, inspect
Cloudflare **Workers & Pages → dopagaki-notify → Observability → Logs**,
or tail the deployed Worker from an authenticated terminal:

```sh
npx wrangler tail dopagaki-notify --format pretty
```

Inspect the remote D1 state without modifying it:

```sh
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id, initialized_at, next_due_at, last_complete_at, scan_cursor, incomplete_count FROM monitor_state WHERE id = 'qiita-rust';"
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT item_id, status, attempts, sent_at FROM deliveries WHERE monitor_id = 'qiita-rust' ORDER BY discovered_at DESC LIMIT 10;"
```

For a newly initialized monitor, `initialized_at` should be non-null and
`deliveries` will normally be empty until a newly published matching article
is discovered. An API error may leave `initialized_at` null with the retry
deadline delayed. Never paste Discord Secret values or private logs into chat.

**CPU gate:** inspect actual CPU time and Workers errors for idle/due ticks;
a successful build is not proof of staying within Workers Free's CPU limit.

## Wikimedia HTTP 403 diagnosis and remediation (2026-10-12)

Cloudflare logs showed `HttpStatusError: MediaWiki HTTP 403`, and the
`wikipedia-ja` baseline remained NULL. Wikimedia requires descriptive
automated-client identification; the original adapter sent only an
`Accept` header. The updated adapter sends `User-Agent` and
`Api-User-Agent` as `dopagaki-notify/0.1` plus this repository's URL
as a contact. A continuing MediaWiki 403 is postponed for at least
**one hour** to avoid excessive requests; it still produces an
observable error rather than silently declaring a successful baseline.

After GitHub Workers Builds deploys the updated `main`, confirm
`wikipedia-ja` eventually sets `initialized_at`. If it remains NULL,
check the Cloudflare Logs/Tail again for a status and consult Wikimedia
bot access policy. Do **not** remove the identification header,
masquerade as a browser, or bypass an upstream denial.

The monitoring Cron is now `*/5 * * * *` (288 invocations/day),
with per-monitor API polling intervals still in `config/intervals.json`.
The hourly retention Cron stays `10 * * * *`. The three selected YouTube channels are configured in `config/targets.json` with Tuesday or Sunday JST weekday restrictions; each corresponding interval in `config/intervals.json` is 60 minutes. Shorter intervals may be
needed for channels posting over 15 videos between reads.

## Second-source smoke test (Japanese Wikipedia)

After deployment of the two-source staging configuration, check Wikipedia's
initial **silent baseline** without sending any historical Wikipedia articles.
The monitor is `wikipedia-ja`, query `ja`, interval **60 minutes**; its
source webhook Secret must be `DISCORD_WEBHOOK_WIKIPEDIA`.

```powershell
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id,initialized_at,last_complete_at,next_due_at,scan_cursor,incomplete_count FROM monitor_state WHERE id='wikipedia-ja';"
```

A row with non-null `initialized_at` and `last_complete_at` confirms that
the first-page silent baseline was recorded. Initial observation intentionally
does not paginate historical entries. Later scans can checkpoint continuation
cursors across multiple Cron ticks; watch Logs for API errors and capped scans.
Do **not** infer a successful live Discord send until a new article genuinely
arrives; the existing Qiita smoke SQL must not be reused for Wikipedia.
While checking, watch the Workers CPU time distribution, since occasional
p99 peaks near 19 ms were observed with Qiita alone.

## One-time Discord delivery probe (no new Worker code, no new migration)

For the first real Discord send, use the existing production outbox rather than
opening an HTTP endpoint or modifying the monitor's baseline. The standalone
SQL file is **not** in `migrations/` and is not run automatically by CI,
Workers Builds or `d1 migrations apply`. The owner runs it explicitly once.

Preconditions: the latest `main` is deployed, `qiita-rust` remains enabled,
its `monitor_state.initialized_at` is non-null, remote D1 migrations are
complete, and the Qiita channel Secret is configured. The file checks
the stored `config_identity` equals `["qiita","tag:Rust"]`.

From the repository root, using an authenticated Wrangler session:

```powershell
git pull
npx wrangler d1 execute dopagaki-notify --remote --file=ops/qiita-one-shot-smoke.sql
```

This inserts at most one artificial delivery with immutable ID
`smoke:qiita:discord-outbox:2026-10-12`, title beginning `[TEST]`, and a
GitHub project URL (not an actual Qiita article). It will be sent to the
source-specific **Qiita** Discord channel by the next eligible Cron invocation.
The operation **does not** change `initialized_at`, the scan cursor,
`next_due_at`, or any real Qiita item. The `deliveries` primary key and
`INSERT OR IGNORE` make repeated invocation idempotent.

Check remote D1:

```powershell
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT item_id,status,attempts,sent_at FROM deliveries WHERE monitor_id='qiita-rust' AND item_id='smoke:qiita:discord-outbox:2026-10-12';"
```

- No row: SQL inserted nothing, typically because the monitor is not yet
  initialized, was renamed, or has an unexpected source/query identity.
  Confirm prerequisites; do **not** remove the guard.
- `pending`: item is queued. Inspect the Cron logs if still pending after
  a scheduled invocation; retry deadlines or a source-wide webhook cooldown
  may postpone the send.
- `sent` with non-null `sent_at`: Discord HTTP accepted the POST and D1
  saved the acknowledgement. Check the Qiita Discord channel for the
  visible `[TEST]` embed as independent confirmation.

If delivery is blocked, check the source-wide state (read-only):

```powershell
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT source,cooldown_until,blocked_status,blocked_at FROM webhook_source_state WHERE source='qiita';"
```

No special cleanup of the test row is needed; retaining it prevents replay.
This tests the delivery path; it **does not** prove that a newly published
Qiita article can be discovered by the API adapter. That still needs a
separate live event.

## JST delivery window and bounded D1 retention

The owner has already applied migration `0009_delivery_retention.sql` to remote D1. No additional schema change is needed for the hourly Cron adjustment. Migration `0009` adds a partial index for efficient expired-sent lookups; it neither deletes old rows nor modifies monitor state. For a new deployment, apply all pending remote migrations from the latest `main`.

```powershell
git pull
npx wrangler d1 migrations apply dopagaki-notify --remote
npx wrangler d1 migrations list dopagaki-notify --remote
```

Expected: `0009_delivery_retention.sql` applied and no pending migrations. The separate maintenance Cron should appear in Cloudflare's trigger configuration as `10 * * * *`.
Each hourly maintenance invocation executes at most one indexed DELETE of **20 sent**
receipts older than **ten days** (up to 480/day) (`sent_at` criterion). All pending retries
survive. A fresh outbox item with an old publication date (over 10 days ago)
is no longer eligible, preventing re-alerts after receipts are pruned.

The polling Cron still runs overnight, but **Discord notifications are held
outside 09:00 inclusive through 20:00 exclusive JST**. They are automatically
sent starting with the next eligible 09:00 Cron. This is a send-start window,
not a guarantee of Discord receipt before 20:00:00.

The source choices are now in `config/targets.json`:
- `arxiv[].categories`: e.g. `["cs.AI", "cs.LG"]`, producing an OR-category API query.
- `youtube[].channel`: an actual `UC...` channel ID, `@handle` or channel URL.
- Every added target ID also needs a positive interval in `config/intervals.json`.
- Keep arXiv disabled until a target is selected and its staging baseline is authorized. YouTube's selected targets are enabled in `config/targets.json`.
- **Changing an initialized monitor's target requires a new monitor ID.**

### Wikipedia troubleshooting

The owner observed `wikipedia-ja` with null `initialized_at` and
`last_complete_at` and a future `next_due_at`. This means its initial API
fetch has not completed, and the future deadline suggests a retry postponement.
The exact cause is **unknown** until Cloudflare's exception log is checked.
Use:

```powershell
npx wrangler tail dopagaki-notify --format pretty
```

Review the next Wiki attempt. The error may report HTTP status, a timeout or
an API parsing issue. Do not replace the monitor ID or erase the state just
to make the baseline appear complete. No additional sources are enabled.

## Multiple YouTube channels and Wikipedia failure policy

The three owner-approved YouTube channels are **enabled**:

| Monitor ID | Channel | Check schedule (JST) |
| --- | --- | --- |
| `youtube-yurugengo` | `@yurugengo` | Tuesday each hour 00:00–23:00 |
| `youtube-yurucom` | `@yurucom` | Sunday each hour 00:00–23:00 |
| `youtube-3blue1brown-japan` | `@3Blue1BrownJapan` | Sunday each hour 00:00–23:00 |

All three use `intervalMinutes=60` in `config/intervals.json`
and `weekdayJst` in `config/targets.json`. Checks run **only on the
specified JST day**. Initial checks on that day silently establish baselines.
Subsequent checks use the top of each JST hour. Actual Cron timing can lag
by up to one dispatcher interval. When an API fetch fails near midnight, an
off-day retry is skipped until the next selected weekday. This choice favors
the explicit day restriction over retrying every five minutes all week.

Discord delivery is still restricted to **09:00–20:00 JST**. A video
discovered during an overnight Tuesday/Sunday scan remains queued and can
be delivered at 09:00, including on a different weekday if necessary.
Videos with updated titles/descriptions do not count as newly published
content. The feed contains only about 15 recent videos; checking only
one day per week may miss uploads that fall out of the feed in between.

Verify after deployment:
```powershell
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id,initialized_at,last_complete_at,next_due_at FROM monitor_state WHERE id LIKE 'youtube-%' ORDER BY id;"
```

A Sunday monitor's `initialized_at = NULL` before Sunday is expected;
the first successful on-day fetch sets it. Real YouTube `@handle`
resolution and RSS compatibility in Workers are **not yet live-verified**.
All active YouTube monitors share `DISCORD_WEBHOOK_YOUTUBE`, while
maintaining independent polling deadlines and delivery histories.
No additional D1 migration is needed.

The most recent Wikipedia D1 check still showed
`initialized_at = NULL`. If MediaWiki 403 **recurs after the
identifying User-Agent release**, disable `wikipedia-ja` in
`src/config.ts` (the user explicitly permits stopping this
nonessential source). No D1 deletion is needed; do not bypass the denial.

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
