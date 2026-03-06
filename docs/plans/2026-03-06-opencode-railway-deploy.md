# OpenCode Railway Deploy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a Railway one-click deploy template that runs OpenCode + OpenWork as an always-on autonomous AI coding agent, accessible via OpenWork UI behind HTTP Basic Auth.

**Architecture:** `openwork-orchestrator` (npm) manages OpenCode + OpenWork-server + opencode-router as sidecars. A thin Node.js reverse proxy listens on Railway's `$PORT`, applies HTTP Basic Auth, and WebSocket-proxies all traffic to OpenWork-server on `:8787`. A `start.sh` script generates `OPENCODE_CONFIG_CONTENT` JSON at boot from API key env vars, then launches both processes.

**Tech Stack:** Node.js 22, Express 5, http-proxy, openwork-orchestrator (npm), tini, Docker, Railway

---

## Reference Files

Before starting, read these files for context and patterns to follow:

- `openclaw-railway-template/src/server.js` — reference proxy implementation (auth, WebSocket, healthz)
- `openclaw-railway-template/Dockerfile` — reference Dockerfile structure (tini, multi-stage awareness)
- `openclaw-railway-template/railway.toml` — reference Railway config (healthcheck, volume, variables)
- `openclaw-railway-template/package.json` — reference deps (express, http-proxy)
- `opencodeRailwayTemplate/docs/plans/2026-03-06-opencode-railway-deploy-design.md` — approved design doc

---

## Task 1: Initialize project files

**Files:**
- Create: `package.json`
- Modify: `.gitignore` (already exists)

**Step 1: Write package.json**

```json
{
  "name": "opencode-railway-template",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "start": "bash start.sh",
    "dev:proxy": "node src/server.js",
    "test": "node --test",
    "lint": "node -c src/server.js"
  },
  "dependencies": {
    "express": "^5.1.0",
    "http-proxy": "^1.18.1"
  }
}
```

Run: `npm install` from `opencodeRailwayTemplate/`
Expected: `node_modules/` created, `package-lock.json` written

**Step 2: Append node_modules to .gitignore**

Add to `.gitignore`:
```
node_modules/
package-lock.json
```

**Step 3: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: initialize project with package.json"
```

---

## Task 2: Implement proxy server with HTTP Basic Auth (TDD)

**Files:**
- Create: `src/server.js`
- Create: `test/server.test.js`

### Step 1: Write failing tests

Create `test/server.test.js`:

```js
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

// Fake upstream server that openwork-server would be
let upstream
let upstreamPort

before(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ proxied: true, path: req.url }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  upstreamPort = upstream.address().port
})

after(() => new Promise((resolve) => upstream.close(resolve)))

// Helper: start our proxy server pointing to the fake upstream
async function startProxy(password) {
  process.env.SETUP_PASSWORD = password
  process.env.OPENWORK_PORT = String(upstreamPort)
  process.env.PORT = "0"
  const { createProxyServer } = await import("../src/server.js")
  const srv = createProxyServer()
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve))
  return srv
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on("error", reject)
    req.end()
  })
}

