# dopagaki-notify

**Qiita・Zenn・arXiv・YouTube の新着情報と、日本語 Wikipedia のおすすめ記事を Discord に届ける、シンプルな通知システムです。**

個人利用を前提とした小さな構成です。Web UI やログイン機能、常駐サーバーはありません。監視対象を JSON で設定し、Cloudflare Workers + D1 にデプロイすれば利用できます。好きな情報源を組み合わせて、フォーク先で自由にカスタマイズすることを想定しています。

**[English](README.EN.md)** · [詳細な運用資料](docs/DEPLOYMENT.md) · [設計資料](PROJECT_BRIEF.md) · [開発記録](docs/ROADMAP.md)

> **対応状況:** Cloudflare Workers + D1 は実運用されている標準版です。GitHub Actions + SQLite には、明示的に有効化する [実行テンプレート](templates/github-actions/notifier.yml) を用意しています。両者で監視・通知ロジックを共有しますが、Actions 版は実環境での長期検証前であり、実行時刻や状態保存の保証は同等ではありません。

## できること

| 情報源 | 検出・通知内容 |
| --- | --- |
| Qiita | 検索条件に一致した最初の20件から、作成日時が新しい最大3件を候補にする |
| Zenn | ユーザー・トピック別 RSS の新しい最大3件を候補にする |
| arXiv | 指定カテゴリの新着論文をページ単位で取得する |
| YouTube | 最新動画は公開日時が古くても未通知なら通知。通常の新着動画も通知。RSS または任意の公式 Data API に対応 |
| 日本語 Wikipedia | 「秀逸な記事」から最大1件＋一定以上の長さのランダム記事を最大1件、おすすめする |

- 記事・動画の **ID で重複通知を抑止**します。Qiita・Zenn・arXiv・Wikipedia は初回の正常取得では過去の投稿を送信しません。**YouTube だけは最新動画を公開日時にかかわらず未通知なら通知**します。既に初期化済みの監視も対象です。以降の新着動画も通知します。YouTube の送信済みIDだけは永続保存し、過去動画を何度も通知しないようにします。
- 監視対象ごとに取得間隔を設定できます。YouTube は日本時間の曜日指定にも対応しています。
- Discord Webhook は **情報源ごとに1つ**使用します。**既定では24時間通知**します。必要な人だけ送信可能な時間帯(JST)を設定できます。時間帯外でも監視を続け、未送信通知は D1 に保持します。
- 通信失敗や Discord のレート制限には、D1 に保持した再試行時刻・未送信キューで対応します。5分ごとの Cron は、1回につき原則1監視対象、Discord への送信は最大3件です。
- Qiita・Zenn は **最新を優先**して古い候補を意図的に見送ります。すべての記事を収集・保存するアーカイバーではありません。Qiita の検索結果は必ずしも新着順ではないため、最初の20件に含まれない記事は選べません。
- YouTube の RSS は掲載件数に上限があり、配信元から消えた動画や外部 API の停止中の投稿は取りこぼす可能性があります。取得失敗後でも、次回成功時に取得できた最新動画が未通知なら通知対象です。RSS が正しい動画を返さなかった場合まで検出を保証するものではありません。

## 1. 監視対象を設定する

通常は次の2ファイルだけを編集します。

- [`config/targets.json`](config/targets.json): Qiita の検索式、Zenn のトピック・ユーザー、arXiv のカテゴリ、YouTube チャンネル、各対象の `enabled`。
- [`config/intervals.json`](config/intervals.json): 各 `id` に対応する **監視間隔(分)**。正の整数を指定します。

例:

```json
{
  "qiita": [{ "id": "qiita-go", "query": "tag:Go", "enabled": true }],
  "zenn": [{ "id": "zenn-rust", "query": "topic:rust", "enabled": true }],
  "arxiv": [{ "id": "arxiv-ds", "categories": ["cs.DS"], "enabled": true }],
  "youtube": [{ "id": "youtube-example", "channel": "@example", "enabled": true, "weekdayJst": "sunday" }]
}
```

対応する `intervals.json`:

```json
{
  "qiita-go": 240,
  "zenn-rust": 240,
  "arxiv-ds": 120,
  "youtube-example": 60,
  "wikipedia-ja-discovery": 120
}
```

