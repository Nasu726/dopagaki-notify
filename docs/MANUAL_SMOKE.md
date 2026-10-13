# Manual upstream and Discord smoke test (operator CLI)

**Scope:** This tool runs locally with Node 22+, not inside Cloudflare Workers. It does **not** inspect live Worker Secrets, D1 state, production scheduling or the actual Cloudflare egress path. A local successful fetch is not evidence of successful production delivery.

## Read-only default

Run from the checked-out repository:

```sh
node --experimental-strip-types ops/manual-smoke.mjs --monitor=youtube-quizknock
```

By default, the command fetches a single bounded upstream snapshot, checks YouTube channel identity using the same adapters as production, and reports up to 10 public IDs, publication timestamps and whether image metadata is available. It **never** sends Discord messages, writes to D1, changes leases, alters retry schedules or marks any item as delivered. It uses the public version-controlled target list when `MONITOR_CONFIG_JSON` is absent.

For private fork targets, supply `MONITOR_CONFIG_JSON` in a private local environment. If testing the official YouTube API path, supply `YOUTUBE_API_KEY` privately as well. Do not copy private configurations, API keys or webhook URLs to commands checked into shell history, public CI logs, issues or chat. Source errors are redacted by the diagnostics layer.

## Optional explicitly authorized Discord send

Provide the matching `DISCORD_WEBHOOK_<SOURCE>` as a private environment variable, then run:

```sh
node --experimental-strip-types ops/manual-smoke.mjs --monitor=youtube-quizknock --send-test --confirm-send
```

This sends **one** embed with a `[TEST]` title. No database or delivery receipts are written, so the ordinary production dispatcher may later send that same real video as a normal notification. The operator must explicitly supply **both** flags. Never place this command in an automatically scheduled public workflow.

## Confirm the actual Cloudflare deployment separately

Inspect Cloudflare's Worker deployment/version and Observability logs, then run *read-only* SQL from a private, authenticated Wrangler shell:

```sh
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id,initialized_at,last_complete_at,next_due_at FROM monitor_state WHERE id='youtube-quizknock';"
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT item_id,status,sent_at FROM deliveries WHERE monitor_id='youtube-quizknock' ORDER BY discovered_at DESC LIMIT 10;"
```

To claim real end-to-end success, require a successful Cloudflare fetch, the correct public video ID, the intended Discord message, and a `sent` D1 receipt. A local dry run or GitHub CI is insufficient.

## 日本語の要点

デフォルトは **取得と診断のみ** で、Discord通知もD1変更も行いません。明示的に `--send-test --confirm-send` の両方を指定したときだけ `[TEST]` 表記の通知を1件送信します。これはローカル環境での診断であり、Cloudflare本番の正常動作確認にはなりません。本番ではCloudflare LogsとD1の送信履歴を別途確認してください。
