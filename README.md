# dopagaki-notify

**Staging smoke test — not production ready.** Cloudflare Workers + D1 sends alerts to Discord **only for newly published content**. No resident application, public GUI, or GitHub Actions cron. The code lives in GitHub; Cloudflare runs a monitoring Cron and a separate bounded retention Cron.

See [PROJECT_BRIEF.md](PROJECT_BRIEF.md) for the Japanese product specification and deployment boundaries, and [docs/ROADMAP.md](docs/ROADMAP.md) for the engineering plan and validation gates.

For the owner-assisted Cloudflare setup, see **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. This is a staging runbook, not an assertion of production readiness.

## Quick setup

Requires Node.js 22+; the project is written in TypeScript.

```sh
npm install
npm run check
npm run bundle:check # Wrangler compiles without deploying
```

**Set monitoring intervals only in [config/intervals.json](config/intervals.json).** Each value is a **positive integer number of minutes**; add an entry for every monitor ID:

```json
{
  "qiita-rust": 7,
  "wikipedia-ja": 60,
  "arxiv-cs-ai": 120,
  "zenn-topic-typescript": 60,
  "youtube-example": 60
}
```

The file intentionally holds **interval values only**. arXiv categories and YouTube channels are editable in **[config/targets.json](config/targets.json)**; the enabled flags remain in [src/config.ts](src/config.ts). **Staging:** Qiita's synthetic one-off D1 → Discord → D1 test notification was delivered and acknowledged (`status=sent`, `attempts=0`). `qiita-rust` and `wikipedia-ja` are enabled at **60-minute** intervals; the Cron runs every minute and processes one monitor at a time. The Wikipedia first observation establishes a **silent baseline**. arXiv, Zenn and YouTube remain disabled pending subsequent live validation.

The monitoring Cron Trigger in `wrangler.jsonc` runs every minute (`* * * * *`), irrespective of these settings. A **second independent Cron** (`10 * * * *`, every hour at minute 10 UTC/JST) deletes at most 20 acknowledged messages per invocation (24 invocations/day; up to 480 sent receipts/day). The previous five-minute cadence was unnecessary overhead. Each successful check schedules the next due time in D1 at *completion/check time + interval minutes*. Missed/delayed Cron runs may cause monitoring to run late. **The current starter handles only one due monitor per tick**; several short-interval monitors can also cause delays. It does **not** guarantee an exact per-monitor execution time. Editing the interval does not immediately rewrite existing D1 due timestamps: the new interval applies following that monitor's next successful check.

## arXiv categories and YouTube channels

Update **`config/targets.json`** without touching the source adapters:

```json
{
  "arxiv": [
    { "id": "arxiv-cs-ai", "categories": ["cs.AI", "cs.LG"] }
  ],
  "youtube": [
    { "id": "youtube-example", "channel": "UCxxxxxxxxxxxxxxxxxxxxxx" }
  ]
}
```

Replace the example channel ID with a **real** `UC...` channel ID, `@handle`, or YouTube channel URL. The repository currently keeps the YouTube `channel` value **empty** and the arXiv categories at `["cs.AI"]` until the owner supplies the desired targets. The example above is syntax guidance, **not** the live configuration. Additional entries require distinct stable IDs plus an interval in `config/intervals.json`. Source monitors stay **disabled** until explicitly enabled in `src/config.ts`. Never reuse a previously initialized monitor ID when changing its query/categories/channel: use a new ID to establish a silent baseline.

## Notification hours, retention and privacy

- **Discord sends only between 09:00 (inclusive) and 20:00 (exclusive), JST** (UTC+9; no DST). Overnight the Worker **still fetches feeds and queues new items**; after 09:00 it drains eligible pending alerts (up to three per run). A network request started just before 20:00 may arrive seconds afterward; this is not a hard Discord arrival deadline.
- The **hourly** maintenance Cron runs in a **separate Worker invocation**, with a single indexed `DELETE` bounded to **20 entries per run**. Only `sent` deliveries whose `sent_at` is over **10 days** old are removed. `pending` deliveries and `monitor_state` remain untouched; an unsent alert may be retained beyond 10 days.
- To prevent already deleted receipts from causing repeated alerts, articles with publication times more than 10 days old **at discovery** are not added to the outbox, even if discovered late. This deliberately trades off extremely late discovery for bounded deduplication storage.
- The owner applied remote migration `0009_delivery_retention.sql`; no additional migration is required for the hourly schedule change. Do not infer stable Free-plan CPU use without observing real maintenance and monitor invocations.

