# dopagaki-notify

**A small, customizable Discord notifier for Qiita, Zenn, arXiv, YouTube, and Japanese Wikipedia article recommendations.**

Built for personal use and for people who want to fork and tailor a simple notification service. There is no web dashboard, account system, or continuously running server. Configure the topics you care about and deploy the Cloudflare Workers + D1 application.

**[日本語](README.md)** · [Historical deployment notes](docs/DEPLOYMENT.md) · [Design brief (Japanese)](PROJECT_BRIEF.md) · [Development roadmap](docs/ROADMAP.md)

> **Implementation status:** The Cloudflare Workers edition is implemented. The existing GitHub Actions workflow performs CI checks only; it does **not** run scheduled notifications. Porting the notification logic to Actions is possible, but requires a SQLite adapter and persistent storage. This repository does not currently include a working Actions-based notifier.

## Features

| Source | Notification selection |
| --- | --- |
| Qiita | Up to 3 most recently created posts among the first 20 search results |
| Zenn | Up to 3 newest entries in a topic or user RSS feed |
| arXiv | Newly submitted papers in selected categories, with paginated scanning |
| YouTube | All eligible new videos currently available in a channel's bounded Atom feed |
| Japanese Wikipedia | Up to 1 featured article and 1 sufficiently substantial random article per recommendation poll |

- Stable item IDs prevent repeated notifications. The first successful poll establishes a **silent baseline**: it does not send already published content.
- Each monitor has its own polling interval. YouTube monitors may run only on a chosen day of the week in Japan Standard Time.
- One Discord webhook **per source** (shared by monitors of that source). Messages are sent only **09:00–19:59 JST**; new content found outside these hours waits in D1.
- The 5-minute dispatcher polls one due monitor at a time and sends up to three queued notifications per invocation. D1 tracks pending items, retries, webhook cooldowns, and deduplication state.
- Qiita and Zenn deliberately **prioritize freshness over completeness**; this is not a content archive. Qiita search results are not necessarily chronological, so posts outside the first 20 results cannot be selected.
- YouTube's RSS feed holds a limited number of videos. An extended source outage or videos that have already fallen out of its feed may cause gaps.

## 1. Choose sources and polling intervals

For a normal, repository-configured installation, edit two files:

- [`config/targets.json`](config/targets.json): Qiita search terms, Zenn topics/users, arXiv categories, YouTube channels, and each target's `enabled` flag.
- [`config/intervals.json`](config/intervals.json): positive integer polling intervals **in minutes**, indexed by monitor `id`.

Example `config/targets.json`:

```json
{
  "qiita": [{ "id": "qiita-go", "query": "tag:Go", "enabled": true }],
  "zenn": [{ "id": "zenn-rust", "query": "topic:rust", "enabled": true }],
  "arxiv": [{ "id": "arxiv-ds", "categories": ["cs.DS"], "enabled": true }],
  "youtube": [{ "id": "youtube-example", "channel": "@example", "enabled": true, "weekdayJst": "sunday" }]
}
```

Matching `config/intervals.json`:

```json
{
  "qiita-go": 240,
  "zenn-rust": 240,
  "arxiv-ds": 120,
  "youtube-example": 60,
  "wikipedia-ja-discovery": 120
}
```

These are illustrative **complete** files. Remove any example targets you do not want, and ensure every target ID has an interval. YouTube monitors with `weekdayJst` must use a `60`-minute interval. The Japanese Wikipedia discovery monitor is defined in `src/config.ts` and enabled in normal checked-in configuration.

**Important:** Never reuse an initialized monitor ID for a different query, platform, or category set. D1 pins IDs to their original source/query identity and will reject changes to avoid mixing histories. Choose a new ID when changing the monitored subject. Updating the interval alone is safe.

