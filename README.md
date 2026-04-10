# OpenCode Railway Template

[中文说明](./README.zh-CN.md)

Deploy OpenCode on Railway with the pieces that matter in production: pinned frontend + backend from the same source ref, browser-friendly auth, idle high-memory auto-restart, and automatic plugin refresh.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/opencode?referralCode=Se0h8C&utm_medium=integration&utm_source=template&utm_campaign=generic)

## Why This Template

1. **Build from source, keep web and core on the same version**
   With `SOURCE_MODE=true`, the image clones `OPENCODE_REF` and builds both `packages/app` and `packages/opencode`. This avoids the common mismatch where a pinned backend is paired with the upstream hosted frontend.

2. **Built-in monitor for idle high-memory restart**
   `monitor.sh` checks idle time and memory usage. It only triggers a Railway restart / redeploy when the service has been idle long enough and memory is above the threshold, which keeps memory growth under control with minimal disruption.

3. **Serverless sleep for lower cost**
   `railway.toml` enables `serverless = true` by default. When the service is unused, it can sleep and reduce cost; when traffic returns, Railway wakes it up again.

4. **`oh-my-openagent@latest` installed by default and refreshed on redeploy**
   Startup ensures `oh-my-openagent@latest` is present in OpenCode config. When Railway deployment id changes, cached plugin files are cleared so the latest version is fetched again. A restart within the same deployment keeps the cache for faster startup.

5. **Cookie-based browser auth that works better with Chrome and Safari**
   Browsers log in through `/login` and receive a secure session cookie. CLI and automation can still use HTTP Basic Auth. This works better for Web UI, PWA install flow, and WebSocket auth than relying on browser Basic Auth alone.

## Quick Start

1. Deploy with the Railway button above.
2. Mount a persistent volume at `/data`.
3. Set the required environment variables.
4. Open the Railway URL.
5. Sign in with username `opencode` and your password.

`/data` stores workspace files, OpenCode config, and runtime state across redeploys.

## Required Environment Variables

| Variable | Description |
| --- | --- |
| `OPENCODE_SERVER_PASSWORD` | Required. Login password for browser and CLI Basic Auth. |

## Common Optional Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `SOURCE_MODE` | `true` | Recommended. `true` builds from source and serves local web assets. `false` installs `opencode-ai@latest` and falls back to upstream hosted frontend behavior. |
| `OPENCODE_REF` | `v1.3.0` | OpenCode git ref to build when `SOURCE_MODE=true`. |
| `OPENCODE_MODEL` | - | Default model for OpenCode. |
| `OPENCODE_SESSION_SECRET` | `OPENCODE_SERVER_PASSWORD` | Signing secret for browser session cookies. Set this explicitly if you run multiple instances. |
| `AUTH_REALM` | `opencode.tradao.xyz` | Basic Auth realm. Usually no need to change it. |
| `ENABLE_OH_MY_OPENCODE` | `true` | Enable automatic injection of `oh-my-openagent@latest`. |
| `ENABLE_OMO_REDEPLOY_REFRESH` | `true` | Refresh oh-my plugin cache when Railway deployment id changes. |
| `ENABLE_MONITOR` | `false` | Enable the memory monitor and auto-restart logic. |
| `LOG_LEVEL` | `WARN` | Wrapper log level. |
| `LOG_SLEEP_BLOCKERS` | `true` | Log inbound and outbound requests that can keep a Serverless service awake. |

## Monitor Environment Variables

These matter only when `ENABLE_MONITOR=true`.

| Variable | Default | Description |
| --- | --- | --- |
| `RAILWAY_API_TOKEN` | - | Needed if the monitor should actually trigger Railway restart / redeploy. |
| `IDLE_TIME_MINUTES` | `10` | Required idle time before restart is allowed. |
| `MEMORY_THRESHOLD_MB` | `2000` | Restart only when memory is above this threshold. |
| `CHECK_INTERVAL_SECONDS` | `60` | Monitor check interval. |

Railway injects `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, and `RAILWAY_SERVICE_ID` automatically.

## Auth Modes

- Browser: visit `/login`, then the proxy issues a `Secure + HttpOnly + SameSite=Lax` session cookie.
- CLI / scripts: continue using HTTP Basic Auth.

Examples:

```bash
curl -u opencode:YOUR_PASSWORD https://your-app.up.railway.app/global/health
opencode attach https://your-app.up.railway.app/ -p YOUR_PASSWORD
```

## Sleep and Cost Control

- Railway Serverless is enabled by default, so idle services can sleep.
- `server.js` logs common wake-up sources to help debug why a service stays active.
- With `ENABLE_MONITOR=true`, the service can also auto-restart when it stays idle and memory usage becomes too high.

These solve different problems:

- `Serverless sleep`: reduce idle cost.
- `Memory monitor`: reduce long-running memory growth.

## Plugin Behavior

- The template ensures `@laceletho/plugin-openclaw` and `oh-my-openagent@latest` exist in `/data/.config/opencode/opencode.json`.
- Startup rebuilds the oh-my config from the bundled template.
- A new Railway deployment id triggers cache cleanup and re-download of the latest oh-my plugin.

Disable this behavior with:

```bash
ENABLE_OH_MY_OPENCODE=false
```

## Local Run

```bash
npm install
OPENCODE_SERVER_PASSWORD=your-password \
ANTHROPIC_API_KEY=xxx \
npm run start
```

## Test

```bash
npm test
```
