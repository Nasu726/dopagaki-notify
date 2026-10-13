# dopagaki-notify

**A small, customizable Discord notifier for Qiita, Zenn, arXiv, OpenAlex, YouTube, and Japanese Wikipedia article recommendations.**

Built for personal use and for people who want to fork and tailor a simple notification service. There is no web dashboard, account system, or continuously running server. Configure the topics you care about and deploy the Cloudflare Workers + D1 application.

**[日本語](README.md)** · [Historical deployment notes](docs/DEPLOYMENT.md) · [Design brief (Japanese)](PROJECT_BRIEF.md) · [Development roadmap](docs/ROADMAP.md)

> **Availability:** Cloudflare Workers + D1 is the primary, deployed runtime. An **opt-in** [GitHub Actions + SQLite notification template](templates/github-actions/notifier.yml) is now included, sharing the same polling logic. The Actions template has automated integration tests but is not yet long-term production-verified; its scheduling and persistence guarantees differ from Cloudflare.

**Always-on YouTube test monitor:** `youtube-quizknock` (`@QuizKnock`, pinned `UCQ_MqAw18jFTlBB-f8BP7dw`) now polls **hourly every day** without a weekday restriction, sharing `DISCORD_WEBHOOK_YOUTUBE`. Its first successful poll can notify the latest available video. Deployments using a complete `MONITOR_CONFIG_JSON` override must add the new target to that private configuration too.

## Features

| Source | Notification selection |
| --- | --- |
| Qiita | Up to 3 most recently created posts among the first 20 search results |
| Zenn | Up to 3 newest entries in a topic or user RSS feed |
| arXiv | Newly submitted papers in selected categories, with paginated scanning |
| OpenAlex | Papers by search terms, topic ID, or author ID; bounded to the most recent 25 works published within seven days |
| YouTube | Always notify the latest available video if unseen, regardless of age; also notify normal new uploads. Optional Data API and pinned `channelId` to prevent cross-channel resolution. Notifications include thumbnails |
| Japanese Wikipedia | Up to 1 featured article and 1 sufficiently substantial random article per recommendation poll |

- Stable item IDs prevent repeated notifications. The first successful poll normally establishes a **silent baseline**, except for **YouTube**, which notifies the newest video whenever it is not already acknowledged, even if it was published before the initial baseline. YouTube sent IDs are kept permanently to prevent repeated historical notifications; newer videos are still detected.
- Each monitor has its own polling interval. YouTube monitors may run only on a chosen day of the week in Japan Standard Time. Qiita, Zenn, and YouTube Discord embeds support thumbnails.
- One Discord webhook **per source** (shared by monitors of that source). **Notifications are enabled around the clock by default**. An optional JST delivery window can defer messages while source polling continues.
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

These are illustrative **complete** files. Set the optional top-level `notificationWindowJst` field in `config/targets.json` to `null` for unrestricted delivery (the default), or a time range as described below. Remove any example targets you do not want, and ensure every target ID has an interval. YouTube monitors with `weekdayJst` must use a `60`-minute interval. The Japanese Wikipedia discovery monitor is defined in `src/config.ts` and enabled in normal checked-in configuration.

**Important:** Never reuse an initialized monitor ID for a different query, platform, or category set. D1 pins IDs to their original source/query identity and will reject changes to avoid mixing histories. Choose a new ID when changing the monitored subject. Updating the interval alone is safe.

### Optional notification delivery hours (JST)

Notifications are sent **at all hours by default**. Set `"notificationWindowJst": "09:00-20:00"` in `config/targets.json` to restrict starts of Discord sends to 09:00 through 19:59 JST. The end is **exclusive**. Overnight ranges such as `"22:00-06:00"` are supported. Leave the setting `null` for no restriction; identical start/end times are invalid. Polling and durable queueing continue even when delivery is paused.

For a public fork with personal notification hours, register a private deployment Secret instead:

```sh
npx wrangler secret put NOTIFICATION_WINDOW_JST
```

Enter `09:00-20:00` (or your preferred range) into the prompt. You can also include `"notificationWindowJst": "09:00-20:00"` in your private `MONITOR_CONFIG_JSON`. Precedence: **dedicated Secret → private monitor JSON → checked-in `config/targets.json`**. No database migration or new monitor IDs are needed.

