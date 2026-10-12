# Development roadmap

Updated: 2026-10-12. Current stage: **Cloudflare two-source staging (Qiita + Wikipedia), after a successful Qiita outbound Discord smoke test**.

## Product scope / frozen choices

- Cloudflare Workers Cron every five minutes for monitors, separate hourly Cron for bounded retention; per-monitor positive **integer minute intervals** configured **only** in `config/intervals.json`.
- Independent source monitor definitions in `src/config.ts`; public arXiv category and YouTube channel targets in `config/targets.json`; source-specific Discord webhook Secrets; D1 as durable notification outbox and scan checkpoint.
- Five source adapters: arXiv, Qiita, Zenn, YouTube RSS, Wikipedia new-page events.
- No GUI, long-running server, user authentication, public HTTP API, or paid infrastructure dependency for the initial version.
- Remote D1 migrations `0001`–`0009` and source Secrets have been configured according to the owner; no new migration is required to adjust the maintenance schedule. Qiita outbound webhook delivery was verified with an idempotent D1 smoke record. Only Qiita and Wikipedia are enabled.

## Stage A — complete local correctness and resource hygiene (current)

1. Eliminate needless per-minute D1 writes and re-inserts of old/known articles. **Implemented; local regression-tested, Cloudflare CPU not yet measured.**
2. Ensure a source outage does not starve already queued Discord notifications.
3. Add fixture-based regression tests for feed order, malformed XML/JSON, overlap boundary, duplicate events and partial failures. **Partial: D1 bind-parameter regression, XML truncation guards, and CDATA/comment boundary regressions added; full feed/XML conformance and real API fixtures remain open.**
4. Examine unsafe scan-stop conditions and the catch-up lag on active Qiita searches; treat a page limit as **incomplete**, not a successful exhaustive scan. **Qiita creation-date lower-bound added. Exhausted page limits are now persisted as incomplete scans, with full-scan watermarks preserved. 100-page cap and result reordering remain risks. **Added one final head-page recheck after multi-page scans to reduce offset-pagination drift.****
5. Verify that a change in a monitor's query/identity cannot silently carry over an unrelated seen-state baseline. **Implemented via fail-closed semantic ID pinning; Cloudflare staging not yet run.**
6. Verify config/secret validation and prevent unintended pings, SSRF and arbitrary domain fetches.

**Gate:** GitHub Actions CI passes (typecheck, Node tests, and a Wrangler dry-run bundle); all five source adapters have realistic parser fixtures and failure cases; no known unhandled duplicate/loss scenarios within stated coverage guarantees.

## Stage B — constrained Cloudflare staging deployment

**Preparation:** Staging runbook is in [DEPLOYMENT.md](DEPLOYMENT.md); source adapters and Wrangler bundle have passed CI, but real API/CPU measurements remain unverified.

**Owner reports complete:** Cloudflare Worker deployment, remote D1 migrations `0001`–`0008`, and five source-specific Secrets. **Current gate:** Verify the Wikipedia first-run silent baseline following Wikimedia-compliant User-Agent changes (prior Cloudflare logs showed MediaWiki HTTP 403); investigate observed occasional CPU p99 around 19 ms (10 ms Workers Free budget). Qiita Discord delivery was verified using a synthetic queued test item, but genuine upstream-new-item detection and delivery remain unverified. Never paste Webhook URLs into GitHub or chat.

1. Initial deployment was performed with all monitors disabled; next verify the Cron Trigger and that the HTTP handler stays 404.
2. Enable only one low-traffic test monitor, verify silent initial baseline, subsequent delivery and duplicate suppression.
3. Verify D1 checkpoint replay across runs, notification retry after 429/5xx, lease expiry and recovery. **Retry-After and persistent monitor-level Discord cooldown implemented and unit-tested; live 429s not yet observed.**
4. Capture **Cloudflare's actual invocation CPU time** (not wall time), D1 rows read/written, Worker errors and outgoing request count. Distinguish normal empty/no-due ticks from busiest page+Discord ticks.
5. Collect representative samples (at least 100 invocations across due and idle cases) and inspect p50, p95, maxima, and whether any invocation is terminated by the **10 ms Free CPU budget**.
6. Keep real-time Cloudflare logs free of Webhook URLs and unnecessary article content.

**Gate:** no CPU-limit terminations in representative load, no lost notifications under tested retry/restart conditions, no surprise D1/query quota usage. If the gate fails, profile and reduce per-tick work or adjust the design before regular use.

## Stage C — progressive production use

- Enable configured sources one by one; verify exact channel routing, source-specific intervals, healthy scheduler lag and cloud observability.
- Review catch-up completeness limitations: 48-hour overlap for timestamp-ordered APIs, Qiita 100-page cap, fixed-size RSS windows, pagination drift.
- Prefer explicit diagnostic failure to a silent claim that coverage was complete.
- Verify D1 backups/migrations and an operational procedure for webhook rotation.

**Gate:** multi-day stable production operation with expected Discord channels, bounded D1 use, and no unexpected noisy notifications.

## Stage D — measure-driven optimization and maintenance

