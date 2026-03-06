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
