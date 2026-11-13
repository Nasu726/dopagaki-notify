# GitHub Actions + SQLite deployment guide

**Run dopagaki-notify without a Cloudflare account.** [English README](../README.EN.md) / [日本語ガイド](GITHUB_ACTIONS.md).

This opt-in template reuses the same monitoring, scheduling and Discord delivery code as the Cloudflare edition. It substitutes local Node.js SQLite for D1 and GitHub Actions for Cron Triggers. Integration tests are included, but it has not yet been proven over long-running production use.

## Choose your runtime and configuration visibility

Cloudflare Workers + D1 and GitHub Actions + SQLite are **alternative runtimes** with matching sources, private monitor settings, time/weekday windows, optional API keys, and per-monitor `retentionDays`. GitHub schedules can be delayed/skipped, and encrypted Artifacts have expiration limits. **Run one runtime at a time**; their databases are independent, so running both causes duplicate notifications.

For GitHub Actions, set the repository **Variable `MONITOR_CONFIG_MODE`**:

| Mode | Setting source | Visibility |
| --- | --- | --- |
| `private` (or unset; safe default) | Required Secret `MONITOR_CONFIG_JSON` | Subscriptions not committed |
| `public` (explicit) | Checked-in `config/targets.json`, `config/intervals.json` | Public subscriptions |

Public mode requires removing any previous `MONITOR_CONFIG_JSON` Secret to prevent ambiguous settings; the workflow fails closed if both are configured. A private-mode workflow with no Secret also refuses to run.

## Setup

1. Fork and clone the repository, install Node.js 22+, and run `npm install` and `npm run check`.
2. Run `npm run setup:actions`. It copies the workflow template, creates a gitignored generic `.private/monitor-config.json` and generates a random `.private/notify-state-key.txt`. Existing files and keys are never overwritten.
3. Edit the private JSON to your desired targets and intervals. Remove unwanted sources, keep every target ID matched to an interval, and set `wikipediaEnabled: false` (and remove its interval) if not wanted.
4. Open **Settings → Secrets and variables → Actions** in your fork and create:
   - `MONITOR_CONFIG_JSON`: the full contents of the private JSON file.
   - `NOTIFY_STATE_KEY`: the 64 hex characters in the generated `.private/notify-state-key.txt`. Keep this key unchanged.
   - The relevant `DISCORD_WEBHOOK_QIITA`, `DISCORD_WEBHOOK_ZENN`, `DISCORD_WEBHOOK_ARXIV`, `DISCORD_WEBHOOK_OPENALEX`, `DISCORD_WEBHOOK_YOUTUBE`, `DISCORD_WEBHOOK_WIKIPEDIA` URLs.

   Webhooks for unused sources and the optional `OPENALEX_API_KEY`, `YOUTUBE_API_KEY` and `NOTIFICATION_WINDOW_JST` can be left unregistered. GitHub passes an unregistered Secret as an empty string; the runner treats it as unset.
5. With GitHub CLI, run `gh auth login`, then `gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json` and `gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt`. Set the Discord webhook Secrets separately.
6. **After secrets are in place**, commit and push `.github/workflows/notifier.yml`. The template in `templates/` is inert until copied into your workflows directory. Scheduled runs only use the workflow on the **default branch (usually `main`)**; pushing it to another branch does not start the schedule.
7. GitHub Actions may be disabled in a fork. If the Actions tab asks you to enable workflows (for example **I understand my workflows, go ahead and enable them**), enable them. If `Discord notifier (SQLite)` says "This scheduled workflow is disabled", choose **Enable workflow**.
8. Under **Actions → Discord notifier (SQLite)** select **Run workflow** once. This creates an initial silent baseline for non-YouTube sources. For YouTube, the latest available video is eligible on the first scan only if published within the configured retention horizon.

The template schedules runs at UTC minutes 07, 17, 27, 37, 47 and 57 (every 10 minutes, best effort). Each run visits **every monitor that is due (or has a due queued notification) when the run starts, once each**, in the same priority order as the Cloudflare edition. A monitor sends at most three notifications per run; the rest follow in later runs. A run stops starting new monitors four minutes after it begins; remaining monitors keep their priority for the next run. **Delivery is unrestricted by default**. Optionally set `notificationWindowJst` to `"09:00-20:00"` in `MONITOR_CONFIG_JSON`, or register `NOTIFICATION_WINDOW_JST` as an Actions Secret containing `09:00-20:00`; the dedicated Secret takes precedence. Times are JST with an exclusive end. Source polling continues outside the optional delivery window.

When Wikipedia is enabled, the Wikimedia User-Agent defaults to the current fork's `GITHUB_REPOSITORY` as its operator contact. To use a different contact URL, set `WIKIMEDIA_CONTACT_URL` as a GitHub Actions **Variable** containing a public HTTPS URL. No Wikimedia API key is required.

