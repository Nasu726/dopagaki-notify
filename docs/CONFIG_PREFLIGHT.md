# Configuration preflight / 設定の事前検査

## Purpose

Catch invalid version-controlled targets/intervals and privately supplied runtime config **before** a deployment rather than waiting for a failing Cron. The checker imports the exact same `loadRuntimeMonitors`, `validateMonitors`, and `resolveNotificationWindowJst` used by production. It does not access D1, HTTP providers, webhooks or Cloudflare APIs.

```sh
npm run config:check
```

CI runs this command against **public checked-in** configuration. `npm run deploy` additionally runs it automatically before `wrangler deploy`. Running `npx wrangler deploy` directly or using Cloudflare Workers Builds without a matching preflight step does **not** guarantee this check.

## Private Cloudflare/Actions configuration

Validate locally (do not upload private values to public CI):

```sh
npm run config:check -- --private-config-file=.private/monitor-config.json
```

Optionally validate the exact intended `NOTIFICATION_WINDOW_JST` contents in an ignored private text file:

```sh
npm run config:check -- --private-config-file=.private/monitor-config.json --notification-window-file=.private/notification-window.txt
```

Alternatively supply `MONITOR_CONFIG_JSON` and/or `NOTIFICATION_WINDOW_JST` as local environment variables. Do not supply a file and environment variable for the same setting simultaneously. Output is limited to counts, whether sending is restricted, and a sanitized error. Never paste or commit the contents of private configuration or webhook/API credentials.

**Important:** GitHub CI cannot inspect Cloudflare's deployed Secret values. The Cloudflare dashboard/wrangler generally does not reveal existing Secret contents for verification. Before changing a Secret, validate the exact locally known intended value and then update it in Cloudflare. Recheck the deployed Worker logs after applying changes.

## Notification-window semantics / 通知時間の仕様

- Unset `NOTIFICATION_WINDOW_JST` (and use `notificationWindowJst: null` in configuration) to permit notifications **24 hours/day**.
- Valid restriction example: `09:00-20:00` sends from 09:00 inclusive to 20:00 exclusive (JST). Overnight `22:00-06:00` is valid.
- `00:00-24:00` is **invalid** because `24:00` is outside accepted `HH:MM` (00:00–23:59). `09:00-09:00` is also invalid, not a 24h window.
- Invalid values fail closed; they are never silently changed into unrestricted delivery.

24時間通知する場合、`NOTIFICATION_WINDOW_JST=00:00-24:00` を設定してはいけません。Cloudflare側のこのSecretを削除し、必要なら設定JSONの `notificationWindowJst` を `null` にしてください。時刻制限する場合は `09:00-20:00` などの半開区間を指定します。

## Still requiring live verification

This preflight cannot prove a currently deployed Cloudflare Secret is valid or eliminate repeated scheduled errors on deployments made outside checked tooling. After updating Cloudflare settings, check Observability logs and the next scheduled execution. A runtime-safe single-error/cooldown strategy is tracked separately in Issue #57.