function basicAuth(user, pass) {
  return { authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") }
}

describe("proxy server", () => {
  it("GET /healthz returns 200 without auth", async () => {
    const srv = await startProxy("secret")
    const port = srv.address().port
    const res = await get(port, "/healthz")
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    await new Promise((r) => srv.close(r))
  })

  it("GET / without auth returns 401", async () => {
    const srv = await startProxy("secret")
    const port = srv.address().port
    const res = await get(port, "/")
    assert.equal(res.status, 401)
    assert.ok(res.headers["www-authenticate"])
    await new Promise((r) => srv.close(r))
  })

  it("GET / with wrong password returns 401", async () => {
    const srv = await startProxy("secret")
    const port = srv.address().port
    const res = await get(port, "/", basicAuth("openwork", "wrong"))
    assert.equal(res.status, 401)
    await new Promise((r) => srv.close(r))
  })

  it("GET / with correct credentials proxies to upstream", async () => {
    const srv = await startProxy("secret")
    const port = srv.address().port
    const res = await get(port, "/some/path", basicAuth("openwork", "secret"))
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.proxied, true)
    assert.equal(body.path, "/some/path")
    await new Promise((r) => srv.close(r))
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
cd opencodeRailwayTemplate
npm test
```
Expected: FAIL — `Cannot find module '../src/server.js'`

**Step 3: Implement src/server.js**

Create `src/server.js`:

```js
import http from "node:http"
import express from "express"
import httpProxy from "http-proxy"

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10)
const OPENWORK_PORT = Number.parseInt(process.env.OPENWORK_PORT ?? "8787", 10)
const PASSWORD = process.env.SETUP_PASSWORD ?? ""
const TARGET = `http://127.0.0.1:${OPENWORK_PORT}`

function checkAuth(req) {
  const header = req.headers.authorization ?? ""
  if (!header.startsWith("Basic ")) return false
  const decoded = Buffer.from(header.slice(6), "base64").toString()
  const colon = decoded.indexOf(":")
  if (colon === -1) return false
  const pass = decoded.slice(colon + 1)
  return pass === PASSWORD && PASSWORD.length > 0
}

export function createProxyServer() {
  const app = express()
  const proxy = httpProxy.createProxyServer({ ws: true })

  proxy.on("error", (err, _req, res) => {
    if (res && !res.headersSent) {
      res.status(502).json({ error: "upstream unavailable" })
    }
  })

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true })
  })

  app.use((req, res, next) => {
    if (checkAuth(req)) return next()
    res.set("www-authenticate", 'Basic realm="OpenWork"')
    res.status(401).send("Unauthorized")
  })

  app.use((req, res) => {
    proxy.web(req, res, { target: TARGET })
  })

  const server = http.createServer(app)

  server.on("upgrade", (req, socket, head) => {
    if (!checkAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenWork\"\r\n\r\n")
      socket.destroy()
      return
    }
    proxy.ws(req, socket, head, { target: TARGET.replace("http://", "ws://") })
  })

  return server
}

