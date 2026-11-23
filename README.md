# Microsoft Rewards Script

[![Validate](https://github.com/TheNetsky/Microsoft-Rewards-Script/actions/workflows/validate.yml/badge.svg?branch=v5)](https://github.com/TheNetsky/Microsoft-Rewards-Script/actions/workflows/validate.yml)
![Version](https://img.shields.io/github/package-json/v/TheNetsky/Microsoft-Rewards-Script/v5)
[![Docker image (GHCR)](https://img.shields.io/badge/Docker-GHCR%20v5-2496ED?logo=docker&logoColor=white)](https://github.com/TheNetsky/Microsoft-Rewards-Script/pkgs/container/microsoft-rewards-script)
![Node.js](https://img.shields.io/badge/node-%3E%3D24-green)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Donate](https://img.shields.io/badge/Donate-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/thenetsky)

Microsoft Rewards automation with API and browser modes, saved sessions,
multiple accounts, localised searches and an optional Control API.

## Features

- Daily Set, promotions, punchcards and bonus-point claims.
- Desktop/mobile searches, Explore on Bing, Daily Check-In and Read to Earn.
- Optional Visual Search and background Edge browsing.
- Streak progress, API-based streak protection and verified point reporting.
- Scheduled runs, account selection, saved sessions and Discord/Telegram/ntfy notifications.
- Control API with live events, persistent history, punchcard progress and activity balance observations.
- Built-in Vietnamese dashboard for adding accounts, manual Microsoft sign-in, parallel runs and live logs.

Activities depend on the account and region. This branch contains v5; earlier
versions remain available on [v3](https://github.com/TheNetsky/Microsoft-Rewards-Script/tree/v3)
and [v4](https://github.com/TheNetsky/Microsoft-Rewards-Script/tree/v4).

## Documentation

- [Setup and usage](docs/usage.md) — local, Nix and Docker installation, accounts, settings, commands and troubleshooting.
- [Control API](docs/control-api.md) — authentication, endpoints, run control, scheduling and dashboard data.

## Setup

Requires Node.js 24 or newer.

```sh
npm ci
npm run install:browser
npm run build
cp env.example .env
cp config.example.json config.json
```

On Linux, install Chromium's system libraries with
`npx patchright install --with-deps chromium`.
On Windows, copy the example files with File Explorer or PowerShell's `Copy-Item`.

Set `ACCOUNT_1_EMAIL` and the relevant sign-in settings in `.env`, then run:

```sh
npm start
```

Add another numbered account block for each account. Passwords are optional for
passwordless accounts. See [env.example](env.example) for account variables and
[Setup and usage](docs/usage.md#accounts-and-sessions) for login options.

## Local dashboard

After building, start the built-in dashboard:

```sh
npm run dashboard
```

Open **http://127.0.0.1:3010/dashboard/**. On Windows, double-click
**`start-dashboard.cmd`** to start it in the background and open the browser.
On this machine you can also run `.\.dev\run.ps1 run dashboard` with the local Node.js runtime.

1. Add a Microsoft email, then choose **Thêm & đăng nhập**. Complete Microsoft
   sign-in in the visible mobile and desktop browser windows opened in sequence.
   Sessions are verified and saved; passwords are entered directly on Microsoft's page.
   If one platform is already saved, **Tiếp tục desktop/mobile** resumes the missing
   platform. The dashboard identifies incomplete logins before starting a run.
2. Select the accounts, set **1–16** concurrent account workers, and select tasks.
   All twelve task groups are initially selected; settings are remembered in this browser.
3. Choose **Chạy tài khoản đã chọn**. The bot uses actual process clusters for
   account concurrency, capped at the number of selected accounts.
4. Follow per-account task details, session status, observed balances, verified gains,
   live logs and history. **Dừng lượt hiện tại** stops the managed process tree.

Dashboard settings apply to the runs launched from the dashboard. Task availability
and quotas still come from Microsoft. Browser mode can run headlessly after manual login.
The dashboard and the API share one process manager, so login and rewards jobs cannot overlap.
When all enabled tasks are confirmed complete, the dashboard shows **DONE — Đã hết nhiệm vụ**
for each account and for the run. Incomplete, failed, cancelled or unverified runs retain their
own result, with details explaining remaining work. Results are restored from local history.

`npm run dashboard` enables account writes and per-run overrides unless explicitly
disabled through `API_ALLOW_CONFIG_WRITE` / `API_ALLOW_ENV_OVERRIDES`.
Existing API token authentication is supported in the dashboard.

Dashboard checks: `npm run build && npm run test:dashboard && npm run check:api && npm run lint`.

## Modes and settings

Edit [config.json](config.example.json) before starting a run.

| Setting                            | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `rewardsMode: "browser"`           | Complete web activities through rendered cards and GhostCursor |
| `rewardsMode: "api"`               | Save the sign-in session, close its browser and use HTTP       |
| `searchSettings.parallelSearching` | Overlap desktop and mobile work when enabled                   |
| `workers`                          | Enable or disable individual tasks                             |
| `taskDelay`                        | Delay between activities                                       |
| `searchSettings.searchDelay`       | Delay between searches                                         |
| `searchSettings.useAccountLocale`  | Select queries using the account country                       |
| `ensureStreakProtection`           | Enable and verify protection over HTTP in both modes           |
| `experimental`                     | Optional features; disabled by default                         |

See the full [settings reference](docs/usage.md#settings-reference) for all options.

## Sessions

To sign in manually on a desktop with a visible browser:

```sh
npm run manual-login -- user@example.com --platform both
npm run open-session -- --help
```

Sessions are saved under `sessionPath`. Keep `.env`, local configuration,
session databases and diagnostics private.

## Docker

Create `.env` from `env.example`, then review the timezone and schedule in
[compose.yaml](compose.yaml).

```sh
docker compose up -d --build
docker compose logs -f
```

The published v5 image is `ghcr.io/thenetsky/microsoft-rewards-script:5`.
To use it instead of building locally, follow the [Docker image instructions](docs/usage.md#docker).

Docker persists configuration in `./config`, sessions in `./sessions` and optional
error captures in `./diagnostics`. It creates `config/config.json` from defaults
when needed. `RUN_ON_START` controls the first run; `CRON_SCHEDULE` sets the initial
schedule. Control API schedule changes persist in `config/schedule.json`.
See [Control API Docker setup](docs/control-api.md#docker) to enable the server.

## License

[GPL-3.0-or-later](LICENSE).
