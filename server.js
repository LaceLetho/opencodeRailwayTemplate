#!/usr/bin/env node
/**
 * OpenCode Railway Wrapper
 * 提供优雅关闭、日志分类和 Basic Auth 代理功能
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const httpProxy = require("http-proxy");

const PORT = process.env.PORT || "8080";
const INTERNAL_PORT = process.env.INTERNAL_PORT || "18080";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;
const USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const logLevel = process.env.LOG_LEVEL?.toUpperCase() || "WARN";

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

console.log(`Starting OpenCode Web on port ${PORT}...`);
console.log(`Internal port: ${INTERNAL_PORT}`);
console.log(`Workspace: /data/workspace`);
console.log(`Log level: ${logLevel} (set LOG_LEVEL env var to change: DEBUG, INFO, WARN, ERROR)`);

// 启动 opencode web（内部端口，不直接暴露）
const opencode = spawn(
  "bunx",
  ["opencode", "web", "--port", INTERNAL_PORT, "--hostname", "127.0.0.1", "--print-logs", "--log-level", logLevel],
  {
    cwd: "/data/workspace",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  }
);

let receivedSigterm = false;

// 日志分类：ERROR/WARN -> stderr，其他 -> stdout
function classifyAndOutput(line) {
  const trimmed = line.toString().trim();
  if (!trimmed) return;

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

// 创建代理服务器
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  ws: true,
  changeOrigin: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy error]", err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Gateway error\n");
  }
});

// Basic Auth 验证
function checkAuth(req) {
  const auth = req.headers.authorization;
  if (!auth) return false;

  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) return false;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  return user === USERNAME && pass === PASSWORD;
}

// 注入到 HTML 的脚本：配置前端自动发送 Basic Auth
const INJECTED_SCRIPT = `
<script>
(function() {
  // 配置前端 SDK 使用 Basic Auth
  window.__OPENCODE_AUTH__ = {
    username: "${USERNAME}",
    password: "${PASSWORD}"
  };

  // 拦截 fetch 请求，自动添加 Basic Auth 头
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const [url, options = {}] = args;
    const urlStr = typeof url === 'string' ? url : url.url || url.toString();

    // 只对同源请求添加 Basic Auth
    if (urlStr.startsWith('/') || urlStr.startsWith(window.location.origin)) {
      options.headers = options.headers || {};
      if (!options.headers['Authorization']) {
        const auth = btoa(window.__OPENCODE_AUTH__.username + ':' + window.__OPENCODE_AUTH__.password);
        options.headers['Authorization'] = 'Basic ' + auth;
      }
    }

    return originalFetch.call(this, url, options);
  };

  // 拦截 XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._ocUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (header.toLowerCase() === 'authorization') {
      this._ocHasAuth = true;
    }
    return originalSetRequestHeader.call(this, header, value);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    const url = this._ocUrl || '';
    // 只对同源请求添加 Basic Auth
    if (!this._ocHasAuth && (url.startsWith('/') || url.startsWith(window.location.origin))) {
      const auth = btoa(window.__OPENCODE_AUTH__.username + ':' + window.__OPENCODE_AUTH__.password);
      originalSetRequestHeader.call(this, 'Authorization', 'Basic ' + auth);
    }
    return originalSend.call(this, ...args);
  };

})();
</script>
`;

// 转发请求到内部 OpenCode 服务
async function forwardRequest(req, body) {
  const headers = {};

  // 只复制必要的 headers，确保 content-type 被正确保留
  const headersToKeep = ['content-type', 'accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection'];
  for (const key of headersToKeep) {
    if (req.headers[key]) {
      headers[key] = req.headers[key];
    }
  }

  // 如果有 body，确保 content-type 存在
  if (body && body.length > 0) {
    if (!headers['content-type']) {
      // 尝试从 body 内容推断类型
      const bodyStr = body.toString();
      if (bodyStr.startsWith('{') || bodyStr.startsWith('[')) {
        headers['content-type'] = 'application/json';
      }
    }
  }

  const url = `http://127.0.0.1:${INTERNAL_PORT}${req.url}`;
  console.log(`[debug] forwardRequest ${req.method} ${url}`);
  console.log(`[debug] headers: ${JSON.stringify(headers)}`);
  console.log(`[debug] body: ${body ? body.length : 0} bytes, content: ${body ? body.toString().substring(0, 200) : 'null'}`);

  const response = await fetch(url, {
    method: req.method,
    headers,
    body: body ? Buffer.from(body) : undefined,
  });

  console.log(`[debug] forwardRequest response status: ${response.status}`);
  return response;
}

// 读取请求体的辅助函数
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 创建 HTTP 服务器
const server = http.createServer(async (req, res) => {
  // 检查 Basic Auth
  if (!checkAuth(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="OpenCode"',
      "Content-Type": "text/plain"
    });
    res.end("Authentication required\n");
    return;
  }

  // 检查是否是可能需要注入脚本的 HTML 请求
  const isHtmlRequest = req.method === "GET" &&
    !req.url.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json)$/);

  try {
    // 对于 POST/PUT/PATCH 请求，需要读取请求体
    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = await readRequestBody(req);
      console.log(`[debug] ${req.method} ${req.url} body length: ${body ? body.length : 0}`);
      console.log(`[debug] original content-type: ${req.headers['content-type']}`);
    }

    if (isHtmlRequest) {
      // 先获取响应内容
      const targetRes = await forwardRequest(req, body);
      const responseBody = await targetRes.text();

      // 检查是否是 HTML
      if (responseBody.includes('<!DOCTYPE') || responseBody.includes('<!doctype') || responseBody.includes('<html')) {
        // 注入脚本
        const modifiedBody = responseBody.replace(/<\/head>/i, INJECTED_SCRIPT + '</head>');

        // 设置响应头
        res.writeHead(targetRes.status, {
          'content-type': 'text/html; charset=UTF-8',
          'content-length': Buffer.byteLength(modifiedBody),
        });
        res.end(modifiedBody);
        return;
      }

      // 不是 HTML，直接返回
      res.writeHead(targetRes.status, {
        'content-type': targetRes.headers.get('content-type') || 'text/plain',
        'content-length': Buffer.byteLength(responseBody),
      });
      res.end(responseBody);
      return;
    }

    // 非 HTML 请求直接转发
    const targetRes = await forwardRequest(req, body);

    // 复制响应头
    const responseHeaders = {};
    for (const [key, value] of targetRes.headers) {
      responseHeaders[key] = value;
    }

    // 读取响应体
    const responseBody = await targetRes.arrayBuffer();

    // 发送响应
    res.writeHead(targetRes.status, responseHeaders);
    res.end(Buffer.from(responseBody));
  } catch (err) {
    console.error("[server error]", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Gateway error\n");
    }
  }
});

// WebSocket 升级处理
server.on('upgrade', (req, socket, head) => {
  // WebSocket 连接跳过 Basic Auth 检查
  // 用户已经通过页面访问进行了身份验证
  // 浏览器不允许在 WebSocket URL 中使用 credentials
  proxy.ws(req, socket, head);
});

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
