# Design: OpenCode + OpenWork Railway Deploy Template

**Date:** 2026-03-06
**Status:** Approved
**Target submodule:** `opencodeRailwayTemplate/`

---

## Goal

A Railway one-click deploy template that runs OpenCode + OpenWork as an always-on autonomous AI coding agent. After deploy, users connect via OpenWork UI to send requirements; OpenCode plans, implements, tests, and reports back autonomously.

---

## Architecture

```
Railway Service
┌─────────────────────────────────────────────────┐
│  start.sh                                        │
│  ├── node src/server.js      (proxy, $PORT)      │
│  └── openwork serve          (orchestrator)      │
│       ├── opencode           (sidecar, :4096)    │
│       ├── openwork-server    (sidecar, :8787)    │
│       └── opencode-router    (sidecar, optional) │
└─────────────────────────────────────────────────┘

Internet ──► $PORT (proxy) ──► :8787 (OpenWork UI + API)
                                    (OpenCode :4096 is internal only)

Railway Volume /data
  ├── workspace/     # opencode working directory
  ├── sidecars/      # openwork sidecar cache (downloaded once, persisted)
  └── openwork/      # openwork-server state
```

### Key decisions

- **OpenWork orchestrator as main process** — `openwork-orchestrator` (npm: `openwork-orchestrator`, command: `openwork`) manages all sub-processes: opencode, openwork-server, opencode-router. No need to manage them independently.
- **Thin Node.js reverse proxy** — listens on Railway's `$PORT`, applies HTTP Basic Auth, WebSocket-proxies all traffic to OpenWork server on `:8787`.
- **Sidecar cache on volume** — `OPENWORK_SIDECAR_DIR=/data/sidecars` persists downloaded sidecars across restarts. Only downloads on first cold boot.
- **Dynamic provider config** — `start.sh` inspects API key env vars and generates `OPENCODE_CONFIG_CONTENT` JSON at startup. Only configured providers are included.

---

## File Structure

```
opencodeRailwayTemplate/
├── Dockerfile
├── railway.toml
├── package.json          # proxy server deps only (express, http-proxy)
├── start.sh              # startup: generate config, launch proxy + openwork serve
└── src/
    └── server.js         # HTTP Basic Auth reverse proxy (WebSocket-capable)
```

---

## Environment Variables

### Set by user in Railway dashboard

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SETUP_PASSWORD` | Yes | — | HTTP Basic Auth password (username: `openwork`) |
| `ANTHROPIC_API_KEY` | * | — | Anthropic Claude API key |
| `MINIMAX_API_KEY` | * | — | Minimax API key |
| `MINIMAX_BASE_URL` | No | `https://api.minimax.chat/v1` | Minimax API base URL |
| `GLM_API_KEY` | * | — | ZhipuAI GLM API key |
| `GLM_BASE_URL` | No | `https://open.bigmodel.cn/api/paas/v4` | ZhipuAI API base URL |
| `OPENCODE_MODEL` | No | `anthropic/claude-sonnet-4-5` | Default model (`provider/model-id`) |

*At least one AI provider key must be set.

### Pre-set in railway.toml (users do not need to touch these)

| Variable | Value |
|----------|-------|
| `OPENWORK_PORT` | `8787` |
| `OPENWORK_SIDECAR_DIR` | `/data/sidecars` |
| `OPENWORK_DATA_DIR` | `/data/openwork` |
| `OPENCODE_WORKSPACE` | `/data/workspace` |

### Railway-injected (do not set manually)

| Variable | Description |
|----------|-------------|
| `PORT` | Public-facing port Railway routes traffic to |

---

## Component Details

### Dockerfile

- Base image: `node:22-bookworm`
- Install `openwork-orchestrator` globally via npm (includes pre-compiled Linux binary; Bun not needed at runtime)
- Copy proxy server files and install its deps (`npm install --omit=dev`)
- `ENTRYPOINT ["tini", "--"]` + `CMD ["bash", "start.sh"]`
- Volume required at `/data`

### start.sh

1. Create `/data/workspace` and `/data/sidecars` if not present
2. Inspect API key env vars; build `OPENCODE_CONFIG_CONTENT` JSON:
   - Include `model` if `OPENCODE_MODEL` is set
   - Include `provider.minimax` block if `MINIMAX_API_KEY` is set
   - Include `provider.zhipu` block if `GLM_API_KEY` is set
   - Anthropic uses env var directly; no explicit provider block needed
3. Export `OPENCODE_CONFIG_CONTENT`
4. Launch proxy in background: `node src/server.js &`
5. Launch orchestrator in foreground: `openwork serve --workspace /data/workspace --approval auto --no-tui`

### src/server.js

- Express + http-proxy
- `GET /healthz` — no auth, returns `{"ok":true}` (Railway healthcheck)
- All other routes — validate HTTP Basic Auth (`openwork` / `SETUP_PASSWORD`); 401 on failure
- Proxy target: `http://127.0.0.1:${OPENWORK_PORT}` (default `8787`)
- WebSocket upgrade: proxy WS connections to same target

### railway.toml

```toml
[build]
builder = "dockerfile"

[deploy]
healthcheckPath = "/healthz"
healthcheckTimeout = 300
startCommand = "bash start.sh"
restartPolicyType = "on_failure"
requiredMountPath = "/data"

[variables]
OPENWORK_PORT = "8787"
OPENWORK_SIDECAR_DIR = "/data/sidecars"
OPENWORK_DATA_DIR = "/data/openwork"
OPENCODE_WORKSPACE = "/data/workspace"
```

---

## Provider Configuration (opencode.json schema)

Minimax and ZhipuAI GLM are both OpenAI-compatible. The dynamically generated config uses `@ai-sdk/openai-compatible`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "provider": {
    "minimax": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "name": "minimax",
        "apiKey": "<MINIMAX_API_KEY>",
        "baseURL": "<MINIMAX_BASE_URL>"
      }
    },
    "zhipu": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "name": "zhipu",
        "apiKey": "<GLM_API_KEY>",
        "baseURL": "<GLM_BASE_URL>"
      }
    }
  }
}
```

Anthropic requires no explicit provider block — OpenCode auto-discovers it from `ANTHROPIC_API_KEY`.

---

## Data Flow on First Boot

1. Railway pulls image → mounts `/data` volume
2. `start.sh` creates workspace/sidecar dirs
3. `start.sh` generates `OPENCODE_CONFIG_CONTENT` from env vars
4. Proxy starts on `$PORT`
5. `openwork serve` starts; downloads sidecars to `/data/sidecars` (~200MB first time)
6. OpenWork server comes up on `:8787`; OpenCode comes up on `:4096`
7. Railway healthcheck hits `/healthz` → passes
8. User navigates to Railway domain, enters `openwork` / `<SETUP_PASSWORD>` → OpenWork UI loads

On subsequent restarts: sidecars already in `/data/sidecars`, no download needed. Fast start.

---

## Out of Scope (Phase 1)

- Telegram / WhatsApp / Slack messaging bridge (opencode-router optional, may fail silently)
- Headless browser / Playwright for automated UI testing (Phase 2)
- Multi-workspace support
- Custom domain / TLS termination (handled by Railway)
