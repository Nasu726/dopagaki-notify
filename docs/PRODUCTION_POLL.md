# Trigger a production monitor early / 本番監視の前倒し

A Cloudflare Worker Cron is scheduled every five minutes and generally processes **one eligible monitor per invocation**. The next due time in D1 is a *deadline* (not a guaranteed execution time). **This command requests priority at the next Cron; it does not invoke the Worker immediately.**

## Preview safely (no network)

```sh
npm run poll:request -- --monitor=youtube-quizknock
```

It prints the guarded SQL and performs **no network access**, Discord send, or D1 write.

## Request the next available Cron (explicit remote D1 write)

Log in with Wrangler locally, then authorize the one-row update:

```sh
npx wrangler login
npm run poll:request -- --monitor=youtube-quizknock --confirm-remote
```

Use `--database=YOUR_DATABASE_NAME` if you renamed D1. The command requires an **initialized monitor** without an active lease, and only sets `next_due_at=0`. It preserves `initialized_at`, `last_complete_at`, source/query identity, deduplication receipts, and all pending retry records. It does **not** override delivery-hour restrictions or send Discord messages itself.

This is an intentional production database change, so do not run it automatically in public CI or on an untrusted monitor ID. Repeated requests may make a source poll more frequently than intended; use it only for diagnostics.

## Inspect outcome (read-only)

```sh
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id,initialized_at,last_complete_at,next_due_at FROM monitor_state WHERE id='youtube-quizknock';"
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT item_id,title,status,sent_at FROM deliveries WHERE monitor_id='youtube-quizknock' ORDER BY discovered_at DESC LIMIT 10;"
npx wrangler tail dopagaki-notify --format pretty
```

If `last_complete_at` advances, that scan succeeded. If `next_due_at` changes but `last_complete_at` does not, check Cloudflare Logs for failure/retry. If neither changes, the monitor may still be waiting behind another due monitor, lacking its webhook Secret, or failing the lease guard. An unchanged notification history is normal when there are no new eligible items.

**Images:** A `sent` receipt confirms Discord accepted the webhook, but does not establish that Discord rendered a thumbnail. For existing-message image inspection use [the read-only Discord diagnostic](DISCORD_THUMBNAIL_DIAG.md).

## 日本語メモ

`--confirm-remote`を付けた場合のみCloudflareのD1を1行更新し、次のCronでの取得を**予約**します。D1の初期化や通知済み履歴はリセットせず、Webhookも呼び出しません。実際のWorker実行とDiscord通知は別途ログで確認してください。
