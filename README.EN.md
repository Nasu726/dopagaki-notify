# dopagaki-notify

**A small, self-hosted Discord notifier for the sources you follow.**

Monitor Qiita, Zenn, arXiv, OpenAlex, YouTube and Japanese Wikipedia using Cloudflare Workers + D1. No web UI, app login, or always-running personal computer. Configure your own subscriptions and run it in your account.

[日本語](README.md) · [Features & delivery policy](#features-and-delivery-policy) · [Commands](#operations-and-troubleshooting) · [MIT License](LICENSE)

> **Status:** Cloudflare Workers + D1 is the primary, production-used runtime. GitHub Actions + SQLite is an optional template and does not have equivalent scheduling or state-restoration guarantees. QuizKnock's **regular-video-only RSS → Discord** delivery has been verified in production. YouTube thumbnails currently fail to render in Discord and are a non-blocking, [deferred issue (#64)](https://github.com/Nasu726/dopagaki-notify/issues/64).

## Choose your path

| Goal | Start here |
| --- | --- |
| First deployment with Cloudflare | [1. Choose monitors](#1-choose-your-monitors) → [2. Deploy with Cloudflare](#2-deploy-with-cloudflare) |
| Keep personal subscriptions private in a public fork | [Private monitor configuration](#keep-your-monitors-private) |
| Change settings on an existing deployment | [Preflight and delivery hours](#validate-settings-and-choose-delivery-hours) |
| Test a source immediately or diagnose images | [Safe diagnostic commands](#safe-diagnostic-commands) |
| Run without Cloudflare | [GitHub Actions + SQLite](#3-github-actions--sqlite-optional) |

**Command reference** (repository root, Node.js 22+):

| Command | Purpose / side effects |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run config:check` | Validate local configuration; no sends or D1 writes |
| `npm run check` | TypeScript typecheck and all tests |
| `npm run deploy` | Config preflight, then **deploy production Worker** |
| `npm run smoke -- --monitor=youtube-quizknock` | Fetch one upstream snapshot; no D1 or Discord changes |
| `npm run inspect:discord -- --help` | Read-only diagnostics for an **existing** Discord message |
| `npm run dev` | Start the local development Worker |

## Features and delivery policy

| Source | What is monitored | Coverage |
| --- | --- | --- |
| Qiita | Articles matching search queries | Newest three from the first 20 API results |
| Zenn | User/topic RSS feeds | Newest three items |
| arXiv | Research paper categories | Bounded paginated scans |
| OpenAlex | Search terms, topic IDs, author IDs | Last seven days, at most 25 results |
| YouTube | Chosen video channels | The latest unseen video is eligible even if old |
| Japanese Wikipedia | Featured and random articles | Up to two recommendations per poll |

**Deduplication:** D1 stores notification receipts, pending deliveries and retry times. Most sources establish a **silent baseline** on their first successful fetch. YouTube exceptionally sends its newest unseen video even on the first poll, regardless of publication age. YouTube sent IDs persist indefinitely; ordinary sent receipts for other sources normally expire after ten days. Qiita and Zenn favor freshness over exhaustive archiving.

**Scheduling:** The Worker runs every five minutes and normally handles one due monitor per invocation. Per-monitor intervals indicate when a fetch becomes eligible, not an exact execution time. It sends at most three items per invocation. Polling and queuing continue **outside allowed notification hours**.

**Images:** Qiita and Zenn can show RSS/OGP images (Qiita may fall back to author avatar). YouTube generates a thumbnail URL from the video ID, but **its rendering in Discord is still unresolved**. Missing images never block title/link delivery.

## 1. Choose your monitors

[Fork this repository](https://github.com/Nasu726/dopagaki-notify/fork), then clone your fork:

```sh
git clone https://github.com/YOUR_USERNAME/dopagaki-notify.git
cd dopagaki-notify
npm install
```

Choose **checked-in public JSON** or a **private Cloudflare Secret**:

- [`config/targets.json`](config/targets.json): Sources, targets, `enabled` flags, and the public `notificationWindowJst`.
- [`config/intervals.json`](config/intervals.json): Positive integer intervals **in minutes**, keyed by monitor `id`.
- A private `MONITOR_CONFIG_JSON` **replaces the whole public roster**; it does not merge with it. Use it when subjects should not appear in your public fork.

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
  "notificationWindowJst": null
}
```

Provide intervals for the IDs above and for `wikipedia-ja-discovery` if using the standard Wikipedia monitor. Weekday-restricted YouTube monitors (`weekdayJst`) require an interval of 60 minutes.

**Monitor identity:** Do not reuse an existing `id` for a different provider/query/channel. D1 pins it to its original source/query identity to protect historical receipts. For a changed subject, create a new `id`. Changing intervals is safe.

**Exclude YouTube Shorts:** Set `"videoType": "videos"` **and a pinned `channelId`** to use the undocumented `UULF` RSS playlist for regular videos only (also excludes live streams). Omitted or `"all"` means all uploads. This URL is **not an officially supported YouTube API contract**; if it fails, the monitor does **not** silently fall back to a Shorts-inclusive feed. Only QuizKnock opts in in the checked-in sample. Videos-only monitors use RSS even if `YOUTUBE_API_KEY` is present; other YouTube monitors can use the optional [YouTube Data API v3](https://developers.google.com/youtube/v3).

**OpenAlex:** Query formats are `search:graph algorithms`, `topic:T12345`, `author:A12345`. Optional `OPENALEX_API_KEY` increases API allowance. See the [deployment runbook](docs/DEPLOYMENT.md) for details.

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

Paste the JSON content in the interactive Secret prompt. **Never post secrets or private subscriptions in source control, chat, issues or CI logs.** Deployed Cloudflare Secrets cannot be read back, so verify the intended value locally before setting it.

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

> **Operator-specific example:** The project's current production Cloudflare Secret is `08:00-20:00`. The **checked-in default is still `null` (unrestricted, 24-hour sending)** and forks do not inherit the operator's Secret.

[Config preflight reference](docs/CONFIG_PREFLIGHT.md).

## 2. Deploy with Cloudflare

**Prerequisites:** Node.js 22+, Cloudflare account, one or more Discord incoming webhooks, and your chosen monitors. Check your plan's applicable limits and prices.

### 2.1 Provision your own D1 and Worker

```sh
npx wrangler login
npx wrangler d1 create dopagaki-notify
npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID
npx wrangler d1 migrations apply dopagaki-notify --remote
```

Use the **new UUID from your own account**, not the original developer's database ID in `wrangler.jsonc`. Change the Worker/D1 name in subsequent commands if you rename them, but keep the D1 binding named `DB`.

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

`initialized_at` / `last_complete_at` track completed upstream scans. A `sent` receipt means Discord accepted the webhook, **not** that it displayed remote images. No new content generally means no Discord message. YouTube can send one older latest unseen upload on its first poll.

If Workers Builds is enabled, verify the live deployment is actually the intended `main` revision.

## 3. GitHub Actions + SQLite (optional)

The alternative [GitHub Actions template](templates/github-actions/notifier.yml) runs on GitHub-hosted runners with SQLite state stored in **encrypted Actions Artifacts**. Scheduled workflows can be delayed/skipped and state artifacts can expire; Cloudflare is the primary recommendation.

```sh
npm run setup:actions
npm run config:check -- --private-config-file=.private/monitor-config.json
gh auth login
gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json
gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt
```

Add the required `DISCORD_WEBHOOK_*` GitHub Actions Secrets. Then commit/push **only** the generated `.github/workflows/notifier.yml` and select **Actions → Discord notifier (SQLite) → Run workflow** to establish the initial state. Do **not** lose or rotate your state encryption key without a planned reset.

[GitHub Actions guide (English)](docs/GITHUB_ACTIONS.EN.md) · [日本語](docs/GITHUB_ACTIONS.md).

## Operations and troubleshooting

| Symptom | Check first |
| --- | --- |
| No Discord alert | Enabled target, `DISCORD_WEBHOOK_*` Secret, initial silent baseline, delivery hours |
| Upstream scan stalls | Cloudflare Logs, `last_complete_at` / `next_due_at`, current Secret validity |
| Shorts still sent | `videoType` + pinned `channelId`, complete private `MONITOR_CONFIG_JSON` override |
| Missing images | Keep notifications working; inspect Discord's saved embed and proxy metadata |
| Secret fixed, webhook still blocked | Source-wide blocked state; see [runbook](docs/DEPLOYMENT.md) |

```sh
# Read-only configuration validation
npm run config:check
# Follow deployed Worker logs
npx wrangler tail dopagaki-notify --format pretty
# Fetch one source locally without sending or writing D1
npm run smoke -- --monitor=youtube-quizknock
```

### Safe diagnostic commands

**Bring forward the production scan:** `npm run poll:request -- --monitor=youtube-quizknock` previews guarded SQL. Add `--confirm-remote` to update only the selected monitor's D1 due time and request fetching on the **next Cron**; it does not run the Worker immediately or reset sent receipts. [Production polling guide](docs/PRODUCTION_POLL.md).

**One-off fetch:** `npm run smoke -- --monitor=ID` fetches a real snapshot **from your local machine**, not the deployed Cloudflare runtime. Default mode does not access D1 or send Discord messages. Both `--send-test --confirm-send` must be supplied to send one explicitly labeled `[TEST]` notification using your local webhook Secret. See [manual smoke guide](docs/MANUAL_SMOKE.md).

**Discord thumbnail investigation:** Supply the private `DISCORD_WEBHOOK_YOUTUBE` to your local environment, then inspect the **link of an already delivered** Discord notification:

```sh
npm run inspect:discord -- --message-link="https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID" --probe-image
```

The tool uses **GET only**; no notification replay or D1 writes. It reports saved `image` / `thumbnail`, Discord image-proxy presence and dimensions, with sanitized output. Never share the webhook URL or token. [Diagnostic guide](docs/DISCORD_THUMBNAIL_DIAG.md).

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
