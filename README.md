# dopagaki-notify

**Development starter — not production ready.** Cloudflare Workers + D1 sends alerts to Discord **only for newly published content**. No resident application, public GUI, or GitHub Actions cron. The code lives in GitHub; Cloudflare runs one Cron Trigger and handles per-monitor deadlines.

See [PROJECT_BRIEF.md](PROJECT_BRIEF.md) for the Japanese product specification and deployment boundaries, and [docs/ROADMAP.md](docs/ROADMAP.md) for the engineering plan and validation gates.

## Quick setup

Requires Node.js 22+; the project is written in TypeScript.

```sh
npm install
npm run check
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

The file intentionally holds **interval values only**. Sources, queries, IDs and enabled flags are in [src/config.ts](src/config.ts). To enable a monitor, set `enabled: true` there **after** its Cloudflare Discord webhook Secret has been configured.

The one Cron Trigger in `wrangler.jsonc` runs every minute (`* * * * *`), irrespective of these settings. Each successful check schedules the next due time in D1 at *completion/check time + interval minutes*. Missed/delayed Cron runs may cause monitoring to run late. **The current starter handles only one due monitor per tick**; several short-interval monitors can also cause delays. It does **not** guarantee an exact per-monitor execution time. Editing the interval does not immediately rewrite existing D1 due timestamps: the new interval applies following that monitor's next successful check.

## GitHub / Cloudflare deployment (not yet performed)

1. Create a D1 database named `dopagaki-notify`, put its real `database_id` in `wrangler.jsonc`, and apply **all** SQL migrations in the `migrations/` directory (including `0006_webhook_cooldown.sql`) in filename order using Wrangler.
2. Set the corresponding **Cloudflare Secrets** for the enabled sources: `DISCORD_WEBHOOK_QIITA`, `DISCORD_WEBHOOK_WIKIPEDIA`, `DISCORD_WEBHOOK_ARXIV`, `DISCORD_WEBHOOK_ZENN`, `DISCORD_WEBHOOK_YOUTUBE`. Never commit Webhook URLs to Git.
3. Configure monitors in `src/config.ts` and integer-minute intervals in `config/intervals.json`.
4. Connect GitHub to Cloudflare Workers Builds or deploy with Wrangler. Keep deployment disabled until D1/Secrets are configured.
5. Test the first silent baseline, later new-item notifications, failure retries, CPU limits and D1 state.

`workers_dev` is disabled and the HTTP handler returns 404. Ownership of a custom domain is not required for a Cron-only Worker.

## Implemented

- Single Cron Trigger with per-monitor D1 deadlines, leases, independent identity, and resumable API scan checkpoints.
- First run creates a **silent baseline**. Unknown older articles and edits are not notified.
- D1 durable outbox with bounded 12-article insert batches (84 SQL binds, below D1's 100-bind limit), **no baseline/old-article inserts**, and known-ID read-before-write to skip repeated inserts when nothing is new. New monitors are batch-initialized only when first encountered; once initialized, a quiet Cron invocation makes **no D1 INSERT**. These are SQL-statement savings, not measured Cloudflare CPU results.
- Bounded Discord delivery and retry. Source API and Discord 429/503 responses respect `Retry-After` (including HTTP-date or Discord reset-after headers) by persisting cooldowns in D1 instead of sleeping. A Discord 429 stores a **monitor-level webhook cooldown in D1**, which also suppresses delivery of newly discovered articles until the cooldown expires. The failed item receives its own retry deadline. This avoids a burst of futile requests and redundant updates of every queued item. Queued deliveries can drain during a source fetch outage; webhook host validation; no arbitrary mentions.
- **Qiita** JSON API adapter: stable ID and `created_at`, not `updated_at`.
- **Wikipedia** recent *page creations*, not random articles or edits.
- **arXiv** Atom API: creation date and version-independent paper ID.
- **Zenn** user/topic RSS: stable GUID and publication date (trend feeds deliberately excluded).
- **YouTube** channel Atom RSS: stable video ID and publication date; supports channel UC... ID or @handle/channel URL with D1 resolution cache.
- Automated tests using an in-memory SQLite database executing the same migration SQL.

## Limitations

- **arXiv, Zenn and YouTube** adapters have been ported from the Rust reference. Feed parsing is intentionally bounded and now rejects missing closing roots or unbalanced Atom/RSS entry tags (rather than silently returning an empty feed), but it is **not a full standards-compliant XML validator**. Actual Cloudflare runtime and source API behavior have not been verified live.
- YouTube @handle resolution caches the corresponding channel UC... ID in D1 for seven days. The public channel page is fetched only on cache misses or expiry. A raw channel UC... ID needs no resolution.
- **Qiita, Wikipedia and arXiv now resume bounded API pages across Cron ticks** using D1 checkpointed cursors. Each tick fetches at most one page for its selected monitor. A broken fetch retries the same page after backoff.
- The first scan establishes a silent baseline from the newest page only. Follow-up arXiv and MediaWiki scans use a **48-hour overlap** from the preceding completed scan to bound older-page traversal, as those feeds explicitly request creation/submission order. Qiita uses the documented `created:>=YYYY-MM-DD` query operator to restrict subsequent searches to an overlapping date window (preceding completed scan minus 48 hours, and another day for timezone safety). As results may use relevance ordering, it still paginates the filtered subset until exhausted or the API's 100-page limit, rather than stopping at a known ID.
- **Incomplete scans are now recorded in D1** (`monitor_state.incomplete_count`, `last_incomplete_at`), and do not advance `last_complete_at`. Inspect these fields when diagnosing a busy feed. A truncated page is still eligible to stage genuinely new notifications, but is not counted as a complete sweep. **This is not an absolute no-loss guarantee.** Late-indexed posts older than the 48-hour overlap, Qiita filtered results beyond 100 pages, and fixed-length Zenn/YouTube RSS feeds may leave undiscovered items. Full RSS/Atom XML is still read within a size bound before individual entries are parsed; HTTP streaming currently bounds response bytes but does not stop after a matching known ID. Watch warnings when a paging limit is reached.
- The Worker processes one due monitor and one API page per Cron invocation and sends at most three notifications per invocation. A scan that needs many pages can temporarily extend effective monitoring intervals. Repeated high-frequency checks are best-effort.
- Cloudflare Workers Free CPU budget is 10 ms per invocation; it has **not** been measured on actual Workers. API waiting time is excluded from CPU accounting.
- Initial baseline and permanently ineligible pre-baseline items are excluded without storing `ignored` outbox rows; existing legacy rows remain compatible.
- Discord sending and D1 acknowledgement are not atomic. A crash in between may duplicate a notification.
- Each persistent monitor ID is pinned to its source and trimmed query (not its interval). **To change a source or query, choose a new monitor ID and add the matching integer interval in `config/intervals.json`.** The new ID creates a separate silent baseline; an unchanged ID with a changed query now fails closed. Interval-only changes require no state migration. Legacy initialized D1 rows that lack identity information fail closed until intentionally migrated or reset.
- The example monitors are **disabled by default**. No live notification or cloud deployment has taken place.

## Prior source code and API references

- [Original dopagaki-board source adapters](https://github.com/Nasu726/dopagaki-board/tree/main/src-tauri/src/sources)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
