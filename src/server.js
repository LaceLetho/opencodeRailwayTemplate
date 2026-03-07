import http from "node:http"
import express from "express"
import httpProxy from "http-proxy"

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10)
const OPENCODE_PORT = Number.parseInt(process.env.OPENCODE_PORT ?? "4096", 10)
const SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? ""
const TARGET = `http://127.0.0.1:${OPENCODE_PORT}`

function checkAuth(req) {
  const header = req.headers.authorization ?? ""

  // Check Basic auth (for browser access)
  if (!header.startsWith("Basic ")) return false
  const decoded = Buffer.from(header.slice(6), "base64").toString()
  const colon = decoded.indexOf(":")
  if (colon === -1) return false
  const pass = decoded.slice(colon + 1)
  return pass === SERVER_PASSWORD && SERVER_PASSWORD.length > 0
}

export function createProxyServer() {
  const app = express()
  const proxy = httpProxy.createProxyServer({ ws: true })

  proxy.on("error", (err, _req, res) => {
    if (res && !res.headersSent) {
      res.status(502).json({ error: "upstream unavailable" })
    }
  })

  // Health check endpoint (bypass auth)
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true })
  })

  // Auth middleware for all other routes
  app.use((req, res, next) => {
    // Skip auth for health check
    if (req.path === "/healthz") return next()
    if (checkAuth(req)) return next()
    res.set("www-authenticate", 'Basic realm="OpenCode"')
    res.status(401).send("Unauthorized")
  })

  app.use((req, res) => {
    proxy.web(req, res, {
      target: TARGET,
      headers: {
        "x-opencode-directory": process.env.OPENCODE_WORKSPACE || "/data/workspace",
      },
    })
  })

  const server = http.createServer(app)

  server.on("upgrade", (req, socket, head) => {
    if (!checkAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenCode\"\r\n\r\n")
      socket.destroy()
      return
    }
    proxy.ws(req, socket, head, {
      target: TARGET.replace("http://", "ws://"),
      headers: {
        "x-opencode-directory": process.env.OPENCODE_WORKSPACE || "/data/workspace",
      },
    })
  })

  return server
}

// Only start listening when run directly (not imported in tests)
if (process.argv[1] === new URL(import.meta.url).pathname) {
  createProxyServer().listen(PORT, () => {
    console.log(`proxy listening on :${PORT} → ${TARGET}`)
  })
}
