# GitHub Actions + SQLite 版 導入ガイド

**この方法は Cloudflare を使わず、GitHub-hosted runner 上で通知を実行します。** [日本語 README](../README.md) / [English guide](GITHUB_ACTIONS.EN.md)

現行の Cloudflare Workers 版と同じ `src/index.ts`・`src/runner.ts`・情報源アダプタを利用します。違いは DB への接続とジョブの起動方法です。Actions 版は自動テスト済みのオプションテンプレートであり、実運用での継続稼働は未検証です。

## 実行方式と設定公開範囲を選ぶ

このシステムは**Cloudflare Workers + D1**または**GitHub Actions + SQLite**のいずれかを選んで実行できます。両方式ともRSS/API連携、通知時間帯、YouTube曜日指定、監視対象ごとの`retentionDays`と非公開設定を共有します。ActionsにはCronの遅延・Artifact期限の制約があります。**両方式を同時に有効化すると別々のDBから通知され重複します。**

Actionsでの監視設定も明示的に選択します:

| 設定方式 | リポジトリVariable `MONITOR_CONFIG_MODE` | 監視設定 | 公開範囲 |
| --- | --- | --- | --- |
| **private (既定)** | `private`または未設定 | Actions Secret `MONITOR_CONFIG_JSON` | 購読先は非公開 |
| **public** | `public` | Git管理下の`config/targets.json` / `config/intervals.json` | 購読先がGitHub上に公開 |

**既定はprivateで、Secretが無ければ安全にエラー停止します。** publicモードに変更する際は既存の`MONITOR_CONFIG_JSON` Secretを削除します。混在を防ぐため、両方を残した設定は拒否します。切替時には過去の監視IDと検索条件を維持してください。公開後にPrivateに戻しても過去のGit履歴は消えません。

## 最初の設定

1. GitHub でリポジトリをフォークして clone し、Node.js 22 以上を用意。
2. `npm install`、`npm run check` を実行。
3. `npm run setup:actions` を実行。テンプレート `.github/workflows/notifier.yml`、汎用サンプル `.private/monitor-config.json`、32バイトの乱数鍵 `.private/notify-state-key.txt` を生成します。既存ファイル・鍵は上書きしません。
4. `.private/monitor-config.json` を編集。これは、公開用 `config/targets.json` と `config/intervals.json` をまとめたオブジェクトです。Wikipedia が不要なら `wikipediaEnabled: false` とし、その ID に対応する間隔も削除。監視 `id` と間隔は必ず整合させます。
5. GitHub の **Settings → Secrets and variables → Actions** で次の Secrets を追加:
   - **`MONITOR_CONFIG_JSON`** : 上記 JSON 全文
   - **`NOTIFY_STATE_KEY`** : セットアップで生成した `.private/notify-state-key.txt` の64桁16進数
   - **`DISCORD_WEBHOOK_QIITA` / `_ZENN` / `_ARXIV` / `_YOUTUBE` / `_WIKIPEDIA`** : 使用する情報源に対応する Discord Webhook URL
6. GitHub CLI があれば `gh auth login` 後、以下で設定を表示せずに2つの Secret を登録できます (Discord Webhook は別途登録してください)。

   ```sh
   gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json
   gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt
   ```
7. **Secrets の登録後**、`.github/workflows/notifier.yml` をコミットして push。テンプレートをコピーするまでは通知ワークフローが有効になりません。
8. GitHub の Actions タブから `Discord notifier (SQLite)` を選び **Run workflow** を1回実行。初回は原則として過去の記事を通知せず基準時刻を記録します。ただし YouTube を有効にしている場合、最初に取得できた最新動画1件を通知します。

定期実行は UTC の毎時07・17・27・37・47・57分 (10分間隔) に設定されています。実際の起動はベストエフォートです。**既定では通知時間帯に制限はありません**。個人設定だけで制限するには、`MONITOR_CONFIG_JSON` に `"notificationWindowJst": "09:00-20:00"` を追加するか、別の Actions Secret `NOTIFICATION_WINDOW_JST` に値 `09:00-20:00` を登録してください。時間帯の指定は JST、終了時刻は除外です。時間帯外にも取得・キュー保存は行われます。

Wikipedia を有効にした場合、API リクエストの User-Agent はフォーク先の `GITHUB_REPOSITORY` を連絡先として自動構築します。別の連絡先を使いたいときは GitHub Actions の **Variables** に `WIKIMEDIA_CONTACT_URL` (公開 HTTPS URL) を設定してください。Secret は不要です。

## 通知履歴の保存期間

Cloudflare版と同じ`retentionDays`設定を`MONITOR_CONFIG_JSON`の最上位に指定できます。監視ID単位で正の整数(1〜36500日)または`null`(無期限)を使います。省略時は通常10日、YouTubeは無期限。これは**暗号化Artifact自体の保持期限(テンプレートでは30日)**とは別です。短いArtifact期限を`retentionDays`で延長することはできません。

## 状態の保存とプライバシー

GitHub-hosted runner のローカルファイルは実行後に消えるため、Node.js `node:sqlite` で作成した DB を **AES-256-GCM で暗号化して** GitHub Actions Artifact `notifier-state` に保存します。次のジョブは最新の Artifact を復元し、復号して実行します。ローカルの平文 DB は Artifact に含めません。アップロード対象は暗号化済み `.private/notify-state.enc` の1ファイルのみです。`actions/upload-artifact@v4` が隠しディレクトリを通常除外するため、テンプレートでは `include-hidden-files: true` を指定しています。