この例は形式の説明です。`config/targets.json` の `notificationWindowJst` は既定値 `null` (時間帯制限なし)です。ファイル全体を置き換える場合、不要な監視対象を削除して両ファイルの ID を一致させてください。曜日指定付き YouTube には間隔 `60` 分を指定します。Wikipedia の推薦は `src/config.ts` に定義され、通常の公開設定では有効です。

**重要:** 過去に使用した監視 ID の検索条件や情報源を変更しないでください。D1 が ID と条件の組を記憶しているため、既存 ID の条件変更は安全のため拒否されます。別の対象に切り替えるときは新しい ID を付けてください。間隔の変更だけなら同じ ID を使えます。

### 通知時間帯 (任意・既定は24時間)

`config/targets.json` に `"notificationWindowJst": null` を指定すると、時刻に関係なく通知します。制限したい場合だけ `"notificationWindowJst": "09:00-20:00"` のように設定します。**開始時刻を含み、終了時刻を含みません** (例では09:00〜19:59 JST)。`"22:00-06:00"` のように日付をまたぐ指定も可能です。開始と終了が同じ時刻の場合は無効な設定としてエラーにします。時間帯外でも API の取得は継続し、通知はキューに保持されます。

公開フォークで自分だけの時間帯を使う場合は、JSON を公開編集せず、次の Cloudflare Secret を設定するだけで上書きできます。

```sh
npx wrangler secret put NOTIFICATION_WINDOW_JST
```

入力する値の例: `09:00-20:00`。未登録なら無制限です。既存の `MONITOR_CONFIG_JSON` に `"notificationWindowJst": "09:00-20:00"` を追加しても構いません。**優先順位は時間帯専用 Secret → 非公開設定 JSON → 公開 `config/targets.json`** です。時間帯だけの変更なら D1 のマイグレーションや監視 ID の変更は不要です。

公開フォークに自分の興味・購読先を掲載したくない場合は、下記の **「設定を非公開にする」** を利用してください。GitHub 上の公開 JSON を編集する必要はありません。

### Wikipedia の User-Agent (フォーク利用者向け)

Wikipedia の API は自動アクセス元のアプリ名と、運用者へ連絡できる情報を User-Agent に含めるよう求めています。リポジトリにはアプリ名 `dopagaki-notify/0.1` と作者の連絡先が初期値として設定されていますが、**フォークして Wikipedia を有効にする場合は、運用者自身の連絡先に変更してください**。

Cloudflare Workers の **Settings → Variables and Secrets** で通常の Variable `WIKIMEDIA_CONTACT_URL` を追加し、値に `https://github.com/YOUR_USERNAME/dopagaki-notify` などの公開 HTTPS URL を指定します。メールアドレス・API キーは不要です。この値から `User-Agent` と `Api-User-Agent` の両方を自動構築します。

既存の作者環境では未設定でも元の連絡先が使われ、動作は変わりません。GitHub Actions 版は、指定が無い場合、自分のフォークの `GITHUB_REPOSITORY` から連絡先 URL を自動設定します。

### YouTube Data API を使う (任意)

YouTube は **何も設定しなければ従来の RSS** を使用します。RSS の 404/500 を避けたい場合、Google Cloud で YouTube Data API v3 を有効化し、API キーを発行して Cloudflare Workers の Secret `YOUTUBE_API_KEY` に登録してください。

```sh
npx wrangler secret put YOUTUBE_API_KEY
```

API キーがある場合は、`channels.list` でチャンネルの「アップロード済み」プレイリストを解決し、`playlistItems.list` で最大50件の動画を取得します。両 API はそれぞれ1クォータ単位です。API モードで失敗した場合は異常をログに残し、通常の再試行処理を適用します (RSS への無言のフォールバックはしません)。2方式は同じ動画IDと送信履歴を共有するため、切り替えても通常は二重通知しません。

**プライバシーと保存容量:** YouTube の送信済みIDは時間経過で削除せず永続保存します。これにより、古い最新動画の再通知を防止しますが、監視動画数に比例してD1/SQLiteに履歴が増えます。その他の情報源の送信済み履歴は従来どおり10日間です。

## 2. Cloudflare Workers に導入する(対応済み)

**必要なもの:** Node.js 22 以上、Cloudflare アカウント、Discord の通知先チャンネルと Webhook。Cloudflare の利用枠と料金条件は事前に確認してください。まず GitHub 上でこのリポジトリを Fork し、そのフォークを clone します。フォークせずローカルで試す場合は、元リポジトリを clone しても構いません。

```sh
git clone https://github.com/YOUR_USERNAME/dopagaki-notify.git
cd dopagaki-notify
npm install
npm run check
npx wrangler login
```

