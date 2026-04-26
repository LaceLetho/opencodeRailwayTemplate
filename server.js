#!/usr/bin/env node
/**
 * OpenCode Railway Wrapper
 * Provides graceful shutdown, log classification, and Basic Auth proxying
 */

const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { proxyWebSocketUpgrade } = require("./ws-proxy");
const { resolveOpencodeLaunch } = require("./launch");
const { ensureOhMyPluginCache, refreshPluginCache } = require("./plugin-refresh");
const { ensureRuntimeConfigs } = require("./runtime-config");
const { isSourceMode } = require("./source-mode");

const PORT = process.env.PORT || "8080";
const INTERNAL_PORT = process.env.INTERNAL_PORT || "18080";
const PLUGIN_PORT = process.env.OPENCLAW_PLUGIN_PORT || "9090";
const WORKSPACE = process.env.OPENCODE_WORKSPACE || "/data/workspace";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;
const USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_REALM = process.env.AUTH_REALM || "opencode.tradao.xyz";
const SESSION_SECRET = process.env.OPENCODE_SESSION_SECRET || PASSWORD;
const SESSION_COOKIE = "opencode_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const logLevel = process.env.LOG_LEVEL?.toUpperCase() || "WARN";
const debugTraffic = process.env.DEBUG_OPENCODE_TRAFFIC === "true";
const WEB_ROOT = process.env.OPENCODE_WEB_DIST_DIR || "/opt/opencode/packages/app/dist";
const sourceMode = isSourceMode(process.env);
const enableOhMyOpencode = process.env.ENABLE_OH_MY_OPENCODE !== "false";
const enableOpenclawPlugin = process.env.ENABLE_OPENCLAW_PLUGIN === "true";
const enableOmoDefaultConfig = process.env.ENABLE_OMO_DEFAULT_CONFIG === "true";
const ACTIVITY_FILE = process.env.OPENCODE_ACTIVITY_FILE || "/tmp/opencode_monitor_state_v5/last_activity";
const sleepDebug = process.env.LOG_SLEEP_BLOCKERS !== "false";

if (!PASSWORD) {
  console.error("ERROR: OPENCODE_SERVER_PASSWORD is required");
  process.exit(1);
}

// Create persistent directories
const dirs = [
  WORKSPACE,
  "/data/.local/share/opencode",
  "/data/.local/state/opencode",
  "/data/.config/opencode",
];
for (const dir of dirs) {
  fs.mkdirSync(dir, { recursive: true });
}

// Set environment variables
process.env.HOME = "/data";
process.env.OPENCODE_CONFIG_DIR = "/data/.config/opencode";
process.env.OPENCODE_CONFIG = "/data/.config/opencode/config.json";
// Internal OpenCode does not need Basic Auth; the proxy layer handles it
process.env.OPENCODE_SERVER_PASSWORD = "";
delete process.env.OPENCODE_SERVER_PASSWORD;

// Set OpenClaw plugin environment variables
process.env.OPENCLAW_PORT = PLUGIN_PORT;

try {
  ensureRuntimeConfigs({
    enableOhMyOpencode,
    enableOpenclawPlugin,
    enableOmoDefaultConfig,
  });
} catch (err) {
  console.error("[wrapper] Failed to update runtime config:", err.message);
}

try {
  const result = refreshPluginCache();
  if (result.action === "refreshed") {
    console.log(`[wrapper] Refreshed oh-my plugin cache for deployment ${result.deployment}`);
  }
  if (result.action === "noop") {
    console.log(`[wrapper] Oh-my plugin cache already refreshed for deployment ${result.deployment}`);
  }
  if (result.action === "skipped") {
    console.log(`[wrapper] Skipped oh-my plugin refresh: ${result.reason}`);
  }
} catch (err) {
  console.error("[wrapper] Failed to refresh oh-my plugin cache:", err.message);
}

try {
  const result = ensureOhMyPluginCache();
  if (result.action === "installed") {
    console.log(`[wrapper] Installed oh-my plugin cache in ${result.dir}`);
  }
  if (result.action === "noop") {
    console.log(`[wrapper] Oh-my plugin cache ready in ${result.dir}`);
  }
  if (result.action === "skipped") {
    console.log(`[wrapper] Skipped oh-my plugin cache prewarm: ${result.reason}`);
  }
} catch (err) {
  console.error("[wrapper] Failed to prewarm oh-my plugin cache:", err.message);
  process.exit(1);
}

