# Queued article image metadata and Discord thumbnail diagnosis

Two distinct image problems are tracked as one troubleshooting workflow:

1. **Qiita/Zenn outbox metadata (Issue #58):** A source may provide an image at poll time, but the Discord delivery can happen on another Cron. Previously the D1 outbox retained only title/URL/time, so the original media could disappear.
2. **YouTube rendering (Issue #64):** Discord has accepted a video notification, but the external YouTube thumbnail is not visibly rendered. D1 storage changes **cannot** fix a Discord media proxy or client rendering failure.

## Zero-downtime migration for source image persistence

New additive schema: `migrations/0010_delivery_media.sql` adds nullable `deliveries.image_url` and `deliveries.thumbnail_url`. Staging Qiita/Zenn new items stores validated **public image URLs only**. No binaries or HTML are stored; HTTPS is required, insecure local/IP/credential URLs are rejected and unrecognized query parameters (such as signatures/tokens) are not persisted.

**Both pre-migration and post-migration Workers are supported.** If the columns are missing, the Worker safely falls back to the original outbox reads/writes instead of blocking notifications. This is a temporary compatibility path, not a reason to indefinitely skip migration. Changes never erase previously sent receipts. When the migration is applied, newly queued items retain their image across Cron/SQLite restores and webhook retries. Older queued items may still need the existing live RSS/OGP recovery.

Operator-only Cloudflare D1 migration (check before applying):

```sh
npx wrangler d1 migrations list dopagaki-notify --remote
npx wrangler d1 migrations apply dopagaki-notify --remote
npx wrangler d1 execute dopagaki-notify --remote --command "PRAGMA table_info(deliveries);"
```

Keep a normal monitored source active while verifying that no rows or receipts were reset. The pre-migration fallback exists precisely to prevent notification outages during auto-deploy / migration ordering.

## If an image is still invisible in Discord

**First** inspect the existing message rather than guessing which embed image field or CDN host to change. No new Discord messages or D1 writes:

```sh
npm run inspect:discord -- --message-link="https://discord.com/channels/GUILD/CHANNEL/MESSAGE" --probe-image --probe-proxy
```

This command requires the matching Discord Webhook URL in a **private local environment**. It prints sanitized image field presence, expected URL match, Discord proxy presence, image dimensions, embed suppression and source image HTTP status, never the webhook token or raw message.

Interpretation:
- Saved embed lacks an image: investigate payload generation or Discord ingestion.
- Saved image URL is correct but has no proxy/dimensions: investigate Discord media fetching.
- A valid proxy/dimensions exists but remains invisible: compare desktop/web/mobile client settings.
- The canonical source image request fails: investigate the URL/host/media before changing embeds.

A `deliveries.status = 'sent'` row proves only Discord webhook acceptance. Resolving #58 (persisting source media) does **not** establish #64's root cause or visual acceptance.

[Existing Discord diagnostic](DISCORD_THUMBNAIL_DIAG.md) · [manual smoke test](MANUAL_SMOKE.md).

## 2026-10-16: Zenn D1 URL persistence correction

Discord image previews for Qiita, Zenn, and YouTube are already working. The resolved display issue (#64) was a Discord client preference: **ユーザー設定 → テーマ → メッセージ → チャットにリンクが投稿されたとき → ON**. It is unrelated to D1 persistence.

The open durability issue (#58) was traced to a strict URL-persistence filter rejecting 20/20 live Zenn RSS enclosure URLs, despite the images displaying correctly at notification time. A read-only public-image check returned identical image bytes (SHA-256) for **20/20** Zenn Cloudinary originals and their query-free equivalents. In this production fix, only Zenn `https://res.cloudinary.com/zenn/image/upload/...` links with a single underscore-prefixed 2–4 character query key are reduced to their **query-free canonical URL before D1 insertion**. The removed query value is never stored. Unrecognized signed/private/multiple-key URLs and unrelated hosts remain rejected. Existing sent rows stay unchanged; only newly staged eligible article deliveries receive the canonical value.

**Deployment and follow-up:** The owner has already applied migration `0010_delivery_media.sql`. On a fresh Zenn notification after deploying this change, run this **read-only** D1 query and confirm `stored_images > 0` for one or more freshly staged items; no historical records need rewriting:

```sql
SELECT monitor_id, status, COUNT(*) AS total,
       SUM(image_url IS NOT NULL) AS stored_images
FROM deliveries
WHERE monitor_id LIKE 'zenn-%' AND discovered_at >= ?
GROUP BY monitor_id, status;
```

Replace `?` with the actual deployment timestamp in milliseconds. Zero new rows is inconclusive. The source RSS changes over time and old sent rows cannot prove the new staging path. Do not close #58 until post-deployment evidence arrives.