**① 自分の D1 データベースを作成**

```sh
npx wrangler d1 create dopagaki-notify
```

表示された **自分の** `database_id` を次のコマンドに渡すと、`wrangler.jsonc` に自動反映できます。

```sh
npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID
```

リポジトリ内の ID は作者の環境の値であり、フォーク先では使えません。Worker 名・D1 名を変更する場合は `wrangler.jsonc` の `name`・`database_name` も変更し、以降のコマンド中の D1 名もそれに合わせてください。バインディング名 `DB` は維持してください。

**② D1 のマイグレーションを適用**

```sh
npx wrangler d1 migrations apply dopagaki-notify --remote
```

ここでの `dopagaki-notify` は作成した D1 名です。マイグレーションは `migrations/` に同梱されています。**クラウド上の D1 には `--remote` が必要**です。

**③ Worker をデプロイ**

```sh
npm run deploy
```

`wrangler.jsonc` に設定済みの Cron は、監視 `*/5 * * * *` と、送信済み履歴の整理 `10 * * * *` です。外部公開 HTTP エンドポイントはなく、アクセスしても意図的に 404 を返します。

**④ Discord Webhook を Secret に設定**

Discord で通知先の Webhook URL を発行し、利用する情報源に対応する Secret を登録します。

| 情報源 | Cloudflare Secret 名 |
| --- | --- |
| Qiita | `DISCORD_WEBHOOK_QIITA` |
| Zenn | `DISCORD_WEBHOOK_ZENN` |
| arXiv | `DISCORD_WEBHOOK_ARXIV` |
| YouTube | `DISCORD_WEBHOOK_YOUTUBE` |
| Wikipedia | `DISCORD_WEBHOOK_WIKIPEDIA` |

```sh
npx wrangler secret put DISCORD_WEBHOOK_QIITA
```

コマンドの入力待ちで Webhook URL を貼り付けます。使用する情報源について繰り返してください。Webhook は **Git に書かない**でください。Secret のない情報源は休止状態になります。同じ情報源内の複数監視対象は1つの Webhook と送信制限を共有します。

**⑤ 動作を確認**

初回の正常取得では YouTube 以外は無通知で基準化します。**YouTube は最も新しい動画が未通知なら、初回に限らず通知**します。YouTube 以外は新着が無ければ Discord に何も届かないのが正常です。Cloudflare の Workers Logs を見るか、次のコマンドで監視できます。

```sh
npx wrangler tail dopagaki-notify --format pretty
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id,initialized_at,last_complete_at,next_due_at FROM monitor_state ORDER BY id;"
```

`initialized_at` が設定されれば、少なくとも初回の取得と基準化が成功しています。新着通知が来たら、Discord と D1 の `deliveries` の両方を確認してください。Cloudflare Workers Builds と GitHub を連携すれば、`main` の変更からデプロイする運用にもできます。

## 3. 設定を非公開にする(公開フォーク向け)

**フォークを公開したまま、個人の監視対象だけを非公開にする方法**に対応しています。

- 通常: 公開リポジトリの `config/targets.json` と `config/intervals.json` を使用します。
- **非公開モード**: Cloudflare Secret **`MONITOR_CONFIG_JSON`** が存在すれば、その内容で **全監視設定を置き換えます**。公開 JSON の設定とは混ぜません。
- Secret が不正なら処理をエラーにして停止します。**作者の公開設定に勝手に戻ることはありません。**

ローカルで雛形を作れます。

```sh
mkdir -p .private
node ops/export-monitor-config.mjs > .private/monitor-config.json
```

生成された `.private/monitor-config.json` を自分の好みに書き換えてください。`.private/` は `.gitignore` に登録されています。ファイル形式は以下のとおりで、`targets` と `intervals` は公開 JSON と同じです。Wikipedia が不要なら `wikipediaEnabled: false` とし、間隔設定からも省けます。

```json
{
  "targets": {
    "qiita": [{ "id": "my-qiita-go", "query": "tag:Go", "enabled": true }],
    "zenn": [],
    "arxiv": [],
    "youtube": []
  },
  "intervals": { "my-qiita-go": 360 },
  "wikipediaEnabled": false,
  "notificationWindowJst": null
}
```