console.log(`Starting OpenCode Web on port ${PORT}...`);
console.log(`OpenCode version: ${process.env.OPENCODE_VERSION || "unknown"}`);
console.log(`Internal port: ${INTERNAL_PORT}`);
console.log(`Plugin port: ${PLUGIN_PORT}`);
console.log(`Workspace: ${WORKSPACE}`);
console.log(`Source mode: ${sourceMode ? "true (build from source)" : "false (published opencode-ai)"}`);
console.log(`Log level: ${logLevel} (set LOG_LEVEL env var to change: DEBUG, INFO, WARN, ERROR)`);
console.log(`Oh My OpenCode: ${enableOhMyOpencode ? "enabled" : "disabled"}`);
console.log(`OpenClaw plugin injection: ${enableOpenclawPlugin ? "enabled" : "disabled"}`);
console.log(`OMO default config override: ${enableOmoDefaultConfig ? "enabled" : "disabled"}`);
if (debugTraffic) {
  console.log("OpenCode traffic debug logging enabled");
}
if (sleepDebug) {
  console.log("Sleep blocker logging enabled");
}

function compactLog(value, max = 160) {
  if (value === undefined || value === null || value === "") return "-";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return "-";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function forwardedHeaderValue(value) {
  if (!value) return "";
  if (Array.isArray(value)) return value[0] || "";
  return value;
}

function requestIp(req) {
  const direct = forwardedHeaderValue(req.headers["cf-connecting-ip"]);
  if (direct) return direct;
  const forwarded = forwardedHeaderValue(req.headers["x-forwarded-for"]);
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "-";
}

function requestAuth(req) {
  if (req.headers.authorization?.startsWith("Basic ")) return "basic";
  if (req.headers.cookie?.includes(`${SESSION_COOKIE}=`)) return "session";
  return "none";
}

function shouldLogSleepInbound(req, pathname, isApiReq, isPluginReq) {
  if (pathname === "/global/health") return true;
  if (pathname === "/session/status") return true;
  if (pathname === "/global/event" || pathname === "/events") return true;
  if (pathname === "/register") return true;
  if (pathname === "/" || pathname === "/login") return req.method === "GET" || req.method === "HEAD";
  return isHtmlNavigation(req, pathname, isApiReq, isPluginReq);
}

function logSleepInbound(req, pathname, note = "") {
  if (!sleepDebug) return;
  const host = compactLog(forwardedHeaderValue(req.headers.host), 80);
  const ip = compactLog(requestIp(req), 80);
  const ua = compactLog(forwardedHeaderValue(req.headers["user-agent"]), 120);
  const auth = requestAuth(req);
  const suffix = note ? ` note=${note}` : "";
  console.log(`[sleep-debug] inbound method=${req.method} path=${pathname} host=${host} ip=${ip} auth=${auth} ua="${ua}"${suffix}`);
}

function normalizePort(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

function splitHostPort(host) {
  if (!host) return { host: "", port: "" };
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return { host, port: "" };
    const name = host.slice(0, end + 1);
    const port = host.slice(end + 2);
    return { host: name, port };
  }
  const idx = host.lastIndexOf(":");
  if (idx === -1) return { host, port: "" };
  if (host.indexOf(":") !== idx) return { host, port: "" };
  return {
    host: host.slice(0, idx),
    port: host.slice(idx + 1),
  };
}

function isLoopbackHost(host) {
  if (!host) return true;
  const value = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (value === "localhost" || value === "::1") return true;
  if (value === "0.0.0.0") return true;
  return value.startsWith("127.");
}

function shouldLogOutbound(target) {
  if (!sleepDebug || !target) return false;
  if (target.socketPath) return false;
  return !isLoopbackHost(target.host);
}

function logSleepOutbound(kind, target) {
  if (!shouldLogOutbound(target)) return;
  const protocol = target.protocol || kind;
  const method = target.method || "GET";
  const host = compactLog(target.host, 80);
  const port = target.port ? `:${target.port}` : "";
  const route = compactLog(target.path || "/", 160);
  console.log(`[sleep-debug] outbound kind=${kind} method=${method} target=${protocol}//${host}${port}${route}`);
}

function outboundTarget(args, fallbackProtocol) {
  const first = args[0];
  const second = typeof args[1] === "function" ? undefined : args[1];
  if (!first) return;

  if (typeof first === "string" || first instanceof URL) {
    const url = first instanceof URL ? first : new URL(first);
    const opts = second && typeof second === "object" ? second : {};
    const hostValue = opts.hostname || opts.host || url.hostname || url.host;
    const split = splitHostPort(String(hostValue || ""));
    return {
      protocol: url.protocol || fallbackProtocol,
      host: split.host || url.hostname || url.host,
      port: normalizePort(opts.port || split.port || url.port),
      path: opts.path || `${url.pathname}${url.search}`,
      method: opts.method || "GET",
      socketPath: opts.socketPath,
    };
  }

  if (typeof first !== "object") return;

  const split = splitHostPort(String(first.hostname || first.host || ""));
  return {
    protocol: first.protocol || fallbackProtocol,
    host: split.host || first.hostname || first.host,
    port: normalizePort(first.port || split.port),
    path: first.path || first.pathname || "/",
    method: first.method || "GET",
    socketPath: first.socketPath,
  };
}

function patchOutboundRequests(mod, kind, fallbackProtocol) {
  const request = mod.request.bind(mod);
  mod.request = (...args) => {
    logSleepOutbound(kind, outboundTarget(args, fallbackProtocol));
    return request(...args);
  };

  mod.get = (...args) => {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

const originalFetch = globalThis.fetch?.bind(globalThis);
if (originalFetch) {
  globalThis.fetch = async (input, init) => {
    const source = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (typeof source === "string" && !source.startsWith("/")) {
      const url = new URL(source);
      logSleepOutbound("fetch", {
        protocol: url.protocol,
        host: url.hostname,
        port: normalizePort(url.port),
        path: `${url.pathname}${url.search}`,
        method: init?.method || (input instanceof Request ? input.method : "GET"),
      });
    }
    return await originalFetch(input, init);
  };
}

patchOutboundRequests(http, "http", "http:");
patchOutboundRequests(https, "https", "https:");

const launch = resolveOpencodeLaunch({
  env: process.env,
  internalPort: INTERNAL_PORT,
  logLevel,
});
if (launch.error) {
  console.error(`[wrapper] ${launch.error}`);
  process.exit(1);
}
console.log(`[wrapper] Launching OpenCode via ${launch.mode}: ${launch.cmd}`);

// Start headless opencode server (internal port, not publicly exposed)
const opencode = spawn(
  launch.cmd,
  launch.args,
  {
    cwd: WORKSPACE,
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
    trimmed.includes("service=bus") &&
    (
      trimmed.includes("type=message.part.delta") ||
      trimmed.includes("type=message.part.updated")
    )
  ) return true;
  if (
    trimmed.startsWith("INFO") &&
    trimmed.includes("service=server") &&
    (
      trimmed.includes("path=/global/health") ||
      trimmed.includes("path=/session/status") ||
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

function shouldTouchActivityFromLog(trimmed) {
  if (!trimmed.startsWith("INFO")) return false;
  if (trimmed.includes("service=session.processor") && trimmed.includes(" process")) return true;
  if (trimmed.includes("service=llm") && trimmed.includes(" stream")) return true;
  if (trimmed.includes("type=message.part.delta") && trimmed.includes(" publishing")) return true;
  if (trimmed.includes("type=message.part.updated") && trimmed.includes(" publishing")) return true;
  return false;
}

// Log classification: ERROR/WARN -> stderr, others -> stdout
function classifyAndOutput(line) {
  const trimmed = line.toString().trim();
  if (!trimmed) return;
  if (shouldTouchActivityFromLog(trimmed)) touchActivity();
  if (shouldSuppressLog(trimmed)) return;

  if (trimmed.startsWith("ERROR") || trimmed.startsWith("WARN")) {
    console.error(trimmed);
  } else {
    console.log(trimmed);
  }
}

// Handle stdout
opencode.stdout?.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (line) classifyAndOutput(line);
  }
});

// Handle stderr
opencode.stderr?.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (line) classifyAndOutput(line);
  }
});

