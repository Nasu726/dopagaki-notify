# dopagaki-notify

**好きな情報源の更新を、Discordにまとめて通知する小さなセルフホストツール。**

Qiita / Zenn / arXiv / OpenAlex / YouTube / 日本語Wikipediaに対応。Cloudflare Workers + D1で定期実行し、ログイン・Web画面・常駐PCは不要です。監視先を自由に選べます。

[English](README.EN.md) · [機能と制約](#機能と通知ルール) · [運用コマンド](#運用とトラブルシューティング) · [MIT License](LICENSE)

> **現在の状態:** Cloudflare Workers + D1が主な運用環境。GitHub Actions + SQLiteは任意のテンプレートで、定期実行と状態復元の信頼性はCloudflare版と同等ではありません。YouTubeのQuizKnock **通常動画専用RSS → Discord通知は本番で確認済み**。YouTubeのサムネイルはDiscordで表示されない事象があり、[Issue #64](https://github.com/Nasu726/dopagaki-notify/issues/64)で低優先度の調査待ちです。

## どこから始める？

| 目的 | 進む先 |
| --- | --- |
| 初めてCloudflareに導入する | [1. 監視対象を決める](#1-監視対象を決める) → [2. Cloudflareで動かす](#2-cloudflareで動かす) |
| 公開フォークでも購読先を隠したい | [非公開設定](#監視対象を非公開にする) |
| すでに稼働中で設定だけ変える | [設定の検査](#設定の検査と通知時間帯) → [運用](#運用とトラブルシューティング) |
| 今すぐ対象を試す・画像問題を調べる | [安全な診断コマンド](#安全な診断コマンド) |
| Cloudflareを使いたくない | [GitHub Actions + SQLite](#3-github-actions--sqliteを使う任意) |

**最短コマンド一覧** (リポジトリ直下・Node.js 22以上):

| コマンド | 用途 / 副作用 |
| --- | --- |
| `npm install` | 開発・実行に必要なパッケージ |
| `npm run config:check` | 公開設定とローカル環境の検証。通知・D1書込なし |
| `npm run check` | TypeScriptの型検査と自動テスト |
| `npm run deploy` | 事前設定チェック → **Cloudflare本番へデプロイ** |
| `npm run smoke -- --monitor=youtube-quizknock` | 今すぐ1回取得するだけ。Discord・D1変更なし |
| `npm run inspect:discord -- --help` | **既存**Discord通知の画像を読み取り専用で診断 |
| `npm run dev` | ローカルWorkerを起動 |

## 機能と通知ルール

| 情報源 | 監視するもの | 注意 |
| --- | --- | --- |
| Qiita | 検索条件に一致する記事 | API結果の先頭20件から新しい最大3件を選択 |
| Zenn | ユーザー・トピックRSS | 新しい最大3件を選択 |
| arXiv | 論文カテゴリ | ページ分割で追跡 |
| OpenAlex | 検索語・トピックID・著者ID | 直近7日・最大25件のスナップショット |
| YouTube | 指定チャンネルの動画 | 最新未通知動画は公開日が古くても通知対象 |
| 日本語Wikipedia | 秀逸記事＋ランダム記事 | 1回最大2件の推薦 |

**重要な動作:** 投稿IDで重複送信を抑止し、未送信分と再試行時刻をD1に記録します。YouTube以外は初回取得を原則無通知で初期化。YouTubeは最新の未通知動画1件を初回から通知対象にします。Qiita/Zennは鮮度を優先するため、全件保存・完全網羅ではありません。YouTubeの送信済みIDは繰り返し通知しないよう永続保持します (それ以外の通常送信済み履歴は原則10日)。

**スケジュール:** Workerは5分ごとに起動し、原則1回に1監視対象を処理します。監視対象ごとに設定した間隔は「実行可能になる時刻」であり厳密な実行保証ではありません。送信は1回最大3件。通知時間帯外でも**取得とキュー保存を継続**します。

**画像:** Qiita/ZennはRSS画像や記事OGP (Qiitaは投稿者アイコンへのフォールバックあり) を使用します。YouTubeは動画IDからサムネイルURLを生成しますが、現時点で**Discord上の表示は未解決**です。画像が無くてもタイトルとリンクを送ります。

## 1. 監視対象を決める

まず[このリポジトリをFork](https://github.com/Nasu726/dopagaki-notify/fork)してからcloneします。

```sh
git clone https://github.com/YOUR_USERNAME/dopagaki-notify.git
cd dopagaki-notify
npm install
```

設定方法は**公開JSON**か**Cloudflare Secretによる非公開設定**のどちらかです。

- [`config/targets.json`](config/targets.json): 監視対象と`enabled`、公開設定の`notificationWindowJst`。
- [`config/intervals.json`](config/intervals.json): 監視`id`ごとの取得間隔 (分)。正の整数。
- **公開フォークに個人の購読先を載せたくない場合は、次の「非公開設定」を選んでください。** 両方を混ぜるのではなく、Secretがあれば公開設定を**完全上書き**します。

設定例 (抜粋。実際の`targets.json`は対象となる全カテゴリを含みます):

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

`config/intervals.json`には上の各`id`の間隔と、Wikipediaを使う場合は`wikipedia-ja-discovery`の間隔を指定します。YouTubeで`weekdayJst`を指定する場合は間隔を60分にしてください。

**IDの互換性:** すでに稼働した監視`id`で、情報源や`query` / チャンネルを別の対象に変えないでください。D1が対象の識別情報を保持しており、意図しない履歴混在を拒否します。別の対象には新しい`id`を使います。間隔の変更は安全です。

**YouTubeでShortsを除外:** `"videoType": "videos"` と固定の`channelId`を指定すると、通常動画だけの非公式`UULF` RSSを使います (Shortsとライブ配信も除外)。省略・`"all"`は従来どおりすべてのアップロードを取得します。**このフィードはYouTubeの公式保証外**で、取得に失敗してもShorts混在フィードに無断で戻しません。現在の公開設定ではQuizKnockのみ`videos`。`YOUTUBE_API_KEY`を設定していても`videos`の監視はRSSを使用します。その他は任意の[YouTube Data API v3](https://developers.google.com/youtube/v3)に対応します。

**OpenAlex:** `search:graph algorithms`、`topic:T12345`、`author:A12345`に対応。APIキー`OPENALEX_API_KEY`は任意です。詳細は[運用資料](docs/DEPLOYMENT.md)。

### 監視対象を非公開にする

公開フォークで個人の購読先を隠したい場合、ローカルだけの無視対象ファイルを作ります。

```sh
mkdir -p .private
node ops/export-monitor-config.mjs > .private/monitor-config.json
```

`.private/monitor-config.json`の`targets`と`intervals`を編集し、`wikipediaEnabled`も確認してください。公開JSONを編集する必要はありません。ファイル全文をCloudflare WorkerのSecret **`MONITOR_CONFIG_JSON`** に登録します (Dashboard → Worker → Settings → Variables and Secrets)。

```sh
npm run config:check -- --private-config-file=.private/monitor-config.json
npx wrangler secret put MONITOR_CONFIG_JSON
```

最後のコマンドの対話入力で非公開JSONの全文を指定します。**SecretはGitHub・チャット・ログに貼らない**でください。Cloudflare Secretは一覧から元の値を読み出せません。変更前にローカルで検証してください。

### 設定の検査と通知時間帯

`npm run config:check`は公開設定と、現在のローカル環境に与えた非公開設定を本番と同じパーサーで検証します。ファイルで検査する場合:

```sh
npm run config:check -- --private-config-file=.private/monitor-config.json
npm run config:check -- --notification-window-file=.private/notification-window.txt
```

通知可能時間は日本時間の**開始含む・終了含まない**半開区間。例: `08:00-20:00`なら08:00から19:59まで送信し、それ以外は取得のみ続けます。`00:00-24:00`は**無効**です。24時間通知は`NOTIFICATION_WINDOW_JST`を未設定とし、設定JSONも`null`にしてください。

Cloudflare Secretを利用する場合は次のとおりです。

```sh
npx wrangler secret put NOTIFICATION_WINDOW_JST
```

対話入力に`08:00-20:00`などを指定してください。優先順位は**`NOTIFICATION_WINDOW_JST` Secret ＞ `MONITOR_CONFIG_JSON`内の値 ＞ 公開`targets.json`**です。

> **運用例:** このプロジェクトの実運用では、Cloudflare側のSecretを`08:00-20:00`に設定しています。ただし**公開リポジトリの既定値は`null` (24時間)**のままで、フォークには個人の設定は引き継がれません。

[検証方法とよくある設定ミス](docs/CONFIG_PREFLIGHT.md)

## 2. Cloudflareで動かす

**準備:** Node.js 22以上、Cloudflareアカウント、DiscordのWebhook、上で決めた監視対象。Cloudflareの無料枠・料金はご自身で確認してください。

### 2-1. 自分のD1とWorkerを準備

```sh
npx wrangler login
npx wrangler d1 create dopagaki-notify
npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID
npx wrangler d1 migrations apply dopagaki-notify --remote
```

`YOUR_D1_DATABASE_UUID`は**自分が作成した**D1のID。リポジトリの`wrangler.jsonc`にある値は元の作者環境用で、そのまま使わないでください。D1名/Worker名を変更する場合は以後のコマンドにも反映し、バインディング名`DB`は維持します。

### 2-2. DiscordのWebhookを登録

Discordで通知先Webhookを作成し、使う情報源ごとに**Cloudflare Secret**を設定します。

| 情報源 | Secret |
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

同じ情報源の複数監視は1つのWebhookと送信制限を共有します。Webhookが無い情報源は休止状態です。**必要なSecretを登録してから監視を始める**ようにしてください。

Wikipediaを使うフォークでは、APIアクセス時の連絡先として`WIKIMEDIA_CONTACT_URL`をCloudflareの通常Variableに指定してください。例: 自分の公開GitHubリポジトリのURL。元作者の連絡先を使い続けないでください。

### 2-3. デプロイ・動作確認

```sh
npm run config:check
npm run check
npm run deploy
npx wrangler tail dopagaki-notify --format pretty
```

`npm run deploy`は設定の事前検査を実行します。`npx wrangler deploy`を直接実行した場合やCloudflare Workers Buildsでは、この事前検査を通らない場合があります。CloudflareのSecret値まではGitHubのCIでは検証できません。

起動設定は監視`*/5 * * * *`、履歴整理`10 * * * *`。Workerへの通常HTTPアクセスは意図的に404を返します。

実際の本番D1を**読み取り専用**で確認します。

```sh
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id,initialized_at,last_complete_at,next_due_at FROM monitor_state ORDER BY id;"
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT monitor_id,item_id,status,sent_at FROM deliveries ORDER BY discovered_at DESC LIMIT 10;"
```

`initialized_at` / `last_complete_at`は最後の正常取得、`status=sent`はDiscord Webhookへの送信成功を示します。**画像が実際に描画された証拠にはなりません。** 投稿が無ければ通知が無いのは正常です。YouTubeのみ古い最新動画が初回に届く場合があります。

Cloudflare Workers Buildsを接続している場合は、デプロイ済みのバージョンと`main`が一致することも確認してください。

## 3. GitHub Actions + SQLiteを使う (任意)

Cloudflareの代わりに、GitHub Actions上でSQLiteを実行するテンプレートです。状態は暗号化したArtifactsに保存します。Cronの遅延・スキップやArtifact期限による制約があるため、**主な推奨環境はCloudflare版**です。

```sh
npm run setup:actions
npm run config:check -- --private-config-file=.private/monitor-config.json
gh auth login
gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json
gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt
```

使用する`DISCORD_WEBHOOK_*`をGitHub ActionsのSecretsにも登録した後、生成された`.github/workflows/notifier.yml`だけをcommit・pushし、GitHubの**Actions → Discord notifier (SQLite) → Run workflow**で初回実行します。初回は通常の情報源を無通知で初期化します。**状態鍵は紛失・変更しないこと。**

[GitHub Actions導入・復元手順](docs/GITHUB_ACTIONS.md) · [English](docs/GITHUB_ACTIONS.EN.md)

## 運用とトラブルシューティング

| 症状 | 最初に確認すること |
| --- | --- |
| Discordに何も来ない | 対象が`enabled`か、対応`DISCORD_WEBHOOK_*`があるか、初回基準化だけか、時間帯外か |
| 取得が進まない | Cloudflare Logs、`last_complete_at`と`next_due_at`、Secret設定の有効性 |
| Shortsが届く | YouTube対象の`videoType`と固定`channelId`、非公開`MONITOR_CONFIG_JSON`の上書き |
| 画像が見えない | 通知は維持し、下のDiscord画像診断で`proxy_url`/画像サイズを確認 |
| Webhookを更新しても送れない | 情報源ごとのブロック状態を確認。[運用資料](docs/DEPLOYMENT.md)参照 |

```sh
# 取得や送信はしない設定検査
npm run config:check
# 本番Workerの実行ログを見る
npx wrangler tail dopagaki-notify --format pretty
# ローカルで動作確認 (本番D1もDiscordも変更しない)
npm run smoke -- --monitor=youtube-quizknock
```

### 安全な診断コマンド

**手動取得:** `npm run smoke -- --monitor=ID` はその場で実際の情報源を1回取得しますが、**本番Cloudflare環境ではありません**。デフォルトでDiscord送信もD1変更も行いません。明示的な`--send-test --confirm-send`を**両方指定した場合のみ**、ローカル環境のWebhookで`[TEST]`通知を1件送信します。詳しくは[手動スモークテスト](docs/MANUAL_SMOKE.md)。

**Discord画像:** ローカルの非公開`DISCORD_WEBHOOK_YOUTUBE`を設定し、すでに届いたメッセージのリンクを渡します。

```sh
npm run inspect:discord -- --message-link="https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID" --probe-image
```

これは**既存メッセージのGETのみ**で、再送信しません。`thumbnail` / `image`、Discordの画像プロキシ、画像サイズを検査します。トークンやWebhook URLを共有しないでください。[画像診断手順](docs/DISCORD_THUMBNAIL_DIAG.md)。

## 開発・設計

```sh
npm install
npm run config:check
npm run check
npm run bundle:check
npm run dev
```

[構成・設計](PROJECT_BRIEF.md) · [開発履歴](docs/ROADMAP.md) · [詳細なCloudflare運用資料](docs/DEPLOYMENT.md)。

## ライセンス

[MIT](LICENSE) (Copyright (c) 2026 nasu)。改変・再配布・商用利用可。著作権表示とライセンス文面の保持が必要です。
