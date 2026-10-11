# Development roadmap

Updated: 2026-10-10. Current stage: **local hardening, before any Cloudflare deployment**.

## Product scope / frozen choices

- Single Cloudflare Workers Cron Trigger (`* * * * *`); per-monitor positive **integer minute intervals** configured **only** in `config/intervals.json`.
- Independent source monitor definitions in `src/config.ts`; source-specific Discord webhook Secrets; D1 as durable notification outbox and scan checkpoint.
- Five source adapters: arXiv, Qiita, Zenn, YouTube RSS, Wikipedia new-page events.
- No GUI, long-running server, user authentication, public HTTP API, or paid infrastructure dependency for the initial version.
- Deployment remains disabled and example monitors remain disabled until verified setup.

## Stage A — complete local correctness and resource hygiene (current)

1. Eliminate needless per-minute D1 writes and re-inserts of old/known articles. **Implemented; local regression-tested, Cloudflare CPU not yet measured.**
2. Ensure a source outage does not starve already queued Discord notifications.
3. Add fixture-based regression tests for feed order, malformed XML/JSON, overlap boundary, duplicate events and partial failures. **Partial: D1 bound-parameter regression and XML truncation guards added; full feed/XML conformance and real API fixtures remain open.**
4. Examine unsafe scan-stop conditions and the catch-up lag on active Qiita searches; treat a page limit as **incomplete**, not a successful exhaustive scan. **Qiita creation-date lower-bound added; 100-page cap and result reordering remain risks.**
5. Verify that a change in a monitor's query/identity cannot silently carry over an unrelated seen-state baseline. **Implemented via fail-closed semantic ID pinning; Cloudflare staging not yet run.**
6. Verify config/secret validation and prevent unintended pings, SSRF and arbitrary domain fetches.

**Gate:** GitHub Actions CI passes; all five source adapters have realistic parser fixtures and failure cases; no known unhandled duplicate/loss scenarios within stated coverage guarantees.

## Stage B — constrained Cloudflare staging deployment

**Requires owner action:** grant Cloudflare integration or configure Workers Builds; create D1, apply migrations `0001`–`0004`, set actual webhook Secrets **in Cloudflare only**, select safe test monitors. Do not paste any Webhook URL into GitHub or chat.

1. Deploy with all monitors disabled and check the single Cron Trigger exists; HTTP handler stays 404.
2. Enable only one low-traffic test monitor, verify silent initial baseline, subsequent delivery and duplicate suppression.
3. Verify D1 checkpoint replay across runs, notification retry after 429/5xx, lease expiry and recovery.
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
- Bound long-term D1 outbox growth while retaining sufficient deduplication/history for the monitored sources.
- Add an actionable failure or stale-scan alert channel if operational evidence shows one is needed.
- Keep source APIs and Cloudflare limits current.

## Implementation rules

- All source changes through feature branches and PRs; merge only after CI success. No direct pushes to `main`.
- Reuse existing adapters and tests; no speculative rewrites, premature Wasm, large dependency stacks or extra Cloudflare Cron Triggers.
- No claimed CPU/RSS/D1 performance improvement without quantified observations. Local SQL-statement reductions are valid only as **statement counts**, not cloud CPU measurements.
- Update this roadmap only when milestone status or verified constraints change.

## Current risks and known limitations

- D1 SQL bind parameters cap at 100 per statement; notification inserts now use at most 84 binds per query (12 rows × 7 fields).

- **Workers Free CPU time is 10 ms/invocation** (Cloudflare's actual measurement is required).
- A Cron tick processes **one monitor and at most one paginated API page**, so many concurrently due monitors can run late.
- The first observation is intentionally a silent time-based baseline.
- arXiv/Wikipedia use a bounded overlap rather than mathematically exhaustive detection. Qiita search sorting is not assumed chronological; it may take up to 100 scheduled page checks. Zenn/YouTube RSS cannot page backwards once entries fall out of their feed.
- Discord delivery followed by D1 acknowledgement cannot be atomic: failures between these steps can duplicate notification.
- Cloudflare staging/production has **not** been deployed.