// Error handling
opencode.on("error", (err) => {
  console.error(`[wrapper] Failed to spawn opencode: ${err.message}`);
  process.exit(1);
});

// Process exit handling
opencode.on("exit", (code, signal) => {
  console.log(`[wrapper] opencode exited with code=${code}, signal=${signal}`);
  process.exit(code ?? 0);
});

// Wait for OpenCode startup
async function waitForOpencode(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/global/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // Not ready yet
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

function touchActivity() {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_FILE), { recursive: true });
    fs.writeFileSync(ACTIVITY_FILE, String(Math.floor(Date.now() / 1000)));
  } catch (err) {
    console.error(`[wrapper] Failed to update activity file: ${err.message}`);
  }
}

function isDirectorySessionRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return false;
  return parts[1] === "session";
}

function decodeRouteDirectory(pathname) {
  if (!isDirectorySessionRoute(pathname)) return;
  const parts = pathname.split("/").filter(Boolean);
  const slug = parts[0];
  if (!slug) return;
  try {
    return Buffer.from(slug, "base64url").toString("utf8");
  } catch {
    return;
  }
}

function hasValidRouteDirectory(pathname) {
  const dir = decodeRouteDirectory(pathname);
  if (!dir) return true;
  if (dir === WORKSPACE) return true;
  return fs.existsSync(dir);
}

