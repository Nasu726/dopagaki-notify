# dopagaki-notify

**A small, self-hosted Discord notifier for the sources you follow.**

Monitor Qiita, Zenn, arXiv, OpenAlex, YouTube and Japanese Wikipedia using **Cloudflare Workers + D1** or **GitHub Actions + SQLite**. No web UI, app login, or always-running personal computer. Choose your subscriptions, retention and runtime.

[日本語](README.md) · [Features & delivery policy](#features-and-delivery-policy) · [Commands](#operations-and-troubleshooting) · [MIT License](LICENSE)

> **Runtime:** Choose Cloudflare Workers + D1 or GitHub Actions + SQLite. Sources, private monitor configuration, delivery windows and per-monitor retention are shared; GitHub Actions has different scheduling and Artifact-recovery guarantees. **All public example monitors are disabled by default**. If thumbnails are hidden, check the [Discord client display preference](#if-thumbnail-images-are-not-visible) before investigating webhook delivery.

## Choose your path

| Goal | Start here |
| --- | --- |
| First deployment with Cloudflare | [1. Choose monitors](#1-choose-your-monitors) → [2. Deploy with Cloudflare](#2-deploy-with-cloudflare-workers--d1) |
| Keep personal subscriptions private in a public fork | [Private monitor configuration](#keep-your-monitors-private) |
| Change settings on an existing deployment | [Preflight and delivery hours](#validate-settings-and-choose-delivery-hours) |
| Thumbnail images are hidden | [Discord display preference](#if-thumbnail-images-are-not-visible) |
| Test a source immediately or diagnose images | [Safe diagnostic commands](#safe-diagnostic-commands) |
| Run without Cloudflare | [GitHub Actions + SQLite](#3-github-actions--sqlite-optional) |

**Command reference** (repository root, Node.js 22+):

| Command | Purpose / side effects |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run config:check` | Validate local configuration; no sends or D1 writes |
| `npm run check` | TypeScript typecheck and all tests |
| `npm run deploy` | Config preflight, then **deploy production Worker** |
| `npm run smoke -- --monitor=qiita-example` | Fetch one upstream snapshot; no D1 or Discord changes |
| `npm run inspect:discord -- --help` | Read-only diagnostics for an **existing** Discord message |
| `npm run dev` | Start the local development Worker |

## Features and delivery policy

| Source | What is monitored | Coverage |
| --- | --- | --- |
| Qiita | Articles matching search queries | Newest three from the first 20 API results |
| Zenn | User/topic RSS feeds | Newest three items |
| arXiv | Research paper categories | Bounded paginated scans |
| OpenAlex | Search terms, topic IDs, author IDs | Last seven days, at most 25 results |
| YouTube | Chosen video channels | Latest unseen video within its configured retention horizon is eligible on first scan |
| Japanese Wikipedia | Featured and random articles | Up to two recommendations per poll |

**Deduplication:** D1 stores notification receipts, pending deliveries and retry times. Most sources establish a **silent baseline** on their first successful fetch. YouTube can notify the newest unseen video on the first poll, provided it falls within its configured retention horizon. Sent receipt retention defaults to **10 days for every source, including YouTube**, independently configurable for each monitor ID via `retentionDays`. Qiita and Zenn favor freshness over exhaustive archiving.

**Scheduling:** The Worker runs every five minutes and normally handles one due monitor per invocation. Per-monitor intervals indicate when a fetch becomes eligible, not an exact execution time. It sends at most three items per invocation. Polling and queuing continue **outside allowed notification hours**.

**Images:** Qiita and Zenn can show RSS/OGP images (Qiita may fall back to author avatar). YouTube generates a thumbnail URL from the video ID. **Discord's client-side preview setting controls whether embedded images are visible.** Missing images never block title/link delivery.

## 1. Choose your monitors

[Fork this repository](https://github.com/Nasu726/dopagaki-notify/fork), then clone your fork:

```sh
git clone https://github.com/YOUR_USERNAME/dopagaki-notify.git
cd dopagaki-notify
npm install
```

Choose **checked-in public JSON** or a **private runtime Secret**. Both Cloudflare and GitHub Actions support the same target configuration; Actions defaults to private mode for safety. **All checked-in sample targets are disabled** until enabled by the fork owner. Wikipedia is controlled by `wikipediaEnabled`:

- [`config/targets.json`](config/targets.json): Sources, targets, `enabled` flags, and the public `notificationWindowJst`.
- [`config/intervals.json`](config/intervals.json): Positive integer intervals **in minutes**, keyed by monitor `id`.
- A private `MONITOR_CONFIG_JSON` **replaces the whole public roster** on either runtime; it does not merge with it. GitHub Actions explicitly selects `MONITOR_CONFIG_MODE=private` (default) or `public`.

Sample target fragment (a complete `targets.json` must include all source categories):

```json
{
  "qiita": [{ "id": "qiita-go", "query": "tag:Go", "enabled": true }],
  "zenn": [{ "id": "zenn-rust", "query": "topic:rust", "enabled": true }],
  "arxiv": [{ "id": "arxiv-ds", "categories": ["cs.DS"], "enabled": true }],
  "openalex": [{ "id": "oa-graph", "query": "search:graph algorithms", "enabled": true }],
  "youtube": [{
    "id": "youtube-example",
    "channel": "@example",
    "channelId": "UC1234567890123456789012",
    "videoType": "videos",
    "enabled": true
  }],
  "notificationWindowJst": null,
  "wikipediaEnabled": false
}
```

Provide intervals for the IDs above and for `wikipedia-ja-discovery` if using the standard Wikipedia monitor. `weekdayJst` restricts which JST weekdays permit fetching; set any positive integer polling interval in minutes, independently.

**Monitor identity:** Do not reuse an existing `id` for a different provider/query/channel. D1 pins it to its original source/query identity to protect historical receipts. For a changed subject, create a new `id`. Changing intervals is safe.

**Exclude YouTube Shorts:** Set `"videoType": "videos"` **and a pinned `channelId`** to use the undocumented `UULF` RSS playlist for regular videos only (also excludes live streams). Omitted or `"all"` means all uploads. This URL is **not an officially supported YouTube API contract**; if it fails, the monitor does **not** silently fall back to a Shorts-inclusive feed. The checked-in sample monitors no channel. Videos-only monitors use RSS even if `YOUTUBE_API_KEY` is present; other YouTube monitors can use the optional [YouTube Data API v3](https://developers.google.com/youtube/v3).

**OpenAlex:** Query formats are `search:graph algorithms`, `topic:T12345`, `author:A12345`. Optional `OPENALEX_API_KEY` increases API allowance. See the [deployment runbook](docs/DEPLOYMENT.md) for details.

### Per-monitor sent history retention (Cloudflare and GitHub Actions)

`retentionDays` configures **how long acknowledged receipts are stored** and how long old content may remain eligible for rediscovery, independently of the polling interval. In checked-in configuration, set it at the top level of [`config/targets.json`](config/targets.json); for private configurations, put the same field at the top level of `MONITOR_CONFIG_JSON`. Unspecified monitors use the **10-day default, including YouTube**.

```json
{
  "retentionDays": {
    "youtube-example": 365,
    "qiita-example": 30,
    "zenn-example": null
  }
}
```

- Positive integer (1–36500) = number of days; `null` = never delete sent receipts.
- For YouTube **a finite value also excludes old uploads once they fall outside the retention horizon**. This avoids re-alerting the same latest video after deleting its receipt, but means an older video can be skipped even on the first scan. Prefer a long interval or `null` for infrequently publishing channels.
- The maintenance Cron removes at most 20 sent receipts per invocation and **never deletes pending or ignored rows**. Increasing retention cannot restore records already deleted.
- GitHub Actions uses the **same retention logic on SQLite**, independently from the Actions Artifact expiration/availability limit.

### Keep your monitors private

To avoid publishing your personal subscriptions in a public fork, create a local gitignored file:

```sh
mkdir -p .private
node ops/export-monitor-config.mjs > .private/monitor-config.json
```

Edit `targets`, `intervals` and `wikipediaEnabled` there. The entire JSON is stored as the **`MONITOR_CONFIG_JSON`** Cloudflare Secret (Dashboard → Worker → Settings → Variables and Secrets). It is not combined with the public target list.

```sh
npm run config:check -- --private-config-file=.private/monitor-config.json
npx wrangler secret put MONITOR_CONFIG_JSON
```

Paste the JSON into the Cloudflare Secret prompt. For **GitHub Actions**, use `gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json` to register the same private file. **Never post secrets or private subscriptions in source control, chat, issues or CI logs.** Deployed Cloudflare Secrets cannot be read back, so verify the intended value locally before setting it.

### Validate settings and choose delivery hours

`npm run config:check` validates checked-in settings and any private configuration in the local environment with the same parser used by the Worker. To validate private files:

```sh
npm run config:check -- --private-config-file=.private/monitor-config.json
npm run config:check -- --notification-window-file=.private/notification-window.txt
# Validate the precise intended Cloudflare Secret value before updating
npm run config:check -- --notification-window=08:00-20:00
```

Time windows use **JST, start inclusive / end exclusive**. For example, `08:00-20:00` allows Discord sends from 08:00 to 19:59. The Worker still fetches and queues outside that range. `00:00-24:00` is **invalid**. For 24-hour sends, leave the `NOTIFICATION_WINDOW_JST` Secret unset and use `null` in config.

Set a private Cloudflare delivery window using:

```sh
npx wrangler secret put NOTIFICATION_WINDOW_JST
```

Enter `08:00-20:00` (or your choice) into the prompt. Precedence: **dedicated Secret > window in private `MONITOR_CONFIG_JSON` > checked-in `targets.json`**.

[Config preflight reference](docs/CONFIG_PREFLIGHT.md).


### YouTube Data API key and default quota (optional)

YouTube RSS needs **no API key**. If you enable YouTube Data API v3 in Google Cloud and register your key as the **`YOUTUBE_API_KEY` Cloudflare Worker Secret**, all YouTube monitors using `videoType: "all"` (including the default) **automatically use the official Data API from their next eligible poll**. Failures are retried; the adapter does not silently fall back to RSS.

```sh
npx wrangler secret put YOUTUBE_API_KEY
```

`videoType: "videos"` intentionally **stays on the undocumented videos-only RSS** so it can exclude Shorts; the Data API exposes no equivalent Shorts classification flag. Per Google's current [quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost), the default shared daily quota for these read methods is **10,000 units/day**. Each poll of one channel uses `channels.list` (1 unit) + `playlistItems.list` (1 unit) = **2 units**. At 60-minute intervals, that's 48 units/channel/day or 240 units/day for five such channels (assuming the intended number of polls). Failed API requests still consume quota. The Cloud Console shows your actual quota allocation, usage, and reset.

Restrict the key's **allowed APIs to YouTube Data API v3**, keep it out of git, and do not paste it into public logs. RSS mode continues when no key is configured. For an optional *local read-only* API smoke test, privately export `YOUTUBE_API_KEY` and run `npm run smoke -- --monitor=ID` for an `all`-uploads monitor (no D1 access or Discord send). Check deployed Worker logs separately for actual runtime confirmation.

## 2. Deploy with Cloudflare Workers + D1

Follow this section **only** if choosing Cloudflare. GitHub Actions needs neither a Cloudflare account nor a D1 database.

**Prerequisites:** Node.js 22+, Cloudflare account, one or more Discord incoming webhooks, and your chosen monitors. Check your plan's applicable limits and prices.

### 2.1 Provision your own D1 and Worker

```sh
npx wrangler login
npx wrangler d1 create dopagaki-notify
npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID
npx wrangler d1 migrations apply dopagaki-notify --remote
```

Use your own D1 UUID. The committed [`wrangler.example.jsonc`](wrangler.example.jsonc) contains **only a dummy UUID**. `setup:cloudflare` generates a **gitignored, account-local `wrangler.jsonc`**. Keep `DB` as the binding name, and update local database/Worker names consistently if you customize them.

### Cloudflare Workers Builds (Git-based deployments)

The production `wrangler.jsonc` is **gitignored** so every account supplies its own D1 binding. For automatic deployment from a fork's `main`, configure your Worker's **Settings → Builds** before the first deployment:

- **Build environment variable:** `D1_DATABASE_ID` = your own D1 UUID
- **Build command:** `npm run setup:cloudflare -- "$D1_DATABASE_ID"`
- **Deploy command:** `npx wrangler deploy` (default)

The Build command works with both the older tracked-config setup and the new generated-config setup; existing deployments can test it before switching. The Build environment variable is distinct from deployed Worker runtime Secrets. A D1 UUID is a resource ID, not an API credential.

**Existing clones:** Back up the previously tracked `wrangler.jsonc` *before pulling this migration*. Git may remove that file. After updating, regenerate a gitignored local copy using `npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID` and restore any custom Worker name, D1 name or flags. Prior Git history still contains the previously committed UUID; changing a nonsecret D1 UUID does not by itself warrant rebuilding the database.

[Full migration instructions](docs/CLOUDFLARE_BINDING.md)

### 2.2 Configure Discord Secrets

Create a Discord incoming webhook for each destination, then configure the Cloudflare Secret matching the source:

| Source | Secret |
| --- | --- |
| Qiita | `DISCORD_WEBHOOK_QIITA` |
| Zenn | `DISCORD_WEBHOOK_ZENN` |
| arXiv | `DISCORD_WEBHOOK_ARXIV` |
| OpenAlex | `DISCORD_WEBHOOK_OPENALEX` |
| YouTube | `DISCORD_WEBHOOK_YOUTUBE` |
| Wikipedia | `DISCORD_WEBHOOK_WIKIPEDIA` |

```sh
npx wrangler secret put DISCORD_WEBHOOK_YOUTUBE
```

Repeat for enabled sources. Several monitors of the same source share one webhook and source-wide cooldown. Monitors without matching webhook Secrets remain dormant.

If enabling Wikipedia in a fork, set the ordinary Cloudflare Variable `WIKIMEDIA_CONTACT_URL` to **your own public contact URL**, such as the fork's GitHub URL. Do not identify the original author as the operator of your fork.

### 2.3 Deploy and verify

```sh
npm run config:check
npm run check
npm run deploy
npx wrangler tail dopagaki-notify --format pretty
```

`npm run deploy` invokes the config preflight. Direct `npx wrangler deploy` and Cloudflare Workers Builds **may bypass preflight**. GitHub CI cannot inspect the Secret values already deployed to Cloudflare.

The Worker has a monitoring Cron (`*/5 * * * *`) and receipt cleanup Cron (`10 * * * *`). Direct HTTP requests intentionally return 404; there is no public API.

Verify production D1 (read-only):

```sh
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id,initialized_at,last_complete_at,next_due_at FROM monitor_state ORDER BY id;"
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT monitor_id,item_id,status,sent_at FROM deliveries ORDER BY discovered_at DESC LIMIT 10;"
```

`initialized_at` / `last_complete_at` track completed upstream scans. A `sent` receipt means Discord accepted the webhook, **not** that it displayed remote images. No new content generally means no Discord message. YouTube may send its latest unseen upload on its first poll if it is within the configured retention horizon.

If Workers Builds is enabled, verify the deployed commit matches the branch you chose (**normally `main`**). A fork may deploy directly from `main` without creating a separate production branch. Separate branches are optional, not a prerequisite.

## 3. GitHub Actions + SQLite (optional)

[GitHub Actions](templates/github-actions/notifier.yml) is a **fully selectable alternative runtime** with the same sources, private subscriptions, weekday/windows, retention, optional API keys and webhook handling. SQLite state is stored as **encrypted Actions Artifacts**. Scheduled jobs can be delayed/skipped and Artifacts expire, so uptime/recovery guarantees differ from Cloudflare. **Select one runtime; running both against separate states causes duplicate notifications.**

```sh
# Private mode (default): keep subscriptions in Actions Secrets
npm run setup:actions -- --config-mode=private
npm run config:check -- --private-config-file=.private/monitor-config.json
gh auth login
gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json
gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt
```

Set the Actions repository Variable `MONITOR_CONFIG_MODE=private` (default). To use checked-in public targets instead, run `npm run setup:actions -- --config-mode=public`, set `gh variable set MONITOR_CONFIG_MODE --body public`, and remove the conflicting `MONITOR_CONFIG_JSON` Secret. Add the required `DISCORD_WEBHOOK_*` GitHub Actions Secrets. Then commit/push **only** the generated `.github/workflows/notifier.yml` and select **Actions → Discord notifier (SQLite) → Run workflow** to establish the initial state. Do **not** lose or rotate your state encryption key without a planned reset.


**Public Actions config:** `npm run setup:actions -- --config-mode=public`, edit public JSON, then `gh variable set MONITOR_CONFIG_MODE --body public`; remove any existing private `MONITOR_CONFIG_JSON` Secret. Private mode refuses to run without its Secret. Always review enabled monitor targets before activating either mode.

[GitHub Actions guide (English)](docs/GITHUB_ACTIONS.EN.md) · [日本語](docs/GITHUB_ACTIONS.md).

## Operations and troubleshooting

### If thumbnail images are not visible

Discord can hide embedded images in the client **even when the Worker sends a valid image URL and Discord's image proxy fetches it successfully**. First enable link preview images in Discord.

**Verified Japanese UI path:** **ユーザー設定 → テーマ → メッセージ → チャットにリンクが投稿されたとき → ON** (User Settings → Theme → Messages → When links are posted in chat). Exact English labels may vary with the Discord client version. After enabling it, revisit already-delivered Qiita, Zenn and YouTube notifications. This single client-side change restored all three providers' images in a real incident ([resolved issue #64](https://github.com/Nasu726/dopagaki-notify/issues/64)).

Only if the images are still missing, follow the [read-only diagnostics](#safe-diagnostic-commands) to check saved embeds and Discord's image proxy. Do not resend notifications, reset D1 or change image URLs as an initial troubleshooting step.

| Symptom | Check first |
| --- | --- |
| No Discord alert | Enabled target, `DISCORD_WEBHOOK_*` Secret, initial silent baseline, delivery hours |
| Upstream scan stalls | Cloudflare Logs, `last_complete_at` / `next_due_at`, current Secret validity |
| Shorts still sent | `videoType` + pinned `channelId`, complete private `MONITOR_CONFIG_JSON` override |
| Missing images | First [enable Discord's preview setting](#if-thumbnail-images-are-not-visible); inspect the saved embed only if images remain hidden |
| Secret fixed, webhook still blocked | Source-wide blocked state; see [runbook](docs/DEPLOYMENT.md) |

```sh
# Read-only configuration validation
npm run config:check
# Follow deployed Worker logs
npx wrangler tail dopagaki-notify --format pretty
# Fetch the disabled public Qiita example locally without sending or writing D1
npm run smoke -- --monitor=qiita-example
```

### Safe diagnostic commands

**Bring forward the production scan:** `npm run poll:request -- --monitor=qiita-example` previews guarded SQL. Add `--confirm-remote` to update only the selected monitor's D1 due time and request fetching on the **next Cron**; it does not run the Worker immediately or reset sent receipts. [Production polling guide](docs/PRODUCTION_POLL.md).

**One-off fetch:** `npm run smoke -- --monitor=ID` fetches a real snapshot **from your local machine**, not the deployed Cloudflare runtime. Default mode does not access D1 or send Discord messages. Both `--send-test --confirm-send` must be supplied to send one explicitly labeled `[TEST]` notification using your local webhook Secret. See [manual smoke guide](docs/MANUAL_SMOKE.md).

**Discord thumbnail investigation:** Supply the relevant private Discord webhook URL in `DISCORD_WEBHOOK_YOUTUBE`, `DISCORD_WEBHOOK_QIITA`, or `DISCORD_WEBHOOK_ZENN`, then inspect an **already delivered** notification. Qiita/Zenn use `--source=qiita|zenn` and `--probe-proxy`:

```sh
npm run inspect:discord -- --message-link="https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID" --probe-image --probe-proxy
```

The tool uses **GET only** (message and image probes); no notification replay or D1 writes. It reports saved `image` / `thumbnail`, Discord image-proxy presence and dimensions, with sanitized output. Never share the webhook URL or token. [Diagnostic guide](docs/DISCORD_THUMBNAIL_DIAG.md).


**If images do not render:** First check the [Discord preview setting](#if-thumbnail-images-are-not-visible). Queued Qiita/Zenn image persistence and Discord client image rendering are separate concerns. See [media reliability and migration guide](docs/IMAGE_RELIABILITY.md). An additive D1 migration enables source-media retention; the Worker keeps ordinary notification delivery working before it is applied.

## Development and design

```sh
npm install
npm run config:check
npm run check
npm run bundle:check
npm run dev
```

[Architecture](PROJECT_BRIEF.md) · [Roadmap/history](docs/ROADMAP.md) · [Detailed Cloudflare runbook](docs/DEPLOYMENT.md).

## License

[MIT](LICENSE) (Copyright (c) 2026 nasu). You may modify, redistribute and use commercially, retaining the copyright and license notice.
