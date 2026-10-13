# GitHub Actions + SQLite deployment guide

**Run dopagaki-notify without a Cloudflare account.** [English README](../README.EN.md) / [日本語ガイド](GITHUB_ACTIONS.md).

This opt-in template reuses the same monitoring, scheduling and Discord delivery code as the Cloudflare edition. It substitutes local Node.js SQLite for D1 and GitHub Actions for Cron Triggers. Integration tests are included, but it has not yet been proven over long-running production use.

## Setup

1. Fork and clone the repository, install Node.js 22+, and run `npm install` and `npm run check`.
2. Run `npm run setup:actions`. It copies the workflow template, creates a gitignored generic `.private/monitor-config.json` and generates a random `.private/notify-state-key.txt`. Existing files and keys are never overwritten.
3. Edit the private JSON to your desired targets and intervals. Remove unwanted sources, keep every target ID matched to an interval, and set `wikipediaEnabled: false` (and remove its interval) if not wanted.
4. Open **Settings → Secrets and variables → Actions** in your fork and create:
   - `MONITOR_CONFIG_JSON`: the full contents of the private JSON file.
   - `NOTIFY_STATE_KEY`: the 64 hex characters in the generated `.private/notify-state-key.txt`. Keep this key unchanged.
   - The relevant `DISCORD_WEBHOOK_QIITA`, `DISCORD_WEBHOOK_ZENN`, `DISCORD_WEBHOOK_ARXIV`, `DISCORD_WEBHOOK_YOUTUBE`, `DISCORD_WEBHOOK_WIKIPEDIA` URLs.
5. With GitHub CLI, run `gh auth login`, then `gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json` and `gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt`. Set the Discord webhook Secrets separately.
6. **After secrets are in place**, commit and push `.github/workflows/notifier.yml`. The template in `templates/` is inert until copied into your workflows directory.
7. Under **Actions → Discord notifier (SQLite)** select **Run workflow** once. This creates an initial silent baseline for non-YouTube sources. For YouTube, the latest available video is eligible for notification immediately, even if previously published.

The template schedules runs at UTC minutes 07, 17, 27, 37, 47 and 57 (every 10 minutes, best effort). **Delivery is unrestricted by default**. Optionally set `notificationWindowJst` to `"09:00-20:00"` in `MONITOR_CONFIG_JSON`, or register `NOTIFICATION_WINDOW_JST` as an Actions Secret containing `09:00-20:00`; the dedicated Secret takes precedence. Times are JST with an exclusive end. Source polling continues outside the optional delivery window.

When Wikipedia is enabled, the Wikimedia User-Agent defaults to the current fork's `GITHUB_REPOSITORY` as its operator contact. To use a different contact URL, set `WIKIMEDIA_CONTACT_URL` as a GitHub Actions **Variable** containing a public HTTPS URL. No Wikimedia API key is required.

## How private state works

An Actions hosted runner does not retain files between jobs. This template connects `src/index.ts` and `src/runner.ts` to Node's built-in `node:sqlite`. It encrypts the completed SQLite file using **AES-256-GCM**, stores the ciphertext only in an Action Artifact called `notifier-state`, and decrypts the newest previous artifact on the next run. The upload sets `include-hidden-files: true` for the exact encrypted file, because GitHub otherwise ignores files under the hidden `.private/` folder.

After a successful new upload, the previous artifact is deleted to keep the number of retained snapshots bounded. When a provider fails, the D1-compatible retry state is persisted and encrypted before the job reports failure. A failed upload does not remove the previous checkpoint.

GitHub Actions logs in a public repository can be public. **This runner intentionally suppresses per-source details, monitor IDs and exception messages** rather than leaking your private subscriptions. Ciphertext should still be regarded as publicly downloadable; protect `NOTIFY_STATE_KEY` as a secret. Losing or changing the key makes previously saved snapshots unreadable.

GitHub Secrets belonging to the upstream project are **not** copied to your fork.

## Recovery and limits

- **No notifications**: non-YouTube sources start silently; YouTube sends the newest available video after its first successful poll, if the feed contains one. Later scans send only if eligible content exists; inspect workflow results and secret names.
- **Checkpoint missing**: an expired, deleted or failed artifact upload can leave no usable state. The workflow fails closed; it will not silently discard deduplication. Use `workflow_dispatch` with `reset_state: true` **only after accepting loss of old pending messages and history**.
- **Decryption failure**: the key may have changed or the artifact may be corrupt. Restore the original key; generating a new key cannot recover old ciphertext.
- **Invalid Discord Webhook**: update the GitHub Secret and clear the stored source-wide block in the SQLite `webhook_source_state` table. Resetting all history merely to clear a webhook error can drop pending messages.
- **Concurrency**: the workflow serializes jobs, but queued events can be replaced or missed under GitHub load.
- **Retention**: the template uses 30-day artifact retention. Regular successful polls refresh the snapshot, but inactivity longer than that can make a checkpoint unavailable.
- **Usage**: Actions minutes and artifact storage consume account/repository resources. GitHub's public/private repository allowances vary; inspect actual usage.

GitHub scheduled runs may be delayed or dropped; inactive public repositories can have scheduled workflows disabled after 60 days. For tighter scheduling and long-term database durability, prefer Cloudflare Workers + D1.

## Implementation

- [Workflow template](../templates/github-actions/notifier.yml)
- [SQLite adapter](../ops/actions/sqlite.mjs)
- [Authenticated encryption](../ops/actions/state-crypto.mjs)
- [Runner](../ops/actions/run-once.mjs)
- [Checkpoint recovery](../ops/actions/restore-state.sh)
- [Integration tests](../test/actions-template.test.ts)

The Actions backend and Cloudflare D1 **do not share their notification history**. Running both at once can duplicate notifications. Choose one active runtime for a given target set.


## Optional YouTube Data API

Register an optional GitHub Actions **Secret `YOUTUBE_API_KEY`** from a Google Cloud project with YouTube Data API v3 enabled to use the official API instead of RSS. Without a key, RSS remains the default. This uses `channels.list` and `playlistItems.list`, shares the same ID-based sent history, and reports API errors rather than silently falling back to RSS. YouTube sent receipts are retained indefinitely to prevent re-notification of old latest videos.


## OpenAlex papers

Add `{"id":"oa-graph","query":"search:graph algorithms","enabled":true}` to `targets.openalex` in the private config, plus its interval in `intervals`. Set the **`DISCORD_WEBHOOK_OPENALEX` GitHub Actions Secret**. An optional free **`OPENALEX_API_KEY` Secret** increases the request budget; keyless low-volume API access works too. Supported monitor queries are `search:terms`, `topic:T12345`, `author:A12345`. Initial result IDs are silently marked ignored; later unseen IDs published within the last seven days may notify (up to 25 works per poll).
