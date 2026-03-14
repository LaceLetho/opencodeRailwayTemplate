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
| `OPENCODE_SERVER_PASSWORD` | Password for HTTP Basic Auth (username: `opencode`) |

At least one AI provider key must be set.

## Two ways to use

### 1. Web UI (Browser)

Open your Railway deployment URL in a browser. Enter the username (`opencode`) and password you configured.

### 2. Terminal (CLI)

Connect with the OpenCode CLI for a better terminal experience:

```bash
# Install OpenCode locally first
npm install -g opencode-ai

# Attach to your remote server
opencode attach https://opencoderailwaytemplate-production-xxx.up.railway.app/ -p YOUR_PASSWORD
```

## Volume

Mount a Railway volume at `/data` — this persists workspace and state data.

## Architecture

```
Internet → OpenCode Web (PORT)
              ↕
         app.opencode.ai (UI)
```

OpenCode's built-in web server handles everything — HTTP server, authentication, and UI proxy to app.opencode.ai.
