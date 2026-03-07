#!/usr/bin/env bash
set -euo pipefail

# Add Bun to PATH
export BUN_INSTALL="/root/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# Use XDG environment variables to store data in persistent volume
# This avoids changing HOME which can cause UI issues
export XDG_DATA_HOME="/data"
export XDG_CONFIG_HOME="/data/config"
export XDG_STATE_HOME="/data/state"
export XDG_CACHE_HOME="/data/cache"

# Ensure persistent directories exist
mkdir -p /data/workspace /data/state /data/config /data/cache

# ── Validate required env ────────────────────────────────────────────────────
if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "ERROR: OPENCODE_SERVER_PASSWORD is required" >&2
  exit 1
fi

# ── Generate opencode.json config from env vars ─────────────────────────────
PROVIDERS="{}"

if [ -n "${MINIMAX_API_KEY:-}" ]; then
  MINIMAX_URL="${MINIMAX_BASE_URL:-https://api.minimax.chat/v1}"
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

# Write config file
# NOTE: workspace and state are NOT valid config fields - they are controlled via XDG env vars
node -e "
  const fs = require('fs');
  const cfg = {
    '\$schema': 'https://opencode.ai/config.json',
    model: process.env.OPENCODE_MODEL || undefined
  };
  const providers = JSON.parse(process.env.PROVIDERS || '{}');
  if (Object.keys(providers).length > 0) cfg.provider = providers;
  Object.keys(cfg).forEach(k => cfg[k] === undefined && delete cfg[k]);
  fs.writeFileSync('/data/config/opencode.json', JSON.stringify(cfg, null, 2));
" PROVIDERS="$PROVIDERS"

echo "Config content:"
cat /data/config/opencode.json

# ── Start OpenCode server (background) ───────────────────────────────────────
export OPENCODE_SERVER_PASSWORD
export OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-openwork}"
export OPENCODE_CONFIG_DIR="/data/config"

bunx opencode-ai web \
  --port "${OPENCODE_PORT:-4096}" \
  --hostname 0.0.0.0 &

OPENCODE_PID=$!
echo "OpenCode started (pid $OPENCODE_PID)"

# Wait for OpenCode to be ready
sleep 5

# ── Start proxy server (foreground) ─────────────────────────────────────────
# Proxy handles HTTP Basic Auth and forwards to OpenCode
exec bun src/server-bun.js
