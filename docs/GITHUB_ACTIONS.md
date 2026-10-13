# GitHub Actions + SQLite 版 導入ガイド

**この方法は Cloudflare を使わず、GitHub-hosted runner 上で通知を実行します。** [日本語 README](../README.md) / [English guide](GITHUB_ACTIONS.EN.md)

現行の Cloudflare Workers 版と同じ `src/index.ts`・`src/runner.ts`・情報源アダプタを利用します。違いは DB への接続とジョブの起動方法です。Actions 版は自動テスト済みのオプションテンプレートであり、実運用での継続稼働は未検証です。

## 最初の設定

1. GitHub でリポジトリをフォークして clone し、Node.js 22 以上を用意。
2. `npm install`、`npm run check` を実行。
3. `npm run setup:actions` を実行。コピー先は `.github/workflows/notifier.yml`、購読設定は `.private/monitor-config.json`。どちらも既存ファイルは上書きしません。
4. `.private/monitor-config.json` を編集。これは、公開用 `config/targets.json` と `config/intervals.json` をまとめたオブジェクトです。Wikipedia が不要なら `wikipediaEnabled: false` とし、その ID に対応する間隔も削除。監視 `id` と間隔は必ず整合させます。
5. GitHub の **Settings → Secrets and variables → Actions** で次の Secrets を追加:
   - **`MONITOR_CONFIG_JSON`** : 上記 JSON 全文
   - **`NOTIFY_STATE_KEY`** : `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"` で生成した64桁16進数
   - **`DISCORD_WEBHOOK_QIITA` / `_ZENN` / `_ARXIV` / `_YOUTUBE` / `_WIKIPEDIA`** : 使用する情報源に対応する Discord Webhook URL
6. 必要に応じて `gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json` を使用できます。GitHub CLI は事前に `gh auth login` が必要です。
7. **Secrets の登録後**、`.github/workflows/notifier.yml` をコミットして push。テンプレートをコピーするまでは通知ワークフローが有効になりません。
8. GitHub の Actions タブから `Discord notifier (SQLite)` を選び **Run workflow** を1回実行。初回は過去の記事・動画を通知せず基準時刻を記録します。

定期実行は UTC の毎時07・17・27・37・47・57分 (10分間隔) に設定されています。実際の起動はベストエフォートです。送信時間帯は Cloudflare 版と共通の **日本時間09:00〜19:59** で、Cron 側の5分間隔より多少遅くなります。

## 状態の保存とプライバシー

GitHub-hosted runner のローカルファイルは実行後に消えるため、Node.js `node:sqlite` で作成した DB を **AES-256-GCM で暗号化して** GitHub Actions Artifact `notifier-state` に保存します。次のジョブは最新の Artifact を復元し、復号して実行します。ローカルの平文 DB は Artifact に含めません。

次のチェックポイントのアップロードが成功した後に、以前の Artifact を削除します。アップロードが失敗した場合、旧 Artifact を残すので次回の再実行が可能です。失敗した監視処理でも、再試行時刻や未送信通知を保存した後に Artifact をアップロードします。

GitHub Actions のログは公開リポジトリでは第三者に見えるため、**Actions 版のログは意図的に簡略化**されています。監視ID、購読対象、通知内容を通常ログに出しません。一方、実行の失敗原因の調査は Cloudflare 版より難しくなります。暗号文の Artifact 自体も閲覧可能と想定し、**`NOTIFY_STATE_KEY` は GitHub Secret にしか登録しない**でください。鍵を紛失すると過去のチェックポイントを復号できません。

GitHub Actions Secret は定期実行で参照できます。フォーク後に、作者の Secrets が自動的に引き継がれることはありません。

## 障害対応

- **新着通知が来ない:** 最初の取得は必ずサイレントです。その後も新着が無ければ通知されません。Actions 実行結果と各 Secret の存在を確認。
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
