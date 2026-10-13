# dopagaki-notify

**Qiita・Zenn・arXiv・YouTube の新着情報と、日本語 Wikipedia のおすすめ記事を Discord に届ける、シンプルな通知システムです。**

個人利用を前提とした小さな構成です。Web UI やログイン機能、常駐サーバーはありません。監視対象を JSON で設定し、Cloudflare Workers + D1 にデプロイすれば利用できます。好きな情報源を組み合わせて、フォーク先で自由にカスタマイズすることを想定しています。

**[English](README.EN.md)** · [詳細な運用資料](docs/DEPLOYMENT.md) · [設計資料](PROJECT_BRIEF.md) · [開発記録](docs/ROADMAP.md)

> **実装状況:** Cloudflare Workers 版が本体です。GitHub Actions は現在テスト用 CI のみで、定期通知を実行するワークフローは同梱していません。SQLite などの永続化層を追加すれば移植できる構造ですが、そのまま Actions を有効にするだけでは動作しません。

## できること

| 情報源 | 検出・通知内容 |
| --- | --- |
| Qiita | 検索条件に一致した最初の20件から、作成日時が新しい最大3件を候補にする |
| Zenn | ユーザー・トピック別 RSS の新しい最大3件を候補にする |
| arXiv | 指定カテゴリの新着論文をページ単位で取得する |
| YouTube | 指定チャンネルの RSS にある新着動画をすべて通知対象にする |
| 日本語 Wikipedia | 「秀逸な記事」から最大1件＋一定以上の長さのランダム記事を最大1件、おすすめする |

- 記事・動画の **ID で重複通知を抑止**し、初回の正常取得では過去の投稿を送信しません。
- 監視対象ごとに取得間隔を設定できます。YouTube は日本時間の曜日指定にも対応しています。
- Discord Webhook は **情報源ごとに1つ**使用します。送信は **日本時間 09:00〜19:59** に限定され、夜間に検出した新着は D1 に保存して後で送ります。
- 通信失敗や Discord のレート制限には、D1 に保持した再試行時刻・未送信キューで対応します。5分ごとの Cron は、1回につき原則1監視対象、Discord への送信は最大3件です。
- Qiita・Zenn は **最新を優先**して古い候補を意図的に見送ります。すべての記事を収集・保存するアーカイバーではありません。Qiita の検索結果は必ずしも新着順ではないため、最初の20件に含まれない記事は選べません。
- YouTube の RSS は掲載件数に上限があり、配信元から消えた動画や外部 API の停止中の投稿は取りこぼす可能性があります。

## 1. 監視対象を設定する

通常は次の2ファイルだけを編集します。