function routeSessionParts(pathname) {
  if (!isDirectorySessionRoute(pathname)) return;
  const parts = pathname.split("/").filter(Boolean);
  return {
    slug: parts[0],
    tail: parts.slice(1),
  };
}

function routeSessionLocation(directory, suffix = "/session") {
  const slug = Buffer.from(directory).toString("base64url");
  return `/${slug}${suffix}`;
}

function rootSessionLocation() {
  return routeSessionLocation(WORKSPACE);
}

async function listDirectorySessions(directory) {
  const res = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/session`, {
    headers: {
      "x-opencode-directory": directory,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
  return await res.json();
}

async function createDirectorySession(directory) {
  const res = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/session`, {
    method: "POST",
    headers: {
      "x-opencode-directory": directory,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
  });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  return await res.json();
}

function isStaticAsset(pathname) {
  return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json)$/.test(pathname);
}

function isHtmlNavigation(req, pathname, isApiReq, isPluginReq) {
  if (req.method !== "GET") return false;
  if (isApiReq || isPluginReq) return false;
  if (isStaticAsset(pathname)) return false;
  const accept = req.headers.accept || "";
  if (req.headers["sec-fetch-dest"] === "document") return true;
  if (req.headers["sec-fetch-mode"] === "navigate") return true;
  return accept.includes("text/html");
}

// Plugin endpoint list - these endpoints route to the plugin port
// Note: only match exact plugin endpoints to avoid conflicts with OpenCode endpoints like /global/health
const PLUGIN_ENDPOINTS = ['/register'];
const PLUGIN_PREFIXES = ['/register/'];
const PUBLIC_PATHS = new Set([
  "/favicon.ico",
  "/favicon-v3.ico",
  "/favicon-v3.svg",
  "/favicon-96x96-v3.png",
  "/apple-touch-icon-v3.png",
  "/site.webmanifest",
  "/social-share.png",
  "/oc-theme-preload.js",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
]);

// OpenCode HTTP API endpoint prefixes - these endpoints route to OpenCode service
const OPENCODE_API_PREFIXES = [
  '/session',
  '/global',
  '/agents',
  '/tools',
  '/events',
  '/v2',
  '/api'
];

// Check whether a request targets a plugin endpoint
function isPluginEndpoint(url) {
  const pathname = pathnameOf(url);
  // Exact match
  if (PLUGIN_ENDPOINTS.includes(pathname)) return true;
  // Prefix match
  if (PLUGIN_PREFIXES.some(prefix => pathname.startsWith(prefix))) return true;
  return false;
}

// Check whether a request targets an OpenCode API endpoint
function isOpencodeApiEndpoint(url) {
  const pathname = pathnameOf(url);
  return OPENCODE_API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'));
}

function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname);
}

function isStaticRoute(pathname) {
  if (!sourceMode) return false;
  if (isPublicPath(pathname)) return true;
  if (pathname.startsWith("/assets/")) return true;
  return false;
}

function shouldTrackActivity(req, pathname, isApiReq, isPluginReq) {
  if (req.method === "OPTIONS") return false;
  if (isPluginReq) return false;
  if (pathname === "/login" || pathname === "/logout") return false;
  if (pathname === "/global/health") return false;
  if (pathname === "/global/event" || pathname === "/events") return false;
  if (pathname === "/session/status") return false;
  if (isStaticRoute(pathname)) return false;
  if (isApiReq) return true;
  return isHtmlNavigation(req, pathname, isApiReq, isPluginReq);
}

function staticPath(pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(WEB_ROOT, rel);
  if (file === WEB_ROOT) return path.join(WEB_ROOT, "index.html");
  if (!file.startsWith(WEB_ROOT + path.sep) && file !== path.join(WEB_ROOT, "index.html")) return;
  return file;
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json" || ext === ".webmanifest") return "application/manifest+json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".woff") return "font/woff";
  if (ext === ".ttf") return "font/ttf";
  return "application/octet-stream";
}

function cacheControl(file) {
  if (file.endsWith("index.html")) return "no-store";
  return "public, max-age=31536000, immutable";
}

function sendStatic(res, file, reqMethod = "GET") {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": mimeType(file),
    "Content-Length": body.length,
    "Cache-Control": cacheControl(file),
  });
  if (reqMethod === "HEAD") {
    res.end();
    return true;
  }
  res.end(body);
  return true;
}