For public forks where your topic choices should **not be visible on GitHub**, use the private configuration described in [Section 3](#3-keep-your-interests-private-public-forks) instead of committing your target list.

## 2. Deploy with Cloudflare Workers (supported)

**Prerequisites:** Node.js 22+, a Cloudflare account, and one or more Discord channels with incoming webhooks. Check your Cloudflare plan's current limits and charges before deployment. Fork this repository on GitHub, then clone your fork. You may instead clone the upstream repository for a local-only installation.

```sh
git clone https://github.com/YOUR_USERNAME/dopagaki-notify.git
cd dopagaki-notify
npm install
npm run check
npx wrangler login
```

**① Create your own D1 database**

```sh
npx wrangler d1 create dopagaki-notify
```

Replace `d1_databases[0].database_id` in `wrangler.jsonc` with the UUID returned **for your account**. The checked-in UUID belongs to the original author's environment; forks cannot use it as-is. You may change the Worker or D1 name to avoid collisions, but keep the D1 binding named `DB`.

**② Apply the bundled migrations to the remote database**

```sh
npx wrangler d1 migrations apply dopagaki-notify --remote
```

The name is the D1 database name you created. The schema migrations live in `migrations/`. Do not use `--local` when preparing your deployed database.

**③ Deploy the Worker**

```sh
npm run deploy
```

`wrangler.jsonc` already defines the polling Cron (`*/5 * * * *`) and hourly retention Cron (`10 * * * *`). There is no public HTTP API; a direct GET intentionally returns 404.

**④ Register Discord webhook Secrets**

Create an incoming webhook for each Discord destination you want to use. Save the URL as a **Cloudflare Secret**, not in your repository.

| Source | Secret name |
| --- | --- |
| Qiita | `DISCORD_WEBHOOK_QIITA` |
| Zenn | `DISCORD_WEBHOOK_ZENN` |
| arXiv | `DISCORD_WEBHOOK_ARXIV` |
| YouTube | `DISCORD_WEBHOOK_YOUTUBE` |
| Wikipedia | `DISCORD_WEBHOOK_WIKIPEDIA` |

```sh
npx wrangler secret put DISCORD_WEBHOOK_QIITA
```

Paste the webhook URL into the interactive prompt; repeat for the sources you enable. Monitors without a webhook Secret remain dormant. Several monitors within one source share that source's webhook and its cooldown/block state.

**⑤ Verify the installation**

The first successful poll creates a baseline without sending old posts. No new content means no Discord message.

```sh
npx wrangler tail dopagaki-notify --format pretty
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id,initialized_at,last_complete_at,next_due_at FROM monitor_state ORDER BY id;"
```

A non-null `initialized_at` indicates the first poll and baseline completed. To verify delivery, look for a genuinely new message in Discord and its acknowledgement in D1's `deliveries` table. For automated Cloudflare deployments, you can connect GitHub to Cloudflare Workers Builds after configuring the database and Secrets.

## 3. Keep your interests private (public forks)

You can keep a public fork of the code **without publicly committing your personal monitoring subjects**.

- **Default:** The Worker uses the checked-in `config/targets.json` and `config/intervals.json`.
- **Private override:** Set the Cloudflare Secret **`MONITOR_CONFIG_JSON`**. It completely **replaces** the checked-in monitor roster; it never merges in public default subjects.
- Invalid JSON or an invalid monitor definition **fails closed** rather than silently falling back to the public list.

Create a locally ignored configuration file from the example defaults:

```sh
mkdir -p .private
node ops/export-monitor-config.mjs > .private/monitor-config.json
```

Edit `.private/monitor-config.json` to suit your interests. The `.private/` directory is gitignored. `targets` and `intervals` have the same shapes as the public files; to disable Wikipedia, specify `wikipediaEnabled: false` and omit its interval entry.

Example **private** Secret value:

```json
{
  "targets": {
    "qiita": [{ "id": "my-qiita-go", "query": "tag:Go", "enabled": true }],
    "zenn": [],
    "arxiv": [],
    "youtube": []
  },
  "intervals": { "my-qiita-go": 360 },
  "wikipediaEnabled": false
}
```

After checking your local file, open **Cloudflare Dashboard → Worker → Settings → Variables and Secrets** and create **`MONITOR_CONFIG_JSON`** with type **Secret**. Paste the entire JSON file as its value. Alternatively, use `npx wrangler secret put MONITOR_CONFIG_JSON` and its interactive prompt. Updating a deployed Worker's Secret deploys a new Worker version; inspect logs after it takes effect.

**Privacy considerations:** Avoid committing webhook URLs, personal target lists, D1 delivery history, and private credentials. The checked-in D1 UUID is not a password, but replace the author's account-specific value. Personal subjects can also leak through public Actions logs, issues, pull requests, or public Discord channels. Adding a file to `.gitignore` **after** committing it does not erase existing Git history. If hiding project usage and metadata matters too, use a **private repository**.

## 4. GitHub Actions as an alternative runtime (porting guide)

**The included GitHub Actions workflow is CI-only. There is no working scheduled Actions notifier in this repository today.**

The core functionality in `src/runner.ts` can be reused outside Cloudflare, but GitHub-hosted runners are ephemeral. A port needs **durable SQLite storage across workflow runs**. A fresh in-memory SQLite database on every execution would lose baselines, deduplication state, and queued notifications.

An Actions port needs: (1) a Node SQLite implementation of the D1-shaped `Database` interface, (2) schema initialization from `migrations/`, (3) an entrypoint invoking the polling and retention tasks, (4) `schedule` and `workflow_dispatch` YAML, (5) durable storage with a safe synchronization/concurrency strategy, and (6) GitHub Actions Secrets for webhooks and private monitor settings.

GitHub Actions `schedule` supports intervals down to five minutes, but runs may be delayed or dropped; in public repositories inactive for 60 days, scheduled workflows may be automatically disabled. This is not an exact-equivalence deployment. **Do not commit a live SQLite DB to a public repository** to persist state: it includes the subscriptions and content history you are trying to keep private.

For a ready-to-use solution, use **Cloudflare Workers + D1**. An Actions version is an achievable separate integration project, not a setup switch.

## Operations and limitations

- Discord send window: **09:00–19:59 JST**. Polling continues at night.
- arXiv continues bounded paginated scans; Qiita/Zenn intentionally skip older candidates; Wikipedia uses sampled recommendations.
- The YouTube RSS endpoint sometimes returns HTTP 404/500. A YouTube RSS 404 is retried after at least 60 minutes.
- When a webhook has been blocked due to an invalid URL, fixing the Secret alone is insufficient; the source-wide `webhook_source_state` block must also be cleared manually. See the [deployment runbook](docs/DEPLOYMENT.md).
- Successful CI does not prove that real provider APIs or Discord delivery are working. Monitor Cloudflare errors, CPU time, D1 usage, and actual notifications.

## Development

```sh
npm install
npm run check
npm run bundle:check
npm run dev
```

See `src/sources/` and `src/runner.ts` for adding integrations. The [design brief](PROJECT_BRIEF.md) and [development roadmap](docs/ROADMAP.md) preserve architecture and implementation history. Do not post webhook URLs, private subscriptions, or operational secrets in issues or PRs.

> **Licensing note:** The project does not yet include an explicit `LICENSE` file. The maintainer should select a license to clarify modification and redistribution rights for others.