// Only start listening when run directly (not imported in tests)
if (process.argv[1] === new URL(import.meta.url).pathname) {
  createProxyServer().listen(PORT, () => {
    console.log(`proxy listening on :${PORT} → ${TARGET}`)
  })
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: add HTTP Basic Auth reverse proxy with WebSocket support"
```

---

## Task 3: Write start.sh (config generation + process launch)

**Files:**
- Create: `start.sh`

**Step 1: Create start.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Ensure persistent directories exist
mkdir -p /data/workspace /data/sidecars /data/openwork

# ── Generate OPENCODE_CONFIG_CONTENT from env vars ──────────────────────────
# Build provider JSON only for keys that are set.
# Anthropic auto-discovers ANTHROPIC_API_KEY; no explicit block needed.

PROVIDERS="{}"

if [ -n "${MINIMAX_API_KEY:-}" ]; then
  MINIMAX_URL="${MINIMAX_BASE_URL:-https://api.minimax.chat/v1}"
  MINIMAX_BLOCK=$(cat <<MBLOCK
"minimax": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "name": "minimax",
        "apiKey": "${MINIMAX_API_KEY}",
        "baseURL": "${MINIMAX_URL}"
      }
    }
MBLOCK
)
  PROVIDERS=$(node -e "
    const p = JSON.parse(process.env.PROVIDERS || '{}');
    p.minimax = {
      npm: '@ai-sdk/openai-compatible',
      options: { name: 'minimax', apiKey: process.env.MINIMAX_API_KEY, baseURL: process.env.MINIMAX_URL }
    };
    process.stdout.write(JSON.stringify(p));
  " PROVIDERS="$PROVIDERS" MINIMAX_API_KEY="$MINIMAX_API_KEY" MINIMAX_URL="$MINIMAX_URL")
fi

if [ -n "${GLM_API_KEY:-}" ]; then
  GLM_URL="${GLM_BASE_URL:-https://open.bigmodel.cn/api/paas/v4}"
  PROVIDERS=$(node -e "
    const p = JSON.parse(process.env.PROVIDERS || '{}');
    p.zhipu = {
      npm: '@ai-sdk/openai-compatible',
      options: { name: 'zhipu', apiKey: process.env.GLM_API_KEY, baseURL: process.env.GLM_URL }
    };
    process.stdout.write(JSON.stringify(p));
  " PROVIDERS="$PROVIDERS" GLM_API_KEY="$GLM_API_KEY" GLM_URL="$GLM_URL")
fi

MODEL="${OPENCODE_MODEL:-}"

export OPENCODE_CONFIG_CONTENT=$(node -e "
  const cfg = { '\$schema': 'https://opencode.ai/config.json' };
  const model = process.env.MODEL;
  if (model) cfg.model = model;
  const providers = JSON.parse(process.env.PROVIDERS || '{}');
  if (Object.keys(providers).length > 0) cfg.provider = providers;
  process.stdout.write(JSON.stringify(cfg));
" MODEL="$MODEL" PROVIDERS="$PROVIDERS")

echo "opencode config: $OPENCODE_CONFIG_CONTENT"

# ── Validate required env ────────────────────────────────────────────────────
if [ -z "${SETUP_PASSWORD:-}" ]; then
  echo "ERROR: SETUP_PASSWORD is required" >&2
  exit 1
fi

# ── Start proxy (background) ─────────────────────────────────────────────────
node src/server.js &
PROXY_PID=$!
echo "proxy started (pid $PROXY_PID)"

# ── Start openwork orchestrator (foreground) ─────────────────────────────────
exec openwork serve \
  --workspace /data/workspace \
  --approval auto \
  --no-tui \
  --openwork-port "${OPENWORK_PORT:-8787}"
```

Make it executable:
```bash
chmod +x start.sh
```

**Step 2: Test config generation locally**

```bash
# Test with Minimax key set
SETUP_PASSWORD=test MINIMAX_API_KEY=mk-123 MINIMAX_BASE_URL=https://api.minimax.chat/v1 \
  bash -c 'source start.sh; echo "CONFIG: $OPENCODE_CONFIG_CONTENT"' 2>/dev/null || true

# Test with GLM key set
SETUP_PASSWORD=test GLM_API_KEY=glm-456 bash -c '
  export MINIMAX_API_KEY=""
  source start.sh
' 2>/dev/null || true
```

Expected: JSON printed to stdout containing the correct provider blocks

**Step 3: Commit**

```bash
git add start.sh
git commit -m "feat: add startup script with dynamic provider config generation"
```

---

## Task 4: Write Dockerfile

**Files:**
- Create: `Dockerfile`

**Step 1: Create Dockerfile**

```dockerfile
FROM node:22-bookworm

ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

# Install openwork-orchestrator (ships with pre-compiled Linux binary)
RUN npm install -g openwork-orchestrator && npm cache clean --force

# Persist openwork sidecar cache to Railway volume by default
ENV OPENWORK_SIDECAR_DIR=/data/sidecars
ENV OPENWORK_DATA_DIR=/data/openwork
ENV OPENCODE_WORKSPACE=/data/workspace

WORKDIR /app

# Install proxy server deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY start.sh ./

# Railway injects PORT at runtime. Do not hardcode.
EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["bash", "start.sh"]
```

**Step 2: Verify Dockerfile syntax (no build needed yet)**

```bash
docker build --check . 2>/dev/null || docker build --dry-run . 2>/dev/null || echo "syntax ok"
```

Note: Full Docker build test is in Task 6.

**Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: add Dockerfile with openwork-orchestrator"
```

---

## Task 5: Write railway.toml

**Files:**
- Create: `railway.toml`

**Step 1: Create railway.toml**

```toml
[build]
builder = "dockerfile"

[deploy]
healthcheckPath = "/healthz"
healthcheckTimeout = 300
restartPolicyType = "on_failure"

# A persistent volume must be mounted at /data.
requiredMountPath = "/data"

[variables]
# Internal port for OpenWork server (proxy forwards here).
OPENWORK_PORT = "8787"
# Sidecar binaries are cached here across restarts.
OPENWORK_SIDECAR_DIR = "/data/sidecars"
# OpenWork server state directory.
OPENWORK_DATA_DIR = "/data/openwork"
# OpenCode workspace directory.
OPENCODE_WORKSPACE = "/data/workspace"
# NOTE: Do NOT set PORT here. Railway injects it at runtime.
# Required user variables (set in Railway dashboard):
#   SETUP_PASSWORD  — HTTP Basic Auth password
#   ANTHROPIC_API_KEY / MINIMAX_API_KEY / GLM_API_KEY — at least one
#   OPENCODE_MODEL  — optional, e.g. anthropic/claude-sonnet-4-5
```

**Step 2: Commit**

```bash
git add railway.toml
git commit -m "feat: add railway.toml with healthcheck and volume config"
```

---

## Task 6: Local Docker smoke test

**Goal:** Verify the container starts, proxy responds, and auth works correctly.

**Prerequisites:** Docker installed locally.

**Step 1: Build the image**

```bash
cd opencodeRailwayTemplate
docker build -t opencode-railway-test .
```
Expected: Build succeeds. `openwork` binary installed.

**Step 2: Run container with mock env (no real API keys needed)**

```bash
docker run --rm -d \
  --name oc-test \
  -p 3333:3333 \
  -e PORT=3333 \
  -e SETUP_PASSWORD=testpass \
  -e OPENWORK_PORT=8787 \
  -v /tmp/oc-test-data:/data \
  opencode-railway-test
```

Wait ~10 seconds for openwork to start downloading sidecars.

**Step 3: Verify healthz (no auth)**

```bash
curl -s http://localhost:3333/healthz
```
Expected: `{"ok":true}`

**Step 4: Verify auth rejection**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3333/
```
Expected: `401`

**Step 5: Verify auth with correct credentials**

```bash
curl -s -o /dev/null -w "%{http_code}" -u openwork:testpass http://localhost:3333/
```
Expected: Either `200` (if openwork is up) or `502` (proxy up, openwork still starting). Either is correct — proxy is working.

**Step 6: Check container logs**

```bash
docker logs oc-test 2>&1 | head -40
```
Expected: Lines showing `proxy listening on :3333`, `openwork serve` starting, sidecar download progress.

**Step 7: Stop container**

```bash
docker stop oc-test
```

**Step 8: Commit final state**

```bash
git add .
git commit -m "chore: complete Phase 1 Railway template (OpenCode + OpenWork)"
```

---

## Task 7: Write README

**Files:**
- Create: `README.md`

**Step 1: Create README.md**

```markdown
# OpenCode Railway Template

One-click Railway deploy for [OpenCode](https://opencode.ai) + [OpenWork](https://github.com/LaceLetho/openwork) — an always-on autonomous AI coding agent.

## Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/YOUR_TEMPLATE_ID)

## What this deploys

- **OpenCode** — AI coding agent (headless API server)
- **OpenWork** — Web UI to send requirements and view results
- **Reverse proxy** — HTTP Basic Auth protecting the UI

## Required environment variables

| Variable | Description |
|----------|-------------|
| `SETUP_PASSWORD` | Password for the OpenWork UI (username: `openwork`) |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key (optional if using other providers) |
| `MINIMAX_API_KEY` | Minimax API key (optional) |
| `GLM_API_KEY` | ZhipuAI GLM API key (optional) |

At least one AI provider key must be set.

## Optional variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_MODEL` | `anthropic/claude-sonnet-4-5` | Default model (`provider/model-id`) |
| `MINIMAX_BASE_URL` | `https://api.minimax.chat/v1` | Minimax API base URL |
| `GLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | ZhipuAI API base URL |

## Volume

Mount a Railway volume at `/data` — this persists the workspace, OpenWork state, and sidecar cache.

## First boot

On first boot, `openwork-orchestrator` downloads its sidecars (~200MB). Subsequent restarts are fast as the cache lives on the volume.

## Architecture

```
Internet → proxy ($PORT) → OpenWork server (:8787)
                               ↕
                          OpenCode (:4096)
```
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with deploy instructions"
```

---

## Done

After all tasks pass, the template is ready to push to `LaceLetho/opencodeRailwayTemplate` and register as a Railway template.

**Verification checklist:**
- [ ] `npm test` passes (4 proxy auth tests)
- [ ] `docker build` succeeds
- [ ] `curl /healthz` returns `{"ok":true}` with no auth
- [ ] `curl /` without auth returns `401`
- [ ] `curl /` with correct credentials returns `200` or `502` (proxy working)
- [ ] Container logs show both proxy and openwork starting