内容を確認し、**公開リポジトリへコミットする前に** Cloudflare Dashboard の **Worker → Settings → Variables and Secrets** から `MONITOR_CONFIG_JSON` を **Secret** として保存します。あるいは `npx wrangler secret put MONITOR_CONFIG_JSON` で登録できます。ファイル全文を Secret の値として入力してください。デプロイ済み Worker の Secret 更新は新しい Worker バージョンのデプロイを伴うため、適用後のログを確認してください。

**公開を防ぐための注意:** `wrangler.jsonc` の D1 ID はパスワードではありませんが、作者の環境値を自分用に変更してください。Webhook URL、設定 Secret、D1 の配信履歴、公開したくないチャンネル ID や記事の内容はコミットしないでください。公開 GitHub Actions のログ、Issue、PR、公開 Discord チャンネルにも注意してください。すでにコミットした情報は、後で `.gitignore` に入れても公開履歴からは消えません。最も確実に非公開にしたい場合は **private リポジトリ**を利用してください。

## 4. GitHub Actions + SQLite で利用する(テンプレート)

Cloudflare を使用しない場合は、[GitHub Actions 通知テンプレート](templates/github-actions/notifier.yml) を利用できます。D1 の代わりに Node.js の SQLite を使用し、実行ごとの DB 状態を **AES-256-GCM で暗号化した Artifact** として保存します。GitHub 上に平文 DB や監視対象をコミットする必要はありません。

**セットアップの流れ:**

1. 公開または非公開のリポジトリにフォークし、ローカルで `npm install` を実行する。
2. `npm run setup:actions` で `.github/workflows/notifier.yml` と Git 管理対象外の汎用サンプル `.private/monitor-config.json`、暗号化鍵 `.private/notify-state-key.txt` を生成する。
3. 非公開の JSON を編集し、GitHub **Settings → Secrets and variables → Actions** に `MONITOR_CONFIG_JSON`、`NOTIFY_STATE_KEY` と利用する情報源の `DISCORD_WEBHOOK_*` を登録する。
4. **Secret 登録後**に `.github/workflows/notifier.yml` をコミット・push する。
5. GitHub の **Actions → Discord notifier (SQLite) → Run workflow** で初回の無通知基準化を行う。その後は10分ごとの定期実行に任せる。

鍵はセットアップ時に自動生成されます。GitHub CLI でログインした後、以下で値を標準出力へ表示せずに登録できます。

```sh
gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json
gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt
```

Webhook URL は別途登録してください。**鍵を失うと保存済みの状態を復元できません。** Secret・JSON・Webhook URL は Git にコミットしないでください。

Actions は実行時刻がずれることがあり、定期実行が欠落する場合もあります。また Artifact は保持期限があり、**すべての状態が失われた場合は自動で再初期化しない**ようにしています。手動で初期化する場合に限り、`Run workflow` の `reset_state` をオンにしてください。これは過去の送信履歴と未送信キューを破棄します。

**[GitHub Actions 版の詳しい設定・復旧手順](docs/GITHUB_ACTIONS.md)**

## 運用・制約

- **通知時間帯は既定で無制限(24時間)**です。任意設定 `notificationWindowJst` または `NOTIFICATION_WINDOW_JST` で制限できます。取得は時間帯と独立して続きます。
- arXiv はページ追跡しますが、Qiita・Zenn は最新優先で古い記事を追いません。Wikipedia のおすすめは候補からのサンプリングです。
- YouTube RSS は断続的に 404/500 を返す場合があります。RSS の404には最低60分の再試行間隔を設けています。
- Discord Webhook を交換した際、以前の認証失敗で停止していれば D1 の `webhook_source_state` のブロック解除が必要です。手順は [運用資料](docs/DEPLOYMENT.md) を参照してください。
- GitHub 上の CI 成功は、実際の通知や API の正常動作を保証しません。Workers の CPU・D1 使用量・通知内容は各自で監視してください。

## 開発・カスタマイズ

```sh
npm install
npm run check
npm run bundle:check
npm run dev
```

情報源を追加する場合は `src/sources/` と `src/runner.ts` を参照してください。詳細な経緯と内部設計は [PROJECT_BRIEF.md](PROJECT_BRIEF.md)・[docs/ROADMAP.md](docs/ROADMAP.md) に残しています。質問は Issue で受け付けられますが、Webhook URL・非公開の購読先・実運用の機密ログは投稿しないでください。

## ライセンス

[MIT License](LICENSE) (Copyright (c) 2026 nasu)。改変・再配布・商用利用が可能です。配布時には著作権表示とライセンス本文を含めてください。
