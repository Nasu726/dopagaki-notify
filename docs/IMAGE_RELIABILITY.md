# Queued article image metadata and Discord thumbnail diagnosis

Two distinct image problems are tracked as one troubleshooting workflow:

1. **Qiita/Zenn outbox metadata (Issue #58):** A source may provide an image at poll time, but the Discord delivery can happen on another Cron. Previously the D1 outbox retained only title/URL/time, so the original media could disappear.
2. **Discord thumbnail display (Issue #64, resolved):** The images were present in Discord, including valid proxy URLs and dimensions, but the user's Discord client hid link-embedded images. Setting **ユーザー設定 → テーマ → メッセージ → チャットにリンクが投稿されたとき → ON** restored Qiita, Zenn and YouTube images. This was not a Worker or D1 defect.

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


## Source RSS/API media preflight (Issue #58)

To distinguish **upstream absent images**, **RSS parsing**, and **URL rejection before D1 persistence**, run this **read-only public-source diagnostic** locally. It makes exactly **one** HTTP request to the Qiita Items API or the selected Zenn RSS feed. It does not read or modify Cloudflare D1, SQLite state or Discord and needs no secrets:

```sh
npm run inspect:source-media -- --source=zenn --query=topic:typescript
npm run inspect:source-media -- --source=qiita --query=tag:Rust
```

Use the actual monitor's query, but **never share private queries**. The JSON reports only aggregate counts, not article titles, IDs, queries, source URLs, image URLs, response bodies or credentials.

- `entriesWithEnclosureTag`: count of Zenn RSS items containing an enclosure element; absent enclosures cannot be persisted from the RSS alone.
- `imageUrlsParsed` / `imageUrlsPersistable`: how many Zenn article images survived RSS parsing and strict public URL persistence validation.
- `enclosuresWithoutParsedImage`: enclosure tags whose image URLs were rejected during parsing or not extracted.
- `imageUrlsRejectedForPersistence`: safely parsed URLs excluded from D1, such as URL queries containing tokens or unknown parameters.
- `rejectionReasons`: sanitized histogram classifying rejection as `unapproved_query_key`, `unapproved_query_value`, `unsafe_image_url`, `image_fragment`, or invalid article/source. These categories use the same validation policy as production staging.
- `rejectedQueryKeys`: bounded histogram of simple non-sensitive rejected query *names only*, with auth/token/signature-like or arbitrary names reported as `[redacted]`. Query values and whole image URLs are never output. A nonempty unknown key is evidence for **investigation**, not permission to store signed/private URLs.
- `thumbnailUrlsParsed` / `thumbnailUrlsPersistable`: Qiita author-avatar fallback counts.
- `potentiallyTruncated`: source page might omit older entries; this is not an image failure.

**Observed production pattern (2026-10-16):** the `topic:typescript` feed returned 20/20 enclosure tags and 20/20 safely parsed images, but **0/20 passed the strict persistence filter**. Images nevertheless display correctly in Discord, recovered on the sending path. The remaining task is strictly queued-source URL retention, not image rendering. The detailed rejection histogram distinguishes a genuinely safe URL-format change from an intentionally excluded token/signature.

**Caveat:** the source feed changes over time. This preflight observes **current** feed entries only, not the contents of the feed when older D1 records were first staged. On the real D1 database use a **read-only** query to inspect rows staged after the migration:

```sql
SELECT monitor_id, status,
       COUNT(*) AS rows_count,
       SUM(image_url IS NOT NULL) AS stored_image_urls,
       SUM(thumbnail_url IS NOT NULL) AS stored_fallback_urls
FROM deliveries
WHERE (monitor_id LIKE 'qiita-%' OR monitor_id LIKE 'zenn-%')
  AND discovered_at >= unixepoch('2026-10-15 00:00:00') * 1000
GROUP BY monitor_id, status
ORDER BY monitor_id, status;
```

Replace the cutoff with the actual migration time if known. Newly staged data, rather than historical NULL rows, is needed to decide whether persistence is failing. Do not overwrite old sent receipts to retest media.

## If an image is still invisible in Discord

**First** check the Discord image-preview preference: **ユーザー設定 → テーマ → メッセージ → チャットにリンクが投稿されたとき → ON**. In the production investigation this alone fixed missing Qiita/Zenn/YouTube images. If images remain hidden, inspect the existing message instead of guessing which embed image field or CDN host to change. No new Discord messages or D1 writes:

```sh
npm run inspect:discord -- --message-link="https://discord.com/channels/GUILD/CHANNEL/MESSAGE" --probe-image --probe-proxy
```

This command requires the matching Discord Webhook URL in a **private local environment**. It prints sanitized image field presence, expected URL match, Discord proxy presence, image dimensions, embed suppression and source image HTTP status, never the webhook token or raw message.

Interpretation:
- Saved embed lacks an image: investigate payload generation or Discord ingestion.
- Saved image URL is correct but has no proxy/dimensions: investigate Discord media fetching.
- A valid proxy/dimensions exists but remains invisible: check Discord's link-preview toggle first, then compare desktop/web/mobile clients.
- The canonical source image request fails: investigate the URL/host/media before changing embeds.

A `deliveries.status = 'sent'` row proves only Discord webhook acceptance. Resolving #58 (persisting source media) does **not** establish #64's root cause or visual acceptance.

[Existing Discord diagnostic](DISCORD_THUMBNAIL_DIAG.md) · [manual smoke test](MANUAL_SMOKE.md).