## Discord channel organization

One Discord server with separate channels works as intended. Create one incoming webhook **inside each destination channel**; configure the corresponding source-specific Cloudflare Secret (`DISCORD_WEBHOOK_QIITA`, `DISCORD_WEBHOOK_ARXIV`, etc.). Multiple monitors using the same source share that webhook and its persistent cooldown/invalid-webhook state in D1. Different sources should receive **different Webhook URLs**. Tokens are never saved in D1 or GitHub.

## GitHub / Cloudflare deployment (staging active)

1. Create a D1 database named `dopagaki-notify`, put its real `database_id` in `wrangler.jsonc`, and apply **all** SQL migrations in the `migrations/` directory (now through `0009_delivery_retention.sql`) in filename order using Wrangler.
2. Set the corresponding **Cloudflare Secrets** for the enabled sources: `DISCORD_WEBHOOK_QIITA`, `DISCORD_WEBHOOK_WIKIPEDIA`, `DISCORD_WEBHOOK_ARXIV`, `DISCORD_WEBHOOK_ZENN`, `DISCORD_WEBHOOK_YOUTUBE`. Never commit Webhook URLs to Git.
3. Configure monitors in `src/config.ts` and integer-minute intervals in `config/intervals.json`.
4. Connect GitHub to Cloudflare Workers Builds or deploy with Wrangler. Keep deployment disabled until D1/Secrets are configured.
5. Test the first silent baseline, later new-item notifications, failure retries, CPU limits and D1 state.

`workers_dev` is disabled and the HTTP handler returns 404. Ownership of a custom domain is not required for a Cron-only Worker.

## Implemented

