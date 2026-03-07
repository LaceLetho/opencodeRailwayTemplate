import http from "node:http"
import { URL } from "node:url"

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10)
const OPENCODE_PORT = Number.parseInt(process.env.OPENCODE_PORT ?? "4096", 10)
const SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? ""
const OPENCODE_WORKSPACE = process.env.OPENCODE_WORKSPACE ?? "/data/workspace"
const AUTH_COOKIE_NAME = "opencode_auth"

function parseAuthCookie(cookieHeader) {
  if (!cookieHeader) return null
  const cookies = cookieHeader.split(";").map((c) => c.trim())
  for (const cookie of cookies) {
    const [name, value] = cookie.split("=")
    if (name === AUTH_COOKIE_NAME && value) {
      try {
        return JSON.parse(Buffer.from(value, "base64").toString())
      } catch {
        return null
      }
    }
  }
  return null
}

function checkAuth(req) {
  // Check Authorization header first
  const header = req.headers.authorization ?? ""
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString()
    const colon = decoded.indexOf(":")
    if (colon !== -1) {
      const pass = decoded.slice(colon + 1)
      if (pass === SERVER_PASSWORD && SERVER_PASSWORD.length > 0) {
        return true
      }
    }
  }

  // Also check auth cookie
  const cookie = parseAuthCookie(req.headers.cookie)
  if (cookie?.password === SERVER_PASSWORD && SERVER_PASSWORD.length > 0) {
    return true
  }

  return false
}

function getAuthHeader(req) {
  // First check header
  const header = req.headers.authorization ?? ""
  if (header.startsWith("Basic ")) {
    return header
  }

  // Then check cookie
  const cookie = parseAuthCookie(req.headers.cookie)
  if (cookie?.password === SERVER_PASSWORD && SERVER_PASSWORD.length > 0) {
    const username = cookie.username ?? "opencode"
    return `Basic ${Buffer.from(`${username}:${cookie.password}`).toString("base64")}`
  }

  return null
}

function shouldSkipAuth(path) {
  // Skip auth for health check
  if (path === "/healthz") return true
  // Skip auth for static assets
  if (path.startsWith("/assets")) return true
  if (path.startsWith("/favicon")) return true
  if (path === "/site.webmanifest") return true
  if (path === "/apple-touch-icon.png") return true
  if (path === "/social-share.png") return true
  if (path === "/oc-theme-preload.js") return true
  // Auth endpoint - processes login form
  if (path === "/auth") return true
  return false
}

// Simple proxy function using Node's native http module
function proxyRequest(req, res, targetPort, extraHeaders = {}) {
  // Always add auth header to connect to OpenCode
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? ""
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`

  const options = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      ...extraHeaders,
      authorization: authHeader,
      "x-opencode-directory": OPENCODE_WORKSPACE,
    },
  }

  const proxyReq = http.request(options, (proxyRes) => {
    // Copy all response headers as-is
    res.writeHead(proxyRes.statusCode, proxyRes.headers)

    // Pipe the response
    proxyRes.pipe(res)
  })

  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message)
    if (!res.headersSent) {
      res.writeHead(502)
      res.end("Bad Gateway")
    }
  })

  // Pipe the request
  req.pipe(proxyReq)
}

// Handle auth form submission
function handleAuth(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405)
    res.end("Method Not Allowed")
    return
  }

  let body = ""
  req.on("data", (chunk) => {
    body += chunk.toString()
  })

  req.on("end", () => {
    const params = new URLSearchParams(body)
    const password = params.get("password")
    const username = params.get("username") ?? "opencode"

    if (password === SERVER_PASSWORD && SERVER_PASSWORD.length > 0) {
      // Set auth cookie (NOT HttpOnly so JavaScript can read it for fetch requests)
      const cookieValue = Buffer.from(JSON.stringify({ username, password })).toString("base64")
      res.setHeader(
        "Set-Cookie",
        `${AUTH_COOKIE_NAME}=${cookieValue}; Path=/; SameSite=Lax; Max-Age=86400`,
      )
      res.writeHead(302, { Location: "/" })
      res.end()
    } else {
      // Show error page
      res.setHeader("Content-Type", "text/html")
      res.writeHead(401)
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Unauthorized</title>
          <style>
            body { font-family: system-ui, sans-serif; max-width: 400px; margin: 100px auto; padding: 20px; }
            .error { color: red; margin-bottom: 20px; }
            input { display: block; width: 100%; padding: 8px; margin-bottom: 10px; }
            button { padding: 8px 16px; background: #0066cc; color: white; border: none; cursor: pointer; }
          </style>
        </head>
        <body>
          <h1>OpenCode Login</h1>
          <div class="error">Invalid password</div>
          <form method="POST" action="/auth">
            <input type="text" name="username" placeholder="Username" value="openwork" />
            <input type="password" name="password" placeholder="Password" required />
            <button type="submit">Login</button>
          </form>
        </body>
        </html>
      `)
    }
  })
}

// Create server
const server = http.createServer((req, res) => {
  const path = req.url?.split("?")[0] || "/"

  // Health check
  if (path === "/healthz") {
    return res.end(JSON.stringify({ ok: true }))
  }

  // Auth form submission
  if (path === "/auth") {
    return handleAuth(req, res)
  }

  const skip = shouldSkipAuth(path)

  if (skip) {
    return proxyRequest(req, res, OPENCODE_PORT)
  }

  if (checkAuth(req)) {
    return proxyRequest(req, res, OPENCODE_PORT, {
      "x-opencode-directory": OPENCODE_WORKSPACE,
    })
  }

  // Show login page for unauthenticated requests
  res.setHeader("Content-Type", "text/html")
  res.writeHead(401)
  res.end(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>OpenCode Login</title>
      <style>
        body { font-family: system-ui, sans-serif; max-width: 400px; margin: 100px auto; padding: 20px; }
        input { display: block; width: 100%; padding: 8px; margin-bottom: 10px; box-sizing: border-box; }
        button { padding: 8px 16px; background: #0066cc; color: white; border: none; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>OpenCode Login</h1>
      <form method="POST" action="/auth">
        <input type="text" name="username" placeholder="Username" value="opencode" />
        <input type="password" name="password" placeholder="Password" required />
        <button type="submit">Login</button>
      </form>
    </body>
    </html>
  `)
})

// Handle WebSocket upgrades
server.on("upgrade", (req, res) => {
  // For WebSocket, we need a different approach - use the cookie for auth
  if (!checkAuth(req)) {
    res.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenCode\"\r\n\r\n")
    res.destroy()
    return
  }

  const options = {
    hostname: "127.0.0.1",
    port: OPENCODE_PORT,
    path: req.url,
    method: "GET",
    headers: {
      ...req.headers,
      "x-opencode-directory": OPENCODE_WORKSPACE,
      connection: "upgrade",
      upgrade: "websocket",
    },
  }

  // Inject Authorization header - always use env vars
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? ""
  options.headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`

  const proxyReq = http.request(options, (proxyRes) => {
    res.write(`HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`)
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value) res.write(`${key}: ${value}\r\n`)
    }
    res.write("\r\n")
    proxyRes.pipe(res)
  })

  proxyReq.on("error", (err) => {
    console.error("WebSocket proxy error:", err.message)
    res.destroy()
  })

  req.pipe(proxyReq)
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on :${PORT} → 127.0.0.1:${OPENCODE_PORT}`)
})