function handleStatic(req, res, pathname) {
  if (isStaticRoute(pathname)) {
    return sendStatic(res, staticPath(pathname), req.method);
  }
  return false;
}

function sendMissingStatic(res, pathname) {
  const status = pathname === "/" ? 500 : 404;
  const body =
    pathname === "/"
      ? `Missing local web app entrypoint: ${staticPath("/")}\n`
      : `Static asset not found: ${pathname}\n`;
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
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

// Create proxy server
const server = http.createServer(async (req, res) => {
  const pathname = pathnameOf(req.url);
  const isApiReq = isOpencodeApiEndpoint(req.url);
  const isPluginReq = isPluginEndpoint(req.url);

  if (shouldLogSleepInbound(req, pathname, isApiReq, isPluginReq)) {
    logSleepInbound(req, pathname);
  }

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

  if (handleStatic(req, res, pathname)) return;
  if (isStaticRoute(pathname)) {
    sendMissingStatic(res, pathname);
    return;
  }

  if (isHtmlNavigation(req, pathname, isApiReq, isPluginReq) && !hasValidRouteDirectory(pathname)) {
    console.warn(`[wrapper] Missing route directory for ${pathname}, redirecting to workspace root`);
    redirect(res, rootSessionLocation());
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

  if (shouldTrackActivity(req, pathname, isApiReq, isPluginReq)) {
    touchActivity();
  }

  if (isHtmlNavigation(req, pathname, isApiReq, isPluginReq)) {
    const route = routeSessionParts(pathname);
    const directory = decodeRouteDirectory(pathname);
    if (route && directory && route.tail.length === 1 && route.tail[0] === "session" && fs.existsSync(directory)) {
      try {
        const sessions = await listDirectorySessions(directory);
        if (sessions.length === 0) {
          const session = await createDirectorySession(directory);
          const location = routeSessionLocation(directory, `/session/${session.id}`);
          console.log(`[wrapper] Created session ${session.id} for ${directory}`);
          redirect(res, location);
          return;
        }
      } catch (err) {
        console.error(`[wrapper] Failed to auto-create session for ${directory}: ${err.message}`);
      }
    }
    if (sendStatic(res, staticPath("/"), req.method)) {
      return;
    }
    sendMissingStatic(res, "/");
    return;
  }

  if (process.env.DEBUG_PROXY) {
    console.log(`[proxy] ${req.method} ${req.url}`);
  }

  const targetPort = isPluginReq ? PLUGIN_PORT : INTERNAL_PORT;
  proxyRequest(req, res, targetPort);
});

// WebSocket upgrade handling
server.on('upgrade', (req, socket, head) => {
  logSleepInbound(req, pathnameOf(req.url), "upgrade");

  if (!isAuthenticated(req)) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`);
    socket.end();
    return;
  }

  touchActivity();

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

// Start monitor script
function startMonitor() {
  const enableMonitor = process.env.ENABLE_MONITOR === "true";
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

    // Only write error-level logs to console; write all logs to file
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

// Start server
async function start() {
  // Wait for OpenCode startup
  console.log("[wrapper] Waiting for OpenCode to start...");
  const ready = await waitForOpencode();
  if (!ready) {
    console.error("[wrapper] OpenCode failed to start within timeout");
    process.exit(1);
  }
  console.log("[wrapper] OpenCode is ready");

  // Start monitor (after OpenCode is ready)
  startMonitor();

  // Start proxy server
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[wrapper] Proxy server listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error("[wrapper] Failed to start:", err);
  process.exit(1);
});

// Graceful shutdown function
function gracefulShutdown(signal) {
  if (receivedSigterm) {
    console.log(`[wrapper] Already shutting down, ignoring ${signal}`);
    return;
  }
  receivedSigterm = true;

  console.log(`[wrapper] Received ${signal}, initiating graceful shutdown...`);

  // Close proxy server
  server.close(() => {
    console.log("[wrapper] Proxy server closed");
  });

  // Send SIGTERM to child process
  if (opencode.pid) {
    try {
      opencode.kill("SIGTERM");
      console.log("[wrapper] Sent SIGTERM to opencode");
    } catch (err) {
      console.error(`[wrapper] Failed to kill opencode: ${err.message}`);
    }
  }

  // Force exit after 5s timeout
  setTimeout(() => {
    console.error("[wrapper] Graceful shutdown timeout (5s), forcing exit");
    process.exit(1);
  }, 5000);
}

// Register signal handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Unexpected error handling
process.on("uncaughtException", (err) => {
  console.error("[wrapper] Uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  console.error("[wrapper] Unhandled rejection:", reason);
  gracefulShutdown("unhandledRejection");
});
