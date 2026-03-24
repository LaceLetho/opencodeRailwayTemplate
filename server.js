#!/usr/bin/env node
/**
 * OpenCode Railway Wrapper
 * 提供优雅关闭、日志分类和 Basic Auth 代理功能
 */

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const { proxyWebSocketUpgrade } = require("./ws-proxy");

const PORT = process.env.PORT || "8080";
const INTERNAL_PORT = process.env.INTERNAL_PORT || "18080";
const PLUGIN_PORT = process.env.OPENCLAW_PLUGIN_PORT || "9090";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;
const USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_REALM = process.env.AUTH_REALM || "opencode.tradao.xyz";
const SESSION_SECRET = process.env.OPENCODE_SESSION_SECRET || PASSWORD;
const SESSION_COOKIE = "opencode_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const logLevel = process.env.LOG_LEVEL?.toUpperCase() || "WARN";
const debugTraffic = process.env.DEBUG_OPENCODE_TRAFFIC === "true";

if (!PASSWORD) {
  console.error("ERROR: OPENCODE_SERVER_PASSWORD is required");
  process.exit(1);
}

// 创建持久化目录
const dirs = [
  "/data/workspace",
  "/data/.local/share/opencode",
  "/data/.local/state/opencode",
  "/data/.config/opencode",
];
for (const dir of dirs) {
  fs.mkdirSync(dir, { recursive: true });
}

// 设置环境变量
process.env.HOME = "/data";
process.env.OPENCODE_CONFIG_DIR = "/data/.config/opencode";
process.env.OPENCODE_CONFIG = "/data/.config/opencode/config.json";
// 内部 OpenCode 不需要 Basic Auth，由代理层处理
process.env.OPENCODE_SERVER_PASSWORD = "";
delete process.env.OPENCODE_SERVER_PASSWORD;

// Set OpenClaw plugin environment variables
process.env.OPENCLAW_PORT = PLUGIN_PORT;

// Ensure opencode.json config file declares the OpenClaw plugin.
// OpenCode will install and load the plugin at runtime from this config.
// Note: the correct config key is "plugin" (singular), not "plugins".
function ensurePluginConfig() {
  const configPath = "/data/.config/opencode/opencode.json";

  try {
    let config = {};

    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf8");
      config = JSON.parse(content);
    }

    // Remove stale "plugins" key written by a previous deployment (caused ConfigInvalidError)
    if (config.plugins !== undefined) {
      delete config.plugins;
    }

    // Ensure "plugin" array exists and contains the OpenClaw plugin
    if (!config.plugin) {
      config.plugin = [];
    }

    const pluginName = "@laceletho/plugin-openclaw";
    if (!config.plugin.includes(pluginName)) {
      config.plugin.push(pluginName);
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  } catch (err) {
    console.error("[wrapper] Failed to update plugin config:", err.message);
  }
}

ensurePluginConfig();

console.log(`Starting OpenCode Web on port ${PORT}...`);
console.log(`Internal port: ${INTERNAL_PORT}`);
console.log(`Plugin port: ${PLUGIN_PORT}`);
console.log(`Workspace: /data/workspace`);
console.log(`Log level: ${logLevel} (set LOG_LEVEL env var to change: DEBUG, INFO, WARN, ERROR)`);
if (debugTraffic) {
  console.log("OpenCode traffic debug logging enabled");
}

// 启动无头 opencode server（内部端口，不直接暴露）
const opencode = spawn(
  "bunx",
  ["opencode", "--print-logs", "--log-level", logLevel, "serve", "--port", INTERNAL_PORT, "--hostname", "127.0.0.1"],
  {
    cwd: "/data/workspace/tradao",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  }
);

let receivedSigterm = false;

function shouldSuppressLog(trimmed) {
  if (debugTraffic) return false;
  if (trimmed.includes('Executable not found in $PATH: "xdg-open"')) return true;
  if (
    trimmed.startsWith("INFO") &&
    trimmed.includes("service=server") &&
    (
      trimmed.includes("path=/global/health") ||
      trimmed.includes("path=/pty/")
    )
  ) return true;
  if (
    trimmed.startsWith("INFO") &&
    trimmed.includes("service=pty") &&
    (
      trimmed.includes("client connected to session") ||
      trimmed.includes("client disconnected from session")
    )
  ) return true;
  if (
    trimmed.startsWith("ERROR") &&
    trimmed.includes("service=mcp") &&
    trimmed.includes("failed to get prompts") &&
    trimmed.includes("Method not found")
  ) return true;
  return false;
}