- [\`config/targets.json\`](config/targets.json): Qiita の検索式、Zenn のトピック・ユーザー、arXiv のカテゴリ、YouTube チャンネル、各対象の \`enabled\`。
- [\`config/intervals.json\`](config/intervals.json): 各 \`id\` に対応する **監視間隔(分)**。正の整数を指定します。

例:

\`\`\`json
{
  "qiita": [{ "id": "qiita-go", "query": "tag:Go", "enabled": true }],
  "zenn": [{ "id": "zenn-rust", "query": "topic:rust", "enabled": true }],
  "arxiv": [{ "id": "arxiv-ds", "categories": ["cs.DS"], "enabled": true }],
  "youtube": [{ "id": "youtube-example", "channel": "@example", "enabled": true, "weekdayJst": "sunday" }]
}
\`\`\`

対応する \`intervals.json\`:

\`\`\`json
{
  "qiita-go": 240,
  "zenn-rust": 240,
  "arxiv-ds": 120,
  "youtube-example": 60,
  "wikipedia-ja-discovery": 120
}
\`\`\`

この例は形式の説明です。ファイル全体を置き換える場合、不要な監視対象を削除して両ファイルの ID を一致させてください。曜日指定付き YouTube には間隔 \`60\` 分を指定します。Wikipedia の推薦は \`src/config.ts\` に定義され、通常の公開設定では有効です。

**重要:** 過去に使用した監視 ID の検索条件や情報源を変更しないでください。D1 が ID と条件の組を記憶しているため、既存 ID の条件変更は安全のため拒否されます。別の対象に切り替えるときは新しい ID を付けてください。間隔の変更だけなら同じ ID を使えます。

公開フォークに自分の興味・購読先を掲載したくない場合は、下記の **「設定を非公開にする」** を利用してください。GitHub 上の公開 JSON を編集する必要はありません。

## 2. Cloudflare Workers に導入する(対応済み)

**必要なもの:** Node.js 22 以上、Cloudflare アカウント、Discord の通知先チャンネルと Webhook。Cloudflare の利用枠と料金条件は事前に確認してください。

\`\`\`sh
git clone https://github.com/Nasu726/dopagaki-notify.git
cd dopagaki-notify
npm install
npm run check
npx wrangler login
\`\`\`

**① 自分の D1 データベースを作成**

\`\`\`sh
npx wrangler d1 create dopagaki-notify
\`\`\`

表示された **自分の** \`database_id\` を \`wrangler.jsonc\` の \`d1_databases[0].database_id\` に設定してください。リポジトリ内の ID は作者の環境の値であり、フォーク先ではそのまま使えません。必要に応じて Worker 名・D1 名も変更します。D1 のバインディング名 \`DB\` は維持してください。

**② D1 のマイグレーションを適用**

\`\`\`sh
npx wrangler d1 migrations apply dopagaki-notify --remote
\`\`\`

ここでの \`dopagaki-notify\` は作成した D1 名です。マイグレーションは \`migrations/\` に同梱されています。**クラウド上の D1 には \`--remote\` が必要**です。

**③ Worker をデプロイ**

\`\`\`sh
npm run deploy
\`\`\`

\`wrangler.jsonc\` に設定済みの Cron は、監視 \`*/5 * * * *\` と、送信済み履歴の整理 \`10 * * * *\` です。外部公開 HTTP エンドポイントはなく、アクセスしても意図的に 404 を返します。

**④ Discord Webhook を Secret に設定**

Discord で通知先の Webhook URL を発行し、利用する情報源に対応する Secret を登録します。

| 情報源 | Cloudflare Secret 名 |
| --- | --- |
| Qiita | \`DISCORD_WEBHOOK_QIITA\` |
| Zenn | \`DISCORD_WEBHOOK_ZENN\` |
| arXiv | \`DISCORD_WEBHOOK_ARXIV\` |
| YouTube | \`DISCORD_WEBHOOK_YOUTUBE\` |
| Wikipedia | \`DISCORD_WEBHOOK_WIKIPEDIA\` |

\`\`\`sh
npx wrangler secret put DISCORD_WEBHOOK_QIITA
\`\`\`

コマンドの入力待ちで Webhook URL を貼り付けます。使用する情報源について繰り返してください。Webhook は **Git に書かない**でください。Secret のない情報源は休止状態になります。同じ情報源内の複数監視対象は1つの Webhook と送信制限を共有します。

**⑤ 動作を確認**

初回の正常取得は無通知で基準化します。新着が無ければ Discord に何も届かないのが正常です。Cloudflare の Workers Logs を見るか、次のコマンドで監視できます。

\`\`\`sh
npx wrangler tail dopagaki-notify --format pretty
npx wrangler d1 execute dopagaki-notify --remote --command "SELECT id,initialized_at,last_complete_at,next_due_at FROM monitor_state ORDER BY id;"
\`\`\`

\`initialized_at\` が設定されれば、少なくとも初回の取得と基準化が成功しています。新着通知が来たら、Discord と D1 の \`deliveries\` の両方を確認してください。Cloudflare Workers Builds と GitHub を連携すれば、\`main\` の変更からデプロイする運用にもできます。

## 3. 設定を非公開にする(公開フォーク向け)

**フォークを公開したまま、個人の監視対象だけを非公開にする方法**に対応しています。

- 通常: 公開リポジトリの \`config/targets.json\` と \`config/intervals.json\` を使用します。
- **非公開モード**: Cloudflare Secret **\`MONITOR_CONFIG_JSON\`** が存在すれば、その内容で **全監視設定を置き換えます**。公開 JSON の設定とは混ぜません。
- Secret が不正なら処理をエラーにして停止します。**作者の公開設定に勝手に戻ることはありません。**

ローカルで雛形を作れます。

\`\`\`sh
mkdir -p .private
node ops/export-monitor-config.mjs > .private/monitor-config.json
\`\`\`

生成された \`.private/monitor-config.json\` を自分の好みに書き換えてください。\`.private/\` は \`.gitignore\` に登録されています。ファイル形式は以下のとおりで、\`targets\` と \`intervals\` は公開 JSON と同じです。Wikipedia が不要なら \`wikipediaEnabled: false\` とし、間隔設定からも省けます。

\`\`\`json
{
  "targets": {
    "qiita": [{ "id": "my-qiita-go", "query": "tag:Go", "enabled": true }],
    "zenn": [],
    "arxiv": [],
    "youtube": []
  },
  "intervals": { "my-qiita-go": 360 },
  "wikipediaEnabled": false
}
\`\`\`

内容を確認し、**公開リポジトリへコミットする前に** Cloudflare Dashboard の **Worker → Settings → Variables and Secrets** から \`MONITOR_CONFIG_JSON\` を **Secret** として保存します。あるいは \`npx wrangler secret put MONITOR_CONFIG_JSON\` で登録できます。ファイル全文を Secret の値として入力してください。デプロイ済み Worker の Secret 更新は新しい Worker バージョンのデプロイを伴うため、適用後のログを確認してください。

**公開を防ぐための注意:** \`wrangler.jsonc\` の D1 ID はパスワードではありませんが、作者の環境値を自分用に変更してください。Webhook URL、設定 Secret、D1 の配信履歴、公開したくないチャンネル ID や記事の内容はコミットしないでください。公開 GitHub Actions のログ、Issue、PR、公開 Discord チャンネルにも注意してください。すでにコミットした情報は、後で \`.gitignore\` に入れても公開履歴からは消えません。最も確実に非公開にしたい場合は **private リポジトリ**を利用してください。

## 4. GitHub Actions で実行したい場合(移植ガイド)

**現在の GitHub Actions は型検査・テスト・Wrangler のビルド確認用 CI です。定期通知の実行環境ではありません。**

Cloudflare 以外でも、\`src/runner.ts\` にある監視・重複排除・通知処理を再利用できます。ただし、GitHub-hosted runner は実行ごとに環境が作り直されるため、**SQLite の状態を実行間で永続化する仕組み**が必須です。

移植に必要なのは、(1) D1 用 \`Database\` インターフェースを Node.js の SQLite に接続するアダプタ、(2) \`migrations/\` による初期化、(3) 監視・履歴整理を呼び出すエントリポイント、(4) \`schedule\` / \`workflow_dispatch\` の YAML、(5) 永続的な DB 保管場所と同時実行制御、(6) GitHub Actions Secrets からの Webhook・非公開設定の読み込み、です。

GitHub の \`schedule\` は最短5分間隔ですが、実行が遅れたり省略されたりすることがあります。公開リポジトリでは活動が60日ないと定期実行が無効化される場合もあります。したがって **Cloudflare 版と同じ時間精度・耐障害性を自動的に得られるわけではありません**。公開リポジトリに SQLite DB や個人設定を書き戻す設計は避けてください。

現段階で簡単に動かしたいなら **Cloudflare Workers + D1 を推奨**します。GitHub Actions への移植は、通知ロジックを流用できるものの、別途バックエンド実装・テストが必要です。

## 運用・制約

- 送信開始時間は JST 09:00〜19:59。夜間も API の監視は続きます。
- arXiv はページ追跡しますが、Qiita・Zenn は最新優先で古い記事を追いません。Wikipedia のおすすめは候補からのサンプリングです。
- YouTube RSS は断続的に 404/500 を返す場合があります。RSS の404には最低60分の再試行間隔を設けています。
- Discord Webhook を交換した際、以前の認証失敗で停止していれば D1 の \`webhook_source_state\` のブロック解除が必要です。手順は [運用資料](docs/DEPLOYMENT.md) を参照してください。
- GitHub 上の CI 成功は、実際の通知や API の正常動作を保証しません。Workers の CPU・D1 使用量・通知内容は各自で監視してください。

## 開発・カスタマイズ

\`\`\`sh
npm install
npm run check
npm run bundle:check
npm run dev
\`\`\`

情報源を追加する場合は \`src/sources/\` と \`src/runner.ts\` を参照してください。詳細な経緯と内部設計は [PROJECT_BRIEF.md](PROJECT_BRIEF.md)・[docs/ROADMAP.md](docs/ROADMAP.md) に残しています。質問は Issue で受け付けられますが、Webhook URL・非公開の購読先・実運用の機密ログは投稿しないでください。

> **ライセンスに関する注意:** 現時点では明示的な \`LICENSE\` ファイルがありません。公開フォーク・再配布の条件を明確にするため、メンテナがライセンスを選定する必要があります。