## Sent receipt retention

Both runtimes use the same top-level `retentionDays` object inside `MONITOR_CONFIG_JSON` to override individual monitor IDs. Positive integer days or `null` (unlimited) are accepted; omitted monitors default to ten days for every source, including YouTube. This is **not** the encrypted Artifact's retention period (30 days in the template), which cannot be extended through `retentionDays`.

## How private state works

An Actions hosted runner does not retain files between jobs. This template connects `src/index.ts` and `src/runner.ts` to Node's built-in `node:sqlite`. It encrypts the completed SQLite file using **AES-256-GCM**, stores the ciphertext only in an Action Artifact called `notifier-state`, and decrypts the newest previous artifact on the next run. The upload sets `include-hidden-files: true` for the exact encrypted file, because GitHub otherwise ignores files under the hidden `.private/` folder.

After a successful new upload, the previous artifact is deleted to keep the number of retained snapshots bounded. When a provider fails, the D1-compatible retry state is persisted and encrypted before the job reports failure. A failed upload does not remove the previous checkpoint.

GitHub Actions logs in a public repository can be public. **This runner intentionally suppresses per-source details, monitor IDs and exception messages** rather than leaking your private subscriptions. Ciphertext should still be regarded as publicly downloadable; protect `NOTIFY_STATE_KEY` as a secret. Losing or changing the key makes previously saved snapshots unreadable.

GitHub Secrets belonging to the upstream project are **not** copied to your fork.

## Recovery and limits

- **No notifications**: non-YouTube sources start silently; YouTube can send the newest available video after its first successful poll, if the feed contains an eligible upload within its retention horizon. Later scans send only if eligible content exists; inspect workflow results and secret names.
- **Scheduled runs never start**: check that `notifier.yml` is on the default branch, that Actions and the workflow are enabled in your fork (setup step 7), and that a public repository's schedule was not disabled after 60 days without activity.
- **Checkpoint missing**: an expired, deleted or failed artifact upload can leave no usable state. The workflow fails closed; it will not silently discard deduplication. Use `workflow_dispatch` with `reset_state: true` **only after accepting loss of old pending messages and history**.
- **First run failed**: if every earlier run failed before saving its first checkpoint (for example, a Secret was missing), fix the Secrets and the next run automatically starts the first silent baseline; `reset_state` is not needed. Any record of earlier state (a live or expired checkpoint artifact, or a successful run) still stops the workflow as described above.
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
- [Per-run monitor loop](../ops/actions/tick-loop.mjs)
- [Checkpoint recovery](../ops/actions/restore-state.sh) / [Restore decisions](../ops/actions/checkpoint-plan.mjs)
- [Integration tests](../test/actions-template.test.ts) / [Runtime regression tests](../test/actions-runtime-hardening.test.ts)

The Actions backend and Cloudflare D1 **do not share their notification history**. Running both at once can duplicate notifications. Choose one active runtime for a given target set.


## Optional YouTube Data API

Register an optional GitHub Actions **Secret `YOUTUBE_API_KEY`** from a Google Cloud project with YouTube Data API v3 enabled to use the official API instead of RSS. Without a key, RSS remains the default. This uses `channels.list` and `playlistItems.list`, shares the same ID-based sent history, and reports API errors rather than silently falling back to RSS. By default, YouTube sent receipts are retained for ten days like other sources; use per-monitor `retentionDays` to extend retention or set `null` for unlimited history. Videos older than a finite retention horizon are excluded from staging to prevent repeats after pruning.


## OpenAlex papers

Add `{"id":"oa-graph","query":"search:graph algorithms","enabled":true}` to `targets.openalex` in the private config, plus its interval in `intervals`. Set the **`DISCORD_WEBHOOK_OPENALEX` GitHub Actions Secret**. An optional free **`OPENALEX_API_KEY` Secret** increases the request budget; keyless low-volume API access works too. Supported monitor queries are `search:terms`, `topic:T12345`, `author:A12345`. Initial result IDs are silently marked ignored; later unseen IDs published within the last seven days may notify (up to 25 works per poll).

Public setup:

```sh
npm run setup:actions -- --config-mode=public
# Edit config/targets.json and config/intervals.json, then validate
npm run config:check
gh variable set MONITOR_CONFIG_MODE --body public
```

Private setup:

```sh
npm run setup:actions -- --config-mode=private
npm run config:check -- --private-config-file=.private/monitor-config.json
gh variable set MONITOR_CONFIG_MODE --body private
gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json
```

Both modes need `NOTIFY_STATE_KEY` and source-specific Discord Webhook Secrets. Existing `.github/workflows/notifier.yml` files are not overwritten by setup; sync the new `MONITOR_CONFIG_MODE` environment variable from the template when upgrading.