- Only after Stage B measurements: consider eliminating remaining idle-tick SQL, streaming/partial RSS parsing, reducing Qiita payload CPU, and changing page sizes. Compare before/after CPU p50/p95, rows read/written, request counts and missed/delayed items.
- **Implemented for staging**: separate hourly Cron prunes up to 20 `sent` deliveries per invocation once ten days old. Publication-time eligibility is bounded to the same ten-day horizon to avoid resurrection after deletion. Pending retries and scan state remain durable; validate D1 quota/CPU and retention throughput in Cloudflare.
- Add an actionable failure or stale-scan alert channel if operational evidence shows one is needed.
- Keep source APIs and Cloudflare limits current.

## Implementation rules

- All source changes through feature branches and PRs; merge only after CI success. No direct pushes to `main`.
- Reuse existing adapters and tests; no speculative rewrites, premature Wasm, large dependency stacks or extra Cloudflare Cron Triggers.
- No claimed CPU/RSS/D1 performance improvement without quantified observations. Local SQL-statement reductions are valid only as **statement counts**, not cloud CPU measurements.
- A second maintenance Cron was deliberately introduced to keep deletion CPU outside ordinary fetch/delivery invocations; it must be monitored separately.
- Update this roadmap only when milestone status or verified constraints change.

## Current risks and known limitations

- v0.8 shared-source webhook migration: atomic pending-delivery claims now consult `webhook_source_state`, not the obsolete monitor-level cooldown/block fields. This also preserves delivery after an explicit source-level recovery. Regression-tested locally; Cloudflare D1 deployment is not yet verified.

- D1 SQL bind parameters cap at 100 per statement; notification inserts use at most 84 binds per query (12 rows × 7 fields), and due-monitor selection is chunked at 40 monitors (83 binds).

- **Workers Free CPU time is 10 ms/invocation** (Cloudflare's actual measurement is required).
- A Cron tick processes **one monitor and at most one paginated API page**, so many concurrently due monitors can run late.
- The first observation is intentionally a silent time-based baseline.
- arXiv/Wikipedia use a bounded overlap rather than mathematically exhaustive detection. Qiita search sorting is not assumed chronological; it may take up to 100 scheduled page checks. Zenn/YouTube RSS cannot page backwards once entries fall out of their feed.
- Discord delivery followed by D1 acknowledgement cannot be atomic: failures between these steps can duplicate notification.
- Cloudflare staging is deployed by the owner. Production readiness remains unverified because live upstream item detection for each source and worst-case CPU resource use have not yet passed.

## New staging conditions (2026-10-12)

- Wikipedia's real D1 row was observed with `initialized_at = NULL`, `last_complete_at = NULL`, and a nonzero future `next_due_at`: the initial MediaWiki fetch has **not yet completed**. Inspect the actual Worker error logs and Retry-After status before calling this source healthy; do not infer the specific root cause from that one row.
- **JST notification window**: 09:00 inclusive, 20:00 exclusive. Source polling and outbox insertion continue overnight. Pending-only wakeups are suppressed until morning.
- **Retention**: separate `10 * * * *` maintenance Cron (hourly, minute 10), 20 expired `sent` receipts maximum per invocation, ten-day cutoff and partial `sent_at` index. Pending rows are never pruned automatically. This is not yet measured against Workers Free CPU limits.
- **Editable target lists**: `config/targets.json` contains arXiv category sets and YouTube channel references (empty placeholder). Changing the query of an initialized monitor requires a new ID to preserve the fail-closed semantic history invariant.

### Maintenance schedule adjustment (2026-10-12)

- Previous `*/5 * * * *` = 288 maintenance invocations/day, regardless of pending cleanup; changed to `10 * * * *` = 24/day, minute 10 (UTC and JST share the same minutes). One indexed `DELETE` still removes at most 20 expired `sent` receipts per invocation; up to 480/day.
- The per-invocation Workers Free CPU limit (10 ms) is **not** an unlimited daily invocation allowance: the account also has an aggregate Workers Free allowance of 100,000 requests/day, plus D1 row read/write quotas. The old cadence was unnecessary resource usage even though both cadences are well below the account's request quota.
- A once-daily Cron with an unchanged 20-row cap would only remove 20 expired deliveries per day and could accumulate history if >20 notifications/day are sent. Hourly is a conservative bounded compromise; reduce further only after verifying delivery volume and maintenance CPU.
- No schema or retention-window change. Cloudflare's updated triggers may take several minutes to propagate; verify both Cron entries after deployment.

### MediaWiki 403 and dispatcher resource adjustment (2026-10-12)

- The owner's Worker logs confirmed `MediaWiki HTTP 403`, corresponding to `wikipedia-ja` having a NULL baseline. The adapter previously omitted User-Agent. Following Wikimedia's bot identification policy, both `User-Agent` and `Api-User-Agent` now identify `dopagaki-notify/0.1` and its public GitHub contact. This is a **hypothesis-based fix** until confirmed live. Persistent 403s are spaced at least one hour apart.
- The monitor dispatcher Cron is reduced from `* * * * *` (1,440 runs/day) to `*/5 * * * *` (288 runs/day), separate from the existing `10 * * * *` hourly retention Cron. Source polling intervals remain 60m Qiita/Wikipedia, 120m default arXiv, 60m Zenn, and dormant 10,080m/7d YouTube; all are individually editable in `config/intervals.json`. Multiple overdue sources, pagination checkpoints and pending Discord deliveries motivate retaining sub-hour scheduler granularity.
- Keep at most one fetched API page and three Discord sends per invocation; **never drop excess valid events just to hit 10ms CPU**. Queue and resume them instead; unverified Free CPU p99 peaks near 19ms remain an operational measurement gate.