- Separate monitor and retention Cron Triggers, with per-monitor D1 deadlines, leases, independent identity, and resumable API scan checkpoints.
- First run creates a **silent baseline**. Unknown older articles and edits are not notified.
- D1 durable outbox with bounded 12-article insert batches (84 SQL binds, below D1's 100-bind limit), **no baseline/old-article inserts**, and known-ID read-before-write to skip repeated inserts when nothing is new. New monitors are batch-initialized only when first encountered; once initialized, a quiet Cron invocation makes **no D1 INSERT**. Large rosters are read in chunks of at most 40 monitors (83 SQL binds), preserving global due-time priority while respecting D1's 100-bind limit. These are SQL-statement savings, not measured Cloudflare CPU results.
- Bounded Discord delivery and retry. Source API and Discord 429/503 responses respect `Retry-After` (including HTTP-date or Discord reset-after headers) by persisting cooldowns in D1 instead of sleeping. A Discord 429 stores a **source-wide webhook cooldown in D1**, which also suppresses delivery of newly discovered articles until the cooldown expires. The failed item receives its own retry deadline. This avoids a burst of futile requests and redundant updates of every queued item. For unusable Discord webhooks (401/403/404/410), delivery for **all monitors of that source** is blocked until an operator fixes the Secret and resets the D1 flag; queued items stay intact. Queued deliveries can drain during a source fetch outage; webhook host validation; no arbitrary mentions.
- **Qiita** JSON API adapter: stable ID and `created_at`, not `updated_at`.
- **Wikipedia** recent *page creations*, not random articles or edits.
- **arXiv** Atom API: creation date and version-independent paper ID.
- **Zenn** user/topic RSS: stable GUID and publication date (trend feeds deliberately excluded).
- **YouTube** channel Atom RSS: stable video ID and publication date; supports channel UC... ID or @handle/channel URL with D1 resolution cache.
- Automated tests using an in-memory SQLite database executing the same migration SQL.

## Recovering an invalid Discord webhook

If a webhook was deleted, rotated, or loses permission, the source stores `blocked_status` and `blocked_at` in `webhook_source_state`. The Worker **continues detecting new items but does not send or discard the pending queue**. Replace the relevant Cloudflare Webhook Secret, then deliberately clear the block for that source using an authenticated D1 SQL console or Wrangler (substitute your source name):

```sql
UPDATE webhook_source_state
SET blocked_status = NULL, blocked_at = NULL
WHERE source = 'qiita';
```

Do not clear the block before the Secret is corrected. Avoid publishing the Webhook URL or token in issue reports or logs.

## Limitations

- **arXiv, Zenn and YouTube** adapters have been ported from the Rust reference. Feed parsing is intentionally bounded, preserves literal CDATA content, ignores comment/CDATA markup when locating article boundaries, and rejects missing closing roots or unbalanced Atom/RSS entry tags (rather than silently returning an empty feed), but it is **not a full standards-compliant XML validator**. Actual Cloudflare runtime and source API behavior have not been verified live.
- YouTube @handle resolution caches the corresponding channel UC... ID in D1 for seven days. The public channel page is fetched only on cache misses or expiry. A raw channel UC... ID needs no resolution.
- **Qiita, Wikipedia and arXiv now resume bounded API pages across Cron ticks** using D1 checkpointed cursors. Each tick fetches at most one page for its selected monitor. When a non-initial scan has traversed multiple pages, it **rechecks the newest page once** before marking the scan complete, to recover top-of-feed inserts during offset pagination. A broken fetch retries the same page/checkpoint after backoff.
- The first scan establishes a silent baseline from the newest page only. Follow-up arXiv and MediaWiki scans use a **48-hour overlap** from the preceding completed scan to bound older-page traversal, as those feeds explicitly request creation/submission order. Qiita uses the documented `created:>=YYYY-MM-DD` query operator to restrict subsequent searches to an overlapping date window (preceding completed scan minus 48 hours, and another day for timezone safety). As results may use relevance ordering, it still paginates the filtered subset until exhausted or the API's 100-page limit, rather than stopping at a known ID.
- **Incomplete scans are now recorded in D1** (`monitor_state.incomplete_count`, `last_incomplete_at`), and do not advance `last_complete_at`. Inspect these fields when diagnosing a busy feed. A truncated page is still eligible to stage genuinely new notifications, but is not counted as a complete sweep. **This is not an absolute no-loss guarantee.** Late-indexed posts older than the 48-hour overlap, Qiita filtered results beyond 100 pages, and fixed-length Zenn/YouTube RSS feeds may leave undiscovered items. Head verification helps with page shifts but cannot guarantee coverage if new articles exceed the first-page capacity during a long scan, or if results reorder within the historical pages. Full RSS/Atom XML is still read within a size bound before individual entries are parsed; HTTP streaming currently bounds response bytes but does not stop after a matching known ID. Watch warnings when a paging limit is reached.
- The Worker processes one due monitor and one API page per Cron invocation and sends at most three notifications per invocation. A scan that needs many pages can temporarily extend effective monitoring intervals. Repeated high-frequency checks are best-effort.
- Cloudflare Workers Free CPU budget is 10 ms per invocation. The owner observed p50 around 1.17 ms and normal p99 around 2.07 ms, with occasional p99 near 19 ms (zero reported errors). These measurements precede the new maintenance Cron and do not establish worst-case compliance. API waiting time is excluded from CPU accounting.
- Initial baseline and permanently ineligible pre-baseline items are excluded without storing `ignored` outbox rows; existing legacy rows remain compatible.
- Discord sending and D1 acknowledgement are not atomic. A crash in between may duplicate a notification.
- Each persistent monitor ID is pinned to its source and trimmed query (not its interval). **To change a source or query, choose a new monitor ID and add the matching integer interval in `config/intervals.json`.** The new ID creates a separate silent baseline; an unchanged ID with a changed query now fails closed. Interval-only changes require no state migration. Legacy initialized D1 rows that lack identity information fail closed until intentionally migrated or reset.
- A Cloudflare Worker has been deployed by the owner, and the eight remote D1 migrations and Discord Secrets have been configured by the owner. The Qiita outbound delivery path was confirmed by the owner with a synthetic test item. The configured second staging monitor is Wikipedia new pages; first-run and real upstream ingestion still need inspection. CPU p50 around 1.17 ms and p99 around 2.07 ms were reported, with occasional p99 peaks near 19 ms and zero reported errors. This is **not** proof that all invocations remain within the 10 ms Workers Free CPU limit.

## Prior source code and API references

- [Original dopagaki-board source adapters](https://github.com/Nasu726/dopagaki-board/tree/main/src-tauri/src/sources)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
