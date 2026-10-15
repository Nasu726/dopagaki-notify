# Discord YouTube thumbnail diagnostic / サムネイル表示の原因切り分け

The Discord Webhook `wait=true` response indicates that a message was created, **not** that Discord's image proxy successfully fetched a remote thumbnail or that the client displayed it.

This operator-only CLI uses Discord's officially supported **Get Webhook Message** endpoint to read a *previously sent* YouTube notification. It makes **no posts**, changes no messages, and accesses no D1 records. All webhook credentials and raw message text are omitted from its output.

## 1. Prepare private credentials / 認証情報の取り扱い

Use the existing YouTube incoming webhook URL as a **local environment variable**. Do not paste it into chat, issues, screenshots, commands stored in shell history, or the repository. Cloudflare-managed Secrets cannot be read back from GitHub.

In bash/WSL, from the cloned repository:

```sh
read -rs -p "Private YouTube Discord webhook URL: " DISCORD_WEBHOOK_YOUTUBE
printf '\n'
export DISCORD_WEBHOOK_YOUTUBE
```

Obtain the link to the already-delivered QuizKnock message in Discord (right-click/long-press → Copy Message Link). No resend is needed.

## 2. Inspect one existing Discord message (read-only)

```sh
node ops/inspect-discord-embed.mjs --message-link="https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID"
```

Optionally check whether the YouTube image host can deliver the expected public JPEG **from this machine**:

```sh
node ops/inspect-discord-embed.mjs --message-link="https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID" --probe-image --probe-proxy
```

The optional `--probe-image` check issues a bounded HTTPS GET with a Range header against the fixed public `i.ytimg.com` thumbnail URL. `--probe-proxy` performs the same check against a strictly allowlisted Discord HTTPS image proxy URL **returned by the already-stored message**, without printing the full URL. Neither check follows redirects or sends a Discord message. Direct source success **does not** prove Discord proxy success; a proxy fetch that fails only from your local network does not establish a global Discord outage.

Run for both the first `#Shorts` alert and the newer ordinary video alert, then compare their results. Remove the credential from the current shell afterward:

```sh
unset DISCORD_WEBHOOK_YOUTUBE
```

The script prints only image field presence, public YouTube video ID, expected-URL match, proxy presence, dimensions, embed count, embed suppression flag, and optional image HTTP status/type. No webhook token, message text/title or full private URL is printed. A 404 may indicate the wrong Webhook, wrong message, a deleted message or an inaccessible thread.

## 3. Interpret the result / 判定表

| Observation | Interpretation |
|---|---|
| `embedCount=0` and `embedsSuppressed=true` | Discord message-level embed suppression |
| `embedCount=0`, flag false | Discord has no embed for this message; inspect webhook payload path and message origin |
| `thumbnail.present=false` and `image.present=false` | The image metadata was not saved in the message (not a proxy problem yet) |
| Image present but `matchesExpectedYouTubeUrl=false` | Unexpected/stale CDN URL or video ID association |
| Image present but proxy missing, or `width/height=0` | Discord media retrieval/metadata processing is a primary suspect |
| Image, proxy and positive dimensions all present, yet invisible | Prefer testing Discord desktop/web versus mobile and its Display/Chat image settings; could be client rendering/cache |
| `--probe-image` reports 404/nonimage | CDN URL / missing video thumbnail is a suspect |
| `--probe-image` reports 200/206 and `image/jpeg` | Source image is accessible from the operator's network, but Discord proxy may still fail |
| Source image succeeds, `--probe-proxy` reports an HTTP failure/nonimage | Discord proxy path or access is suspicious; compare with another client/network |
| Both source and Discord proxy report a valid image, but still invisible in UI | More likely a Discord client/cache/display-setting issue, not missing source media |

The next action depends on the **observed result**. Do not switch CDN hosts, retry/repost existing notifications, remove YouTube ID validation, or change D1 history before this test.

Discord reference: https://docs.discord.com/developers/resources/webhook (Get Webhook Message) and https://docs.discord.com/developers/resources/message (Embed and message flags).

## 日本語の要約

Discordの通知済みメッセージをGETするだけで、Discordが `thumbnail` / `image` のURLと `proxy_url`、画像の幅・高さを保持しているか調べます。通知を再送したりD1を更新したりしません。**Webhook URLは機密情報なので共有しないでください。** 取得された診断JSONのみ共有すれば、原因をさらに絞れます。

## Qiita / Zenn image diagnostic

This same read-only CLI can inspect previously sent Qiita and Zenn notifications with the corresponding private webhook. The webhook must be available locally; a Cloudflare runtime Secret cannot be read back from GitHub.

```sh
read -rs -p "Qiita webhook URL: " DISCORD_WEBHOOK_QIITA
printf '\n'
export DISCORD_WEBHOOK_QIITA
npm run inspect:discord -- --source=qiita --message-link="https://discord.com/channels/GUILD/CHANNEL/MESSAGE" --probe-proxy
unset DISCORD_WEBHOOK_QIITA
```

For Zenn use `DISCORD_WEBHOOK_ZENN` and `--source=zenn`. The output omits message text, titles, full image URLs, and webhook credentials. Inspect `image.present`, `thumbnail.present`, `proxyPresent`, width/height and `discordProxyImage`. `articleHost` and `matchesExpectedArticleHost` verify the expected publisher. The CLI deliberately does not fetch arbitrary article source images because those URLs are untrusted. `--probe-image` is only useful for YouTube; for Qiita/Zenn use `--probe-proxy`.

The additive D1 migration 0010 and Discord image rendering are distinct layers: the migration preserves safe image URLs across delayed deliveries but does not guarantee Discord displays them.
