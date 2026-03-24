# OpenCode Railway Template

One-click Railway deploy for [OpenCode](https://opencode.ai) — an always-on autonomous AI coding agent with web interface.

## Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/f0oQvM?referralCode=Se0h8C&utm_medium=integration&utm_source=template&utm_campaign=generic)

## Quick Start

1. Deploy to Railway using the button above
2. Add a persistent volume at `/data`
3. Set required environment variables (see below)
4. Open your Railway deployment URL
5. Login with username `opencode` and your password

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
| `OPENCODE_MODEL` | Default model to use | - |
| `LOG_LEVEL` | Log verbosity (DEBUG, INFO, WARN, ERROR) | WARN |
| `DEBUG_OPENCODE_TRAFFIC` | Print suppressed OpenCode health/PTy traffic logs for debugging | false |
| `OPENCLAW_PLUGIN_PORT` | Port for OpenClaw plugin HTTP server | 9090 |
| `ENABLE_MONITOR` | Enable OpenCode memory monitor auto-restart | true |
| `AUTH_REALM` | HTTP Basic Auth realm (for password manager compatibility) | opencode.tradao.xyz |

## Two ways to use

### 1. Web UI (Browser)

Open your Railway deployment URL in a browser. Enter the username (`opencode`) and password you configured.

**Features:**
- Create and manage multiple sessions
- Real-time AI responses via SSE streaming
- Built-in terminal for command execution
- File browser and editor
- Git integration

### 2. Terminal (CLI)

Connect with the OpenCode CLI for a better terminal experience:

```bash
# Install OpenCode locally first
npm install -g opencode-ai

# Attach to your remote server
opencode attach https://your-app.up.railway.app/ -p YOUR_PASSWORD
```

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

This template uses a Node.js proxy wrapper to add HTTP Basic Auth and automatic authentication:

```
Internet → Node.js Proxy (PORT 8080)
              ↓ (Basic Auth check)
              ↓ (HTML injection for auto-auth)
         ├─→ Internal OpenCode (PORT 18080)  ─→ /session/*, /global/*, /agents, /tools, /events, Web UI
         └─→ OpenClaw Plugin (PORT 9090)     ─→ /register
```

### Key Components

- **`server.js`** — Node.js proxy with Basic Auth, HTML injection, and streaming support
- **`Dockerfile`** — Installs Bun + `opencode-ai` CLI
- **`start.sh`** — Entry point that starts the proxy
- **`railway.toml`** — Railway configuration
- **`monitor.sh`** — Memory monitor with auto-restart (see below)

### Why a Proxy?

OpenCode's built-in web server requires authentication, but browsers don't automatically forward credentials to SPA API calls. The proxy:

1. Handles HTTP Basic Auth at the edge
2. Injects JavaScript into HTML pages to auto-authenticate API calls
3. Properly handles WebSocket upgrades (browsers don't support WS URLs with credentials)
4. Maintains SSE streaming for real-time AI responses

## Memory Monitor

This template includes an embedded memory monitor (`monitor.sh`) that automatically restarts OpenCode when idle to prevent memory leaks.

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

### Disabling the monitor

Set `ENABLE_MONITOR=false` in Railway environment variables. Defaults to `true`.

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

All API requests require HTTP Basic Auth:
```bash
curl -u opencode:YOUR_PASSWORD https://your-app.up.railway.app/session \
  -X POST -H "Content-Type: application/json"
```

## Troubleshooting

### Repeated password prompts

If the browser keeps asking for your password after initial login, check:
- JavaScript is enabled in your browser
- The `OPENCODE_SERVER_PASSWORD` environment variable is set correctly
- Try clearing browser cache and cookies

### Terminal not working

The terminal uses WebSocket connections. If it's not working:
- Check that the deployment URL uses HTTPS (WSS requires HTTPS)
- Verify `OPENCODE_SERVER_PASSWORD` is set

### AI responses not streaming

Responses should appear word-by-word. If they require page refresh:
- Check browser console for errors
- Verify SSE is not being blocked by browser extensions

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
# Deploy to Railway
railway login
railway link
railway up
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

### 2. Inject auth into HTML, not just headers

Browsers cache Basic Auth for the initial page load, but SPAs make API calls that don't automatically include credentials. Solution: inject JavaScript to intercept `fetch` and `XMLHttpRequest`.

### 3. WebSocket auth is special

Browsers don't support credentials in WebSocket URLs (`wss://user:pass@host`). The proxy must skip auth checks for WebSocket upgrade requests — this is safe because the user has already authenticated via the initial page load.

### 4. SSE requires true streaming

Don't use `fetch()` to forward SSE requests — it buffers the entire response. Use `http.request` with `pipe()` to maintain streaming.

### 5. HTML vs API request handling

Different request types need different handling:
- **HTML pages:** Buffer, inject auth script, send modified response
- **API/SSE/WebSocket:** Stream directly without buffering
- **Static assets:** Stream directly

## License

MIT — see LICENSE for details.

## Related Projects

- [OpenCode](https://github.com/sst/opencode) — The core AI coding agent
- [opencode-mcp](https://github.com/LaceLetho/opencode-mcp) — MCP server for Claude/Cursor integration
- [openclaw-opencode-cli](https://github.com/LaceLetho/openclaw-opencode-cli) — CLI bridge for task dispatch