// 日志分类：ERROR/WARN -> stderr，其他 -> stdout
function classifyAndOutput(line) {
  const trimmed = line.toString().trim();
  if (!trimmed) return;
  if (shouldSuppressLog(trimmed)) return;

  if (trimmed.startsWith("ERROR") || trimmed.startsWith("WARN")) {
    console.error(trimmed);
  } else {
    console.log(trimmed);
  }
}

// 处理 stdout
opencode.stdout?.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (line) classifyAndOutput(line);
  }
});

// 处理 stderr
opencode.stderr?.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (line) classifyAndOutput(line);
  }
});

// 错误处理
opencode.on("error", (err) => {
  console.error(`[wrapper] Failed to spawn opencode: ${err.message}`);
  process.exit(1);
});

// 进程退出处理
opencode.on("exit", (code, signal) => {
  console.log(`[wrapper] opencode exited with code=${code}, signal=${signal}`);
  process.exit(code ?? 0);
});

// 等待 OpenCode 启动
async function waitForOpencode(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/global/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // 还没准备好
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function parseBasicAuth(req) {
  const auth = req.headers.authorization;
  if (!auth) return;

  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) return;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  if (!user || pass === undefined) return;
  return { user, pass };
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function checkBasicAuth(req) {
  const auth = parseBasicAuth(req);
  if (!auth) return false;
  return timingSafeEqual(auth.user, USERNAME) && timingSafeEqual(auth.pass, PASSWORD);
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const cookies = {};
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signSession(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function createSessionToken() {
  const payload = JSON.stringify({
    u: USERNAME,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
  });
  const encoded = base64url(payload);
  return `${encoded}.${signSession(encoded)}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;
  const expected = signSession(encoded);
  if (!timingSafeEqual(signature, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.u !== USERNAME) return false;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function hasValidSession(req) {
  return verifySessionToken(parseCookies(req)[SESSION_COOKIE]);
}

function isAuthenticated(req) {
  return checkBasicAuth(req) || hasValidSession(req);
}

function sessionCookieValue(token, maxAge) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  return attrs.join("; ");
}

function setSessionCookie(res) {
  res.setHeader("Set-Cookie", sessionCookieValue(createSessionToken(), SESSION_TTL_SECONDS));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", sessionCookieValue("", 0));
}

function sendUnauthorized(res) {
  res.writeHead(401, {
    "WWW-Authenticate": `Basic realm="${AUTH_REALM}"`,
    "Content-Type": "text/plain",
    "Cache-Control": "no-store",
  });
  res.end("Authentication required\n");
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, {
    Location: location,
    "Cache-Control": "no-store",
  });
  res.end();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderLoginPage(message = "") {
  const detail = message
    ? `<p class="msg">${escapeHtml(message)}</p>`
    : `<p class="hint">Use the same password you already configured for OpenCode.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="theme-color" content="#f6f3ee" />
    <title>OpenCode Login</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(160deg, #f6f3ee 0%, #e7dfd3 100%);
        color: #1f1a17;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(100%, 420px);
        background: rgba(255, 252, 247, 0.94);
        border: 1px solid rgba(71, 57, 46, 0.12);
        border-radius: 20px;
        box-shadow: 0 24px 80px rgba(60, 43, 30, 0.14);
        padding: 28px;
      }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p { margin: 0 0 18px; line-height: 1.5; }
      .msg { color: #9f2f2f; }
      .hint { color: #5a4b3f; }
      label { display: block; margin: 0 0 8px; font-size: 14px; font-weight: 600; }
      input {
        width: 100%;
        margin: 0 0 14px;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid #cbbcab;
        background: #fffdf9;
        font-size: 16px;
      }
      button {
        width: 100%;
        border: 0;
        border-radius: 12px;
        padding: 12px 14px;
        background: #1f1a17;
        color: #fffaf3;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>OpenCode</h1>
      <p>Browser sessions use a secure cookie. CLI and automation can keep using HTTP Basic Auth.</p>
      ${detail}
      <form method="post" action="/login">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" value="${escapeHtml(USERNAME)}" autocomplete="username" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign In</button>
      </form>
    </main>
  </body>
</html>`;
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  return {
    username: params.get("username") || "",
    password: params.get("password") || "",
  };
}

function pathnameOf(url) {
  return url.split("?")[0].split("#")[0];
}

function isStaticAsset(pathname) {
  return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json)$/.test(pathname);
}

function isHtmlNavigation(req, pathname, isApiReq, isPluginReq) {
  if (req.method !== "GET") return false;
  if (isApiReq || isPluginReq) return false;
  if (isStaticAsset(pathname)) return false;
  const accept = req.headers.accept || "";
  return accept.includes("text/html") || accept.includes("*/*") || accept === "";
}

// 插件端点列表 - 这些端点会路由到插件端口
// 注意：只匹配精确的插件端点，避免与 OpenCode 的 /global/health 等端点冲突
const PLUGIN_ENDPOINTS = ['/register'];
const PLUGIN_PREFIXES = ['/register/'];
const PUBLIC_PATHS = new Set([
  "/favicon.ico",
  "/favicon-v3.ico",
  "/favicon-v3.svg",
  "/favicon-96x96-v3.png",
  "/apple-touch-icon-v3.png",
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
]);

// OpenCode HTTP API 端点前缀 - 这些端点路由到 OpenCode 服务
const OPENCODE_API_PREFIXES = [
  '/session',
  '/global',
  '/agents',
  '/tools',
  '/events',
  '/v2',
  '/api'
];

// 检查请求是否是插件端点
function isPluginEndpoint(url) {
  const pathname = pathnameOf(url);
  // 精确匹配
  if (PLUGIN_ENDPOINTS.includes(pathname)) return true;
  // 前缀匹配
  if (PLUGIN_PREFIXES.some(prefix => pathname.startsWith(prefix))) return true;
  return false;
}

// 检查请求是否是 OpenCode API 端点
function isOpencodeApiEndpoint(url) {
  const pathname = pathnameOf(url);
  return OPENCODE_API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'));
}

function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname);
}

function normalizeCspValue(value) {
  if (!value) return "";
  return Array.isArray(value) ? value.join("; ") : value;
}

function appendCspSource(policy, directive, source) {
  const trimmed = policy.trim();
  if (!trimmed) return `${directive} ${source}`;

  const parts = trimmed
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const index = parts.findIndex((part) => part === directive || part.startsWith(`${directive} `));
  if (index === -1) {
    parts.push(`${directive} ${source}`);
    return parts.join("; ");
  }

  const tokens = parts[index].split(/\s+/);
  if (!tokens.includes(source)) {
    tokens.push(source);
    parts[index] = tokens.join(" ");
  }
  return parts.join("; ");
}

function applyCspRelaxation(headers) {
  const next = { ...headers };
  let policy = normalizeCspValue(next["content-security-policy"]);
  if (!policy) return next;

  policy = appendCspSource(policy, "script-src", "https://static.cloudflareinsights.com");
  policy = appendCspSource(policy, "connect-src", "https://opencode.ai");
  next["content-security-policy"] = policy;
  return next;
}

function handleLoginPage(res, message) {
  const body = renderLoginPage(message);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src https://static.cloudflareinsights.com; style-src 'unsafe-inline'; form-action 'self'; img-src 'self' data: https:; base-uri 'none'",
  });
  res.end(body);
}

async function handleLogin(req, res) {
  try {
    const body = await collectRequestBody(req);
    const form = parseForm(body);
    if (!timingSafeEqual(form.username, USERNAME) || !timingSafeEqual(form.password, PASSWORD)) {
      handleLoginPage(res, "Invalid username or password.");
      return;
    }

    setSessionCookie(res);
    redirect(res, "/");
  } catch (err) {
    console.error("[auth error]", err.message);
    res.writeHead(400, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    res.end("Bad request\n");
  }
}

function proxyRequest(req, res, targetPort) {
  const forwardHeaders = { ...req.headers };
  delete forwardHeaders.host;
  delete forwardHeaders.authorization;
  delete forwardHeaders.cookie;

  let proxyPath = req.url;
  if (proxyPath === '/events' || proxyPath.startsWith('/events?')) {
    proxyPath = proxyPath.replace('/events', '/global/event');
  }

  const options = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: proxyPath,
    method: req.method,
    headers: forwardHeaders,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, applyCspRelaxation(proxyRes.headers));
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    console.error("[proxy error]", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Gateway error\n");
    }
  });

  req.pipe(proxyReq);
}

// 创建代理服务器
const server = http.createServer(async (req, res) => {
  const pathname = pathnameOf(req.url);
  const isApiReq = isOpencodeApiEndpoint(req.url);
  const isPluginReq = isPluginEndpoint(req.url);
  const isPublicReq = isPublicPath(pathname);

  if (pathname === "/login" && (req.method === "GET" || req.method === "HEAD")) {
    handleLoginPage(res);
    return;
  }

  if (pathname === "/login" && req.method === "POST") {
    await handleLogin(req, res);
    return;
  }

  if (pathname === "/logout" && (req.method === "POST" || req.method === "GET")) {
    clearSessionCookie(res);
    redirect(res, "/login");
    return;
  }

  if (isPublicReq) {
    proxyRequest(req, res, INTERNAL_PORT);
    return;
  }

  if (!isAuthenticated(req)) {
    if (isHtmlNavigation(req, pathname, isApiReq, isPluginReq)) {
      redirect(res, "/login");
      return;
    }
    sendUnauthorized(res);
    return;
  }

  if (process.env.DEBUG_PROXY) {
    console.log(`[proxy] ${req.method} ${req.url}`);
  }

  const targetPort = isPluginReq ? PLUGIN_PORT : INTERNAL_PORT;
  proxyRequest(req, res, targetPort);
});

// WebSocket 升级处理
server.on('upgrade', (req, socket, head) => {
  if (!isAuthenticated(req)) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`);
    socket.end();
    return;
  }

  proxyWebSocketUpgrade({
    req,
    socket,
    head,
    targetPort: INTERNAL_PORT,
    onError: (err) => {
      console.error('[websocket error]', err.message);
    },
  });
});

// 启动监控脚本
function startMonitor() {
  const enableMonitor = process.env.ENABLE_MONITOR !== "false";
  if (!enableMonitor) {
    return;
  }

  const { spawn } = require("child_process");
  const fs = require("fs");

  const monitorScript = "/app/monitor.sh";

  if (fs.existsSync(monitorScript)) {
    fs.chmodSync(monitorScript, 0o755);

    const logStream = fs.createWriteStream("/tmp/opencode_monitor.log", { flags: "a" });

    const monitor = spawn("bash", [monitorScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 只记录错误级别日志到控制台，全部日志写入文件
    monitor.stdout.on("data", (data) => {
      logStream.write(data.toString());
    });
    monitor.stderr.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line) {
          console.error("[monitor] " + line);
          logStream.write("[stderr] " + line + "\n");
        }
      }
    });

    monitor.on("error", (err) => {
      console.error("[wrapper] Monitor error:", err.message);
    });

    monitor.unref();
    fs.writeFileSync("/tmp/opencode_monitor.pid", monitor.pid.toString());
    console.log("[wrapper] Monitor started");
  }
}

// 启动服务器
async function start() {
  // 等待 OpenCode 启动
  console.log("[wrapper] Waiting for OpenCode to start...");
  const ready = await waitForOpencode();
  if (!ready) {
    console.error("[wrapper] OpenCode failed to start within timeout");
    process.exit(1);
  }
  console.log("[wrapper] OpenCode is ready");

  // 启动监控（在OpenCode就绪后）
  startMonitor();

  // 启动代理服务器
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[wrapper] Proxy server listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error("[wrapper] Failed to start:", err);
  process.exit(1);
});

// 优雅关闭函数
function gracefulShutdown(signal) {
  if (receivedSigterm) {
    console.log(`[wrapper] Already shutting down, ignoring ${signal}`);
    return;
  }
  receivedSigterm = true;

  console.log(`[wrapper] Received ${signal}, initiating graceful shutdown...`);

  // 关闭代理服务器
  server.close(() => {
    console.log("[wrapper] Proxy server closed");
  });

  // 发送 SIGTERM 给子进程
  if (opencode.pid) {
    try {
      opencode.kill("SIGTERM");
      console.log("[wrapper] Sent SIGTERM to opencode");
    } catch (err) {
      console.error(`[wrapper] Failed to kill opencode: ${err.message}`);
    }
  }

  // 5秒超时后强制退出
  setTimeout(() => {
    console.error("[wrapper] Graceful shutdown timeout (5s), forcing exit");
    process.exit(1);
  }, 5000);
}

// 注册信号处理
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// 意外错误处理
process.on("uncaughtException", (err) => {
  console.error("[wrapper] Uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  console.error("[wrapper] Unhandled rejection:", reason);
  gracefulShutdown("unhandledRejection");
});
