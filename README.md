# dopagaki-notify

**Development starter — not production ready.** Cloudflare Workers + D1 sends alerts to Discord **only for newly published content**. No resident application, public GUI, or GitHub Actions cron. The code lives in GitHub; Cloudflare runs one Cron Trigger and handles per-monitor deadlines.

See [PROJECT_BRIEF.md](PROJECT_BRIEF.md) for the Japanese product specification and deployment boundaries.

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
  "wikipedia-ja": 60
}
```

The file intentionally holds **interval values only**. Sources, queries, IDs and enabled flags are in [src/config.ts](src/config.ts). To enable a monitor, set `enabled: true` there **after** its Cloudflare Discord webhook Secret has been configured.

The one Cron Trigger in `wrangler.jsonc` runs every minute (`* * * * *`), irrespective of these settings. Each successful check schedules the next due time in D1 at *completion/check time + interval minutes*. Missed/delayed Cron runs may cause monitoring to run late. **The current starter handles only one due monitor per tick**; several short-interval monitors can also cause delays. It does **not** guarantee an exact per-monitor execution time. Editing the interval does not immediately rewrite existing D1 due timestamps: the new interval applies following that monitor's next successful check.

## GitHub / Cloudflare deployment (not yet performed)

1. Create a D1 database named `dopagaki-notify`, put its real `database_id` in `wrangler.jsonc`, and apply the SQL in `migrations/0001_init.sql` using Wrangler's migration command.
2. Set `DISCORD_WEBHOOK_QIITA` and/or `DISCORD_WEBHOOK_WIKIPEDIA` as **Cloudflare Secrets**, never in Git.
3. Configure monitors in `src/config.ts` and integer-minute intervals in `config/intervals.json`.
4. Connect GitHub to Cloudflare Workers Builds or deploy with Wrangler. Keep deployment disabled until D1/Secrets are configured.
5. Test the first silent baseline, later new-item notifications, failure retries, CPU limits and D1 state.

`workers_dev` is disabled and the HTTP handler returns 404. Ownership of a custom domain is not required for a Cron-only Worker.

## Implemented

- Single Cron Trigger with per-monitor D1 deadlines, leases and independent identity.
- First run creates a **silent baseline**. Unknown older articles and edits are not notified.
- D1 durable outbox; bounded Discord delivery and retry; webhook host validation; no arbitrary mentions.
- **Qiita** JSON API adapter: stable ID and `created_at`, not `updated_at`.
- **Wikipedia** recent *page creations*, not random articles or edits.
- Automated tests using an in-memory SQLite database executing the same migration SQL.

## Limitations

- **arXiv, Zenn and YouTube** adapters remain to be implemented. The previous project's Rust fetch/parsing/ID normalization code is the reference.
- Current source adapters fetch only the newest bounded API page, warning on possible truncation. Complete pagination and safe stop conditions are **not** yet implemented; busy feeds may lose new items.
- The Worker processes one due monitor per Cron invocation and sends at most three notifications per invocation. Repeated high-frequency checks are best-effort.
- Cloudflare Workers Free CPU budget is 10 ms per invocation; it has **not** been measured on actual Workers. API waiting time is excluded from CPU accounting.
- Discord sending and D1 acknowledgement are not atomic. A crash in between may duplicate a notification.
- Changing a monitor ID creates a new independent first-run baseline. Changing its query with the same ID requires deliberate state migration.
- The example monitors are **disabled by default**. No live notification or cloud deployment has taken place.

## Prior source code and API references

- [Original dopagaki-board source adapters](https://github.com/Nasu726/dopagaki-board/tree/main/src-tauri/src/sources)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