For public forks where your topic choices should **not be visible on GitHub**, use the private configuration described in [Section 3](#3-keep-your-interests-private-public-forks) instead of committing your target list.

### Wikimedia identification (for forks)

Wikimedia expects automated API clients to identify the software and provide a way to contact the **operator**. The default header identifies this application and links to the original repository. **If you fork and enable Wikipedia, set your own contact URL** rather than continuing to identify the original author as your operator.

For Cloudflare Workers, create the ordinary **Variable** `WIKIMEDIA_CONTACT_URL` under **Worker → Settings → Variables and Secrets**, e.g. `https://github.com/YOUR_USERNAME/dopagaki-notify`. The app constructs the `User-Agent` and `Api-User-Agent` headers automatically. No Wikimedia API key or account registration is required.

An existing original deployment continues to use the original contact by default. The GitHub Actions template derives the contact URL from the fork's `GITHUB_REPOSITORY` if no override is set.

### OpenAlex paper monitoring (optional)

Add monitors in `config/targets.json` under `openalex`, e.g. `{"id":"oa-graph","query":"search:graph algorithms","enabled":true}`. Supported query forms are `search:terms`, `topic:T12345`, and `author:A12345`. Resolve IDs at <https://openalex.org/>; add corresponding intervals to `config/intervals.json`. Add a dedicated Discord Webhook Secret `DISCORD_WEBHOOK_OPENALEX`.

A low-volume installation can use the OpenAlex Works API **without a key**; an optional free `OPENALEX_API_KEY` Cloudflare Secret increases the daily budget. The source reads up to 25 results published within the last seven days. OpenAlex supplies publication **dates**, not precise times: the initial results are saved as ignored IDs so newly appearing works with the same publication date can be notified on subsequent polls. This is a snapshot, not exhaustive historical coverage. Existing private monitor configs may omit `openalex` for backwards compatibility.

### Optional YouTube Data API

The default uses YouTube RSS without any API key. For more reliable access, enable **YouTube Data API v3** in Google Cloud and register an optional **`YOUTUBE_API_KEY` Cloudflare Secret**:

```sh
npx wrangler secret put YOUTUBE_API_KEY
```

When set, the adapter uses `channels.list` and `playlistItems.list` (1 quota unit each) to read up to 50 uploads. API errors are logged and retried; the code does not silently fall back to RSS. Both adapters use the same video IDs and persisted sent history. Unlike other sources' ten-day sent receipts, **YouTube sent receipts are retained indefinitely** so an ancient newest upload cannot re-notify after history pruning. This uses additional D1/SQLite storage over time.

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

Paste the **new UUID from your Cloudflare account** into this helper, which updates `wrangler.jsonc`:

```sh
npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID
```

The checked-in UUID belongs to the original author's environment and must not be reused. If you change the Worker/D1 name in `wrangler.jsonc`, also adjust the following commands to match. Keep the database binding named `DB`.

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
| OpenAlex | `DISCORD_WEBHOOK_OPENALEX` |
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
    "openalex": [],
    "youtube": []
  },
  "intervals": { "my-qiita-go": 360 },
  "wikipediaEnabled": false,
  "notificationWindowJst": null
}
```

After checking your local file, open **Cloudflare Dashboard → Worker → Settings → Variables and Secrets** and create **`MONITOR_CONFIG_JSON`** with type **Secret**. Paste the entire JSON file as its value. Alternatively, use `npx wrangler secret put MONITOR_CONFIG_JSON` and its interactive prompt. Updating a deployed Worker's Secret deploys a new Worker version; inspect logs after it takes effect.

**Privacy considerations:** Avoid committing webhook URLs, personal target lists, D1 delivery history, and private credentials. The checked-in D1 UUID is not a password, but replace the author's account-specific value. Personal subjects can also leak through public Actions logs, issues, pull requests, or public Discord channels. Adding a file to `.gitignore` **after** committing it does not erase existing Git history. If hiding project usage and metadata matters too, use a **private repository**.

## 4. Run with GitHub Actions + SQLite (opt-in template)

If you do not want to use Cloudflare, use the [GitHub Actions notifier template](templates/github-actions/notifier.yml). It uses Node.js SQLite instead of D1 and stores the database between workflow runs as an **AES-256-GCM encrypted GitHub Actions artifact**. Neither your plaintext database nor your subscriptions need to be committed.

**Setup:**

1. Fork this repository (public or private), clone it and run `npm install`.
2. Run `npm run setup:actions`. This copies the workflow, creates a gitignored generic `.private/monitor-config.json`, and generates `.private/notify-state-key.txt` without overwriting existing keys.
3. Edit the private JSON and add GitHub **Settings → Secrets and variables → Actions** Secrets: `MONITOR_CONFIG_JSON` (entire JSON), `NOTIFY_STATE_KEY` (64 hex characters), and your selected source's `DISCORD_WEBHOOK_*` URLs.
4. **After adding Secrets**, commit and push `.github/workflows/notifier.yml`.
5. Open **Actions → Discord notifier (SQLite) → Run workflow** for the initial silent baseline. Scheduled checks then run about every 10 minutes, subject to GitHub delays.

The encryption key is generated automatically by setup. After `gh auth login`, upload it and the private config without displaying either value:

```sh
gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json
gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt
```

Losing or rotating the key makes previous state artifacts unreadable. Add webhook URLs as separate Secrets. Never commit these files or the database.

GitHub schedules can be delayed or skipped, and artifacts expire. If the state artifact is missing, the workflow **fails closed rather than silently reinitializing**. An intentional reset requires **Run workflow → reset_state** and discards old deduplication records and pending messages. Repository activity is required to keep scheduled workflows enabled on public forks.

**[Detailed GitHub Actions deployment and recovery guide](docs/GITHUB_ACTIONS.EN.md)**

## Operations and limitations

- **Delivery is unrestricted by default (24 hours)**. You may enable a JST delivery window in configuration or a private Secret; monitoring continues regardless.
- arXiv continues bounded paginated scans; Qiita/Zenn intentionally skip older candidates; Wikipedia uses sampled recommendations.
- The YouTube RSS endpoint sometimes returns HTTP 404/500. A YouTube RSS 404 is retried after at least 60 minutes.
- When a webhook has been blocked due to an invalid URL, fixing the Secret alone is insufficient; the source-wide `webhook_source_state` block must also be cleared manually. See the [deployment runbook](docs/DEPLOYMENT.md).
- Successful CI does not prove that real provider APIs or Discord delivery are working. Monitor Cloudflare errors, CPU time, D1 usage, and actual notifications.

## Manual upstream and Discord smoke tests

Operators can fetch a configured monitor on demand using a local Node CLI. The default performs **no Discord POST and no D1 or outbox writes**:

```sh
node --experimental-strip-types ops/manual-smoke.mjs --monitor=youtube-quizknock
```

Only the explicitly confirmed `--send-test --confirm-send` mode sends a single `[TEST]` embed, with the source webhook supplied through a private environment variable. Local success does not prove the deployed Cloudflare Worker is healthy. See the [operator diagnostics guide](docs/MANUAL_SMOKE.md).

## Development

```sh
npm install
npm run check
npm run bundle:check
npm run dev
```

See `src/sources/` and `src/runner.ts` for adding integrations. The [design brief](PROJECT_BRIEF.md) and [development roadmap](docs/ROADMAP.md) preserve architecture and implementation history. Do not post webhook URLs, private subscriptions, or operational secrets in issues or PRs.

## License

[MIT License](LICENSE) (Copyright (c) 2026 nasu). Modification, redistribution and commercial use are permitted provided the copyright notice and license terms are included.

### YouTube handle identity

For YouTube monitor targets, specify an optional `channelId` alongside `channel`, e.g. `{"id":"youtube-example","channel":"@example","channelId":"UC1234567890123456789012","enabled":true}`. The pinned immutable channel ID bypasses page scraping and cached handle resolution (in RSS and official API mode). Without a pinned ID, the app accepts only the channel page's ownership metadata, never related-channel links or arbitrary page JSON IDs. An RSS channel ID mismatch causes a retryable error instead of a wrong notification. The Discord YouTube embed also includes a thumbnail image.


### Qiita and Zenn article thumbnails

Zenn thumbnails now come **first from the original RSS `enclosure`**, with no extra HTTP request when a newly fetched article is delivered in the same tick. For queued notifications, the sender looks for the matching article in the author's Zenn RSS, falling back to its article HTML OGP only if the feed has no suitable image. Qiita prioritizes its article HTML `og:image` / `twitter:image`. If that is unavailable or its URL is too long for a Discord embed, Qiita can instead show the **author's profile icon** as a small thumbnail, obtained from the existing Items API response. The avatar is not the article's original OGP image. There is **no additional API key or D1 migration**, and existing pending deliveries gain the feature. If the publisher blocks the request, no suitable image is found, or the image cannot be displayed by Discord, the text/link notification still works. Qiita adds at most one page fetch per notification; a delayed Zenn notification may require one RSS request and one HTML fallback. RSS and HTML requests are bounded and image failures never block the notification.
