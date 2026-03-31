# OpenCode Railway Template

One-click Railway deploy for [OpenCode](https://opencode.ai) with browser UI, Railway Serverless enabled by default, and optional memory monitoring.

## Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/f0oQvM?referralCode=Se0h8C&utm_medium=integration&utm_source=template&utm_campaign=generic)

## Quick Start

1. Deploy to Railway using the button above
2. Add a persistent volume at `/data`
3. Set required environment variables (see below)
4. Open your Railway deployment URL
5. Login with username `opencode` and your password

This template ships with Railway Serverless enabled by default in `railway.toml`.

## Required environment variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_SERVER_PASSWORD` | **Required** - Password for HTTP Basic Auth (username: `opencode`) |

At least one AI provider key must be set:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `MINIMAX_API_KEY` | MiniMax API key |
| `GLM_API_KEY` | GLM (Zhipu AI) API key |

Optional variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `SOURCE_MODE` | `true` builds pinned frontend + backend from source, `false` installs latest published backend and uses upstream hosted web app | `true` |
| `OPENCODE_REF` | OpenCode git ref to build from, for example `v1.3.0` | `v1.3.0` |
| `OPENCODE_MODEL` | Default model to use | - |
| `LOG_LEVEL` | Log verbosity (DEBUG, INFO, WARN, ERROR) | WARN |
| `DEBUG_OPENCODE_TRAFFIC` | Print suppressed OpenCode health/PTy traffic logs for debugging | false |
| `LOG_SLEEP_BLOCKERS` | Log inbound probes and non-loopback outbound requests that can keep Serverless awake | true |
| `OPENCLAW_PLUGIN_PORT` | Port for OpenClaw plugin HTTP server | 9090 |
| `ENABLE_OH_MY_OPENCODE` | Register and bootstrap the `oh-my-opencode` plugin | true |
| `ENABLE_MONITOR` | Enable OpenCode memory monitor auto-restart | false |
| `AUTH_REALM` | HTTP Basic Auth realm (for password manager compatibility) | opencode.tradao.xyz |
| `OPENCODE_SESSION_SECRET` | Cookie signing secret for browser sessions | `OPENCODE_SERVER_PASSWORD` |

## Two ways to use

### 1. Web UI (Browser)

Open your Railway deployment URL in a browser. Enter the username (`opencode`) and password you configured.

**Features:**
- Create and manage multiple sessions
- Real-time AI responses via SSE streaming
- Built-in terminal for command execution
- File browser and editor
- Git integration
- iOS/Safari-friendly login flow with working manifest and app icons

### 2. Terminal (CLI)

Connect with the OpenCode CLI for a better terminal experience:

```bash
# Install OpenCode locally first
npm install -g opencode-ai

# Attach to your remote server
opencode attach https://your-app.up.railway.app/ -p YOUR_PASSWORD
```

If you SSH into the Railway container, `opencode` is also available as a shell command. In `SOURCE_MODE=true`, the image now promotes the compiled standalone binary to `/usr/local/bin/opencode` so `railway ssh` sessions behave the same as published-package installs.

## Volume

Mount a Railway volume at `/data` — this persists workspace and state data across deployments.

```
/data/
├── workspace/          # Your project files
├── .config/opencode/   # OpenCode configuration
├── .local/share/opencode/  # Session state
└── .local/state/opencode/  # Runtime state
```

## Architecture

This template uses a Node.js proxy wrapper to support browser sessions, CLI authentication, and either self-hosted or upstream web assets:

```
Internet → Node.js Proxy (PORT 8080)
              ↓ (Session cookie or HTTP Basic Auth)
         ├─→ Local web assets from packages/app/dist (`SOURCE_MODE=true`)
         ├─→ Upstream hosted web app via internal `opencode serve` (`SOURCE_MODE=false`)
         ├─→ Internal OpenCode (PORT 18080)  ─→ /session/*, /global/*, /agents, /tools, /events, API
         └─→ OpenClaw Plugin (PORT 9090)     ─→ /register
```

### Key Components

- **`server.js`** — Node.js proxy with cookie session login, Basic Auth support, and streaming proxying
- **`runtime-config.js`** — Ensures plugin entries exist in `/data/.config/opencode/opencode.json` and seeds `oh-my-opencode` config
- **`Dockerfile`** — Either clones `OPENCODE_REF` and builds `packages/app` + `packages/opencode`, or installs the latest published `opencode-ai` package when `SOURCE_MODE=false`
- **`start.sh`** — Entry point that starts the proxy
- **`railway.toml`** — Railway configuration
- **`monitor.sh`** — Optional memory monitor with auto-restart (see below)

## Oh My OpenCode

This template now bootstraps the `oh-my-opencode` plugin package from the `oh-my-openagent` repository at container startup.

- `opencode.json` is normalized to use the correct `plugin` key and includes both `@laceletho/plugin-openclaw` and `oh-my-opencode@latest`
- `/data/.config/opencode/oh-my-opencode.json` is created automatically from `oh-my-opencode.default.json`
- Existing `oh-my-opencode.json` customizations on the persistent volume are preserved and merged on startup
- Set `ENABLE_OH_MY_OPENCODE=false` if you want to disable this bootstrap entirely

The bundled default profile mostly defers agent/category model selection to `oh-my-openagent` itself:

- builtin agent/category defaults still come from `oh-my-openagent/src/shared/model-requirements.ts`
- the template only pins `explore` and `librarian` to `kimi-for-coding/k2p5`; other agents and categories are left to the upstream fallback chains
- this template intentionally does not inject `fallback_models`, because `oh-my-openagent` resolves `fallback_models` before its built-in `fallbackChain`; forcing them here would accidentally change upstream model priority

If you want a different provider mix, update `oh-my-opencode.default.json` before deploying or edit `/data/.config/opencode/oh-my-opencode.json` on the mounted volume.

### Why a Proxy?

OpenCode's built-in web server is exposed only on localhost inside the container. The proxy:

1. Issues secure browser session cookies after login
2. Still accepts HTTP Basic Auth for CLI and automation
3. In `SOURCE_MODE=true`, serves the web frontend built from the same OpenCode ref as the backend
4. In `SOURCE_MODE=false`, proxies browser routes through the internal `opencode serve` fallback to the official hosted frontend
5. Properly handles WebSocket upgrades for browser terminals
6. Maintains SSE streaming for real-time AI responses
7. Exposes PWA assets without auth so browser install flows keep working in self-hosted mode
8. Relaxes upstream CSP enough to allow Cloudflare Insights and the OpenCode changelog fetch

## Deployment Modes

### `SOURCE_MODE=true` (default)

This keeps the browser frontend and backend on the same ref.

Important details:

- Upstream `opencode serve` proxies unmatched web routes to `https://app.opencode.ai`
- Relying on that default behavior can create a mixed deployment:
  - local backend from one ref
  - hosted frontend from a newer upstream version
- This template avoids that by:
  - building `packages/app` locally from `OPENCODE_REF`
  - building `packages/opencode` locally from the same `OPENCODE_REF`
  - serving local static assets from `packages/app/dist` before any request reaches the internal OpenCode server
  - launching only the prebuilt standalone binary from `packages/opencode/dist`

Runtime rule:

- the container only starts the compiled OpenCode binary produced during `docker build`
- there is no runtime fallback to `bun run`, `bunx`, or source execution
- if the compiled binary is missing, startup fails immediately with a clear error instead of trying another launch path

When `OPENCODE_REF` is a semver tag such as `v1.3.0`, the Docker build also injects:

- `OPENCODE_VERSION=1.3.0`
- `OPENCODE_CHANNEL=latest`

This avoids detached-HEAD preview version strings like `0.0.0--...` during the OpenCode build.

### `SOURCE_MODE=false`

This switches the template back to upstream delivery behavior:

- the Docker image installs the latest published `opencode-ai` package
- runtime launches `opencode serve` from that installed package
- browser routes are proxied to the internal OpenCode server instead of serving local `packages/app/dist`
- unmatched frontend routes then fall through to the official hosted web app from upstream OpenCode

Use this mode when you want the smallest deployment surface and you are comfortable following the latest published backend plus hosted frontend behavior.

### Deploy-time expectations

After a successful deployment with `SOURCE_MODE=true`:

- `GET /global/health` should report the backend version you pinned
- the browser UI version shown in Settings should match the same pinned version

### Quick verification

Use Railway SSH after deployment:

```bash
railway ssh 'curl -s http://127.0.0.1:18080/global/health'
```

Expected result for `SOURCE_MODE=true` and `OPENCODE_REF=v1.3.0`:

```json
{"healthy":true,"version":"1.3.0"}
```

You can also verify that static assets are being served locally instead of falling through to HTML:

```bash
railway ssh 'curl -I -s http://127.0.0.1:8080/assets/index-*.js'
```

The response should be JavaScript, not `text/html`.

For `SOURCE_MODE=false`, the container no longer contains local `packages/app/dist`, so frontend requests should be handled by the internal `opencode serve` process and its upstream hosted web app fallback instead.

## Memory Monitor

This template includes an embedded memory monitor (`monitor.sh`) that can automatically restart OpenCode when idle to prevent memory leaks.

### Why it's needed

OpenCode spawns MCP/LSP processes per session that accumulate over time, causing memory to grow from ~100MB to 6GB+. The monitor detects true idle states and triggers Railway redeployment before crashes occur.

### How it works

- **SSE Event Monitoring**: Connects to `/global/event` endpoint to detect user activity in real-time
- **Smart Idle Detection**: Only restarts when all sessions are idle for 10+ minutes AND no AI generation is in progress
- **Graceful Shutdown**: Waits for 60s cooling period after generation before considering restart
- **Railway API Integration**: Uses GraphQL API to trigger deployment restart (requires `RAILWAY_API_TOKEN`)

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `IDLE_TIME_MINUTES` | 10 | Minutes of inactivity before restart |
| `MEMORY_THRESHOLD_MB` | 2000 | Memory limit that triggers restart |
| `CHECK_INTERVAL_SECONDS` | 60 | How often to check status |
| `GENERATION_GRACE_SECONDS` | 60 | Wait time after AI generation |
| `RAILWAY_API_TOKEN` | - | Required for auto-restart via API |

The monitor is disabled by default. Enable it with `ENABLE_MONITOR=true` when you want this behavior.

### Sleep blocker logs

`server.js` now logs two categories by default to help diagnose why a Serverless deployment stays active:

- `"[sleep-debug] inbound ..."` for incoming requests that commonly wake or probe the service, including `/global/health`, `/session/status`, `/global/event`, `/events`, `/register`, `/`, browser navigations, and WebSocket upgrades
- `"[sleep-debug] outbound ..."` for every non-loopback outbound request made by the wrapper process

Set `LOG_SLEEP_BLOCKERS=false` if you need to silence these logs after debugging.

## API Access

The proxy exposes OpenCode HTTP API endpoints for external access (e.g., from `openclaw-opencode-cli`):

| Endpoint | Description |
|----------|-------------|
| `POST /session` | Create a new session |
| `GET /session/{id}` | Get session info |
| `POST /session/{id}/prompt` | Send prompt to session |
| `GET /session/status` | Get session status |
| `GET /session/{id}/messages` | Get session messages |
| `GET /global/health` | OpenCode health check |
| `GET /agents` | List agents |
| `GET /tools` | List tools |
| `POST /register` | Register callback (plugin endpoint) |

Machine clients can use HTTP Basic Auth:
```bash
curl -u opencode:YOUR_PASSWORD https://your-app.up.railway.app/session \
  -X POST -H "Content-Type: application/json"
```

Browser clients should sign in via `/login` and then use the session cookie automatically.

The proxy also leaves these static resources publicly readable so manifests, icons, and browser install flows keep working:

- `/site.webmanifest`
- `/favicon.ico`
- `/favicon-v3.ico`
- `/favicon-v3.svg`
- `/favicon-96x96-v3.png`
- `/apple-touch-icon-v3.png`
- `/web-app-manifest-192x192.png`
- `/web-app-manifest-512x512.png`

If any of these local static files are missing, the proxy now returns an explicit `404` or `500` instead of silently falling back to the upstream hosted frontend.

## Troubleshooting

### Repeated password prompts

If the browser keeps sending you back to `/login`, check:
- The `OPENCODE_SERVER_PASSWORD` environment variable is set correctly
- If you override `OPENCODE_SESSION_SECRET`, make sure all instances use the same value
- Try clearing browser cache and cookies

### Terminal not working

The terminal uses WebSocket connections. If it's not working:
- Check that the deployment URL uses HTTPS (WSS requires HTTPS)
- Verify `OPENCODE_SERVER_PASSWORD` is set

### AI responses not streaming

Responses should appear word-by-word. If they require page refresh:
- Check browser console for errors
- Verify SSE is not being blocked by browser extensions

### Page loads but JS modules fail with MIME type `text/html`

If the browser reports:

```text
Failed to load module script ... server responded with a MIME type of "text/html"
```

check these first:

- the Docker image was rebuilt after changing `Dockerfile` or `server.js`
- `packages/app/dist` exists inside the container
- `packages/opencode/dist/*/bin/opencode` exists inside the container
- the proxy is serving `/assets/*` locally rather than falling through to an HTML route

This error almost always means a static asset request returned HTML instead of the expected JS bundle.

### Backend version is pinned but the UI shows a different version

That usually means the deployment is still using upstream hosted frontend behavior somewhere in the request path.

Check:

- the template version includes local `packages/app` build support
- the deployment still contains the compiled `packages/opencode/dist/*/bin/opencode` binary
- `/assets/*` is served from local static files
- the current deployment was rebuilt from the updated template code, not only restarted

### Browser console warning about non-passive `wheel` listener

You may see a Chrome performance warning about a non-passive `wheel` listener in the session file-tab strip.

- This comes from upstream app code, not from the Railway wrapper
- It is intentional because that handler calls `preventDefault()` to translate vertical wheel motion into horizontal tab scrolling
- It is a warning, not a functional bug

### 400 errors on shell commands

If shell commands return 400 Bad Request:
- This was a bug in earlier proxy implementations
- Make sure you're using the latest version of this template

## Development

To modify the proxy or customize the deployment:

```bash
# Clone the template
git clone https://github.com/LaceLetho/opencode-railway-template.git
cd opencode-railway-template

# Make changes to server.js
# Commit changes, then trigger a Railway rebuild using your normal Git-based deploy flow
railway login
railway link
```

### Testing locally

```bash
# Set required env vars
export OPENCODE_SERVER_PASSWORD=your-test-password
export PORT=8080

# Install dependencies (none required now)
npm install

# Run the proxy
node server.js
```

## Lessons Learned

This section documents key technical decisions and pitfalls:

### 1. Don't use http-proxy library

The `http-proxy` npm package has issues with:
- POST request body forwarding
- SSE streaming (it buffers responses)

**Use Node.js native `http.request` instead** with `pipe()` for proper streaming.

### 2. Browser auth should live at the proxy layer

Browsers and installed web apps behave much better with a secure session cookie than with injected Basic Auth headers. Keep Basic Auth for CLI and automation, and let the proxy translate browser login into a cookie session.

### 3. WebSocket auth is special

Browsers don't support credentials in WebSocket URLs (`wss://user:pass@host`). The proxy should authenticate the upgrade request using the existing session cookie or Basic Auth header.

### 4. SSE requires true streaming

Don't use `fetch()` to forward SSE requests — it buffers the entire response. Use `http.request` with `pipe()` to maintain streaming.

### 5. HTML vs API request handling

Different request types need different handling:
- **Login page:** Serve directly from the proxy
- **HTML/API/SSE/WebSocket:** Stream directly after auth
- **PWA assets:** Serve without auth so manifests and install icons keep working
- **Static assets:** Stream directly

### 6. CSP is part of the deployment contract

OpenCode ships with a strict CSP. The proxy now relaxes it in a narrow way so browser console noise stays low while the app remains locked down:

- `script-src` allows `https://static.cloudflareinsights.com`
- `connect-src` allows `https://opencode.ai`

This keeps Cloudflare Insights and the built-in changelog fetch working without changing the OpenCode codebase.

## License

MIT — see LICENSE for details.

## Related Projects

- [OpenCode](https://github.com/sst/opencode) — The core AI coding agent
- [opencode-mcp](https://github.com/LaceLetho/opencode-mcp) — MCP server for Claude/Cursor integration
- [openclaw-opencode-cli](https://github.com/LaceLetho/openclaw-opencode-cli) — CLI bridge for task dispatch
