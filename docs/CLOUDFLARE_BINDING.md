# Cloudflare D1 binding setup / D1バインディングの公開・非公開分離

## Why / 背景

D1 `database_id` is a **resource identifier**, not a password/API key. Knowledge of the UUID alone does not authorize access to the author's Cloudflare account or D1. However, shipping the author's real D1 ID as a fork default is unnecessary and error-prone.

The public repository tracks only `wrangler.example.jsonc` with a nonusable dummy UUID `00000000-0000-4000-8000-000000000000`. The production `wrangler.jsonc` is **generated per account** and **gitignored**. The example is for **offline build/dry-run** only: never deploy it.

## First-time installation (local deployment)

```sh
npm install
npx wrangler login
npx wrangler d1 create dopagaki-notify
npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID
npx wrangler d1 migrations apply dopagaki-notify --remote
npm run check
npm run deploy
```

`DB` is the required D1 binding name. Running setup again with the same UUID preserves the existing config. Supplying a different UUID refuses to overwrite the local binding—back up and remove the old generated config before switching. The generated file never appears in Git status.

For **read-only CI packaging checks** (no D1 credentials required):

```sh
npm run bundle:check
```

`npm run deploy` and `npm run dev` check that a local binding has been configured, rather than letting Wrangler deploy a Worker with an omitted D1.

## IMPORTANT: Existing Cloudflare Workers Builds users

Changing from a tracked production `wrangler.jsonc` to an ignored local file can **break automatic deployments unless you first configure the Build step**.

**Before merging the migration PR**: In the Cloudflare Dashboard, for the connected Worker, open **Settings → Builds** and set:

- Build environment variable `D1_DATABASE_ID` = your own Cloudflare D1 UUID.
- Build command: `npm run setup:cloudflare -- "$D1_DATABASE_ID"`.
- Deploy command: `npx wrangler deploy` (default).

This works with both the old and new versions of `ops/setup-cloudflare.mjs`. Validate a build while the old tracked config is still present. Once the PR is merged, Workers Builds runs the setup step in the ephemeral Build workspace and produces the correct local config before Wrangler deploys.

This Build environment variable is **different** from the runtime Worker Secrets registered via `wrangler secret put`. Build commands should not echo the variable's value.

When updating an existing local clone, **back up the old wrangler.jsonc before pulling**. Git may remove it since it was tracked. Re-run setup with your own UUID after pulling; restore custom names and flags if needed.

### Remaining historical exposure

The previous D1 identifier remains readable in **old public Git commits**, even after this change. This is not a security incident by itself, and rewriting public commit history (breaking existing clones and PRs) is disproportionate for a nonsecret resource identifier. If any actual API token, webhook token, database data or private information has leaked, rotate/revoke *that sensitive material* separately.

### What this does not do

This PR neither operates Cloudflare nor changes/erases the existing D1 instance. Existing deployed Workers keep running with their already deployed bindings until the next deployment. Forks using GitHub Actions + SQLite do not need any Cloudflare D1 setup.

## 日本語要約

- データベースUUIDはパスワードではなく、知っているだけで他人のD1を操作することはできません。
- `wrangler.example.jsonc` は公開用のダミー設定、`wrangler.jsonc` はローカル・Build環境で生成しGitには記録しません。
- Cloudflare Git連携を使っている場合、**先にBuild環境変数とBuild commandを準備した後でPRをマージ**します。
- Git履歴に過去のUUIDは残るものの、UUIDだけを理由としたDB再作成は通常不要です。