次のチェックポイントのアップロードが成功した後に、以前の Artifact を削除します。アップロードが失敗した場合、旧 Artifact を残すので次回の再実行が可能です。失敗した監視処理でも、再試行時刻や未送信通知を保存した後に Artifact をアップロードします。

GitHub Actions のログは公開リポジトリでは第三者に見えるため、**Actions 版のログは意図的に簡略化**されています。監視ID、購読対象、通知内容を通常ログに出しません。一方、実行の失敗原因の調査は Cloudflare 版より難しくなります。暗号文の Artifact 自体も閲覧可能と想定し、**`NOTIFY_STATE_KEY` は GitHub Secret にしか登録しない**でください。鍵を紛失すると過去のチェックポイントを復号できません。

GitHub Actions Secret は定期実行で参照できます。フォーク後に、作者の Secrets が自動的に引き継がれることはありません。

## 障害対応

- **新着通知が来ない:** 初回は YouTube 以外ではサイレントです。YouTube は初回の最新動画1件が対象ですが、RSS が動画を返さない場合には通知できません。その後も新着が無ければ通知されません。Actions 実行結果と各 Secret の存在を確認。
- **State artifact missing:** 保存済み Artifact の保持期限切れ・削除・保存失敗が考えられます。勝手な再初期化はしません。復元できる別の Artifact が無いときは、必要性を理解した上で手動実行時の `reset_state: true` を選択します。
- **Decrypt error:** `NOTIFY_STATE_KEY` の値が変更されたか、Artifact が損傷しています。元の鍵を復元してください。鍵を再生成すると古い DB は復元できません。
- **Webhook 401/403/404/410:** Discord Webhook Secret を直し、保存済み SQLite DB の `webhook_source_state` 停止フラグも解除する必要があります。履歴のリセットで対処すると未送信の通知が失われます。
- **同時実行:** `concurrency` により1つのジョブしか状態を更新しません。ただし GitHub が待機ジョブを省略・置換する可能性はあります。
- **保持期限:** Artifact の保持はテンプレートでは30日です。定期的に成功している間は更新されますが、長期間実行しなければ期限切れで復元不能になる場合があります。
- **費用:** Actions 実行時間と Artifact ストレージが発生します。公開リポジトリと private リポジトリでは利用可能枠が異なります。実測して調整してください。

**重要:** GitHub Actions の `schedule` は遅延・欠落する可能性があり、公開リポジトリは60日間活動がないと定期実行が停止される場合があります。厳密な時刻や永続的なデータ保管が必要なら Cloudflare Workers + D1 の方が適しています。

## コード

- [テンプレート](../templates/github-actions/notifier.yml)
- [SQLite アダプタ](../ops/actions/sqlite.mjs)
- [状態の暗号化](../ops/actions/state-crypto.mjs)
- [Actions 起動処理](../ops/actions/run-once.mjs)
- [チェックポイント復元](../ops/actions/restore-state.sh)
- [テスト](../test/actions-template.test.ts)

変更の際は `npm run check` を実行してください。**Actions 版は Cloudflare 側の D1 と状態を共有しません。** 両方を並行稼働すると重複通知されるため、どちらか一方を稼働させることを推奨します。


## 任意の YouTube Data API

RSS の代わりに公式 API を使う場合は、Google Cloud で YouTube Data API v3 を有効にして API キーを作成し、GitHub Actions **Secret `YOUTUBE_API_KEY`** に設定してください。未設定なら従来どおり RSS を利用します。API モードでは `channels.list` と `playlistItems.list` を使用し、同じ動画ID・通知履歴を共有します。API の失敗は RSS に黙ってフォールバックせず再試行します。YouTube の送信済みIDは長期間経過しても重複通知しないよう、削除せず保管します。


## OpenAlex 対応

`.private/monitor-config.json` の `targets.openalex` に `{"id":"oa-graph","query":"search:graph algorithms","enabled":true}` を追加し、`intervals` にその ID に対応する監視間隔(分)を設定します。GitHub Actions **Secret `DISCORD_WEBHOOK_OPENALEX`** は必要です。**`OPENALEX_API_KEY` は任意の Secret** で、未設定なら API のキーなし利用枠を使用します。初回の検索結果は無通知で記録し、以降に見つかった新しいIDを通知します。対象は過去7日・最大25件です。

公開方式を選ぶ場合:

```sh
npm run setup:actions -- --config-mode=public
# config/targets.json と config/intervals.json を編集してから
npm run config:check
gh variable set MONITOR_CONFIG_MODE --body public
```

private方式を選ぶ場合:

```sh
npm run setup:actions -- --config-mode=private
npm run config:check -- --private-config-file=.private/monitor-config.json
gh variable set MONITOR_CONFIG_MODE --body private
gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json
```

どちらでも`NOTIFY_STATE_KEY`と使用情報源のWebhook Secretが必要です。セットアップは既存のワークフローファイルを上書きしないため、以前にコピーした`.github/workflows/notifier.yml`を使用中ならテンプレートの`MONITOR_CONFIG_MODE`環境変数を反映してください。
