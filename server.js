#!/usr/bin/env node
/**
 * OpenCode Railway Wrapper
 * 提供优雅关闭、日志分类和 Basic Auth 代理功能
 */

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");

const PORT = process.env.PORT || "8080";
const INTERNAL_PORT = process.env.INTERNAL_PORT || "18080";
const PLUGIN_PORT = process.env.OPENCLAW_PLUGIN_PORT || "9090";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;
const USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_REALM = process.env.AUTH_REALM || "opencode.tradao.xyz";
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

// Set OpenClaw plugin environment variables
process.env.OPENCLAW_PORT = PLUGIN_PORT;

// Ensure opencode.json config file includes the OpenClaw plugin.
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

// 启动 opencode web（内部端口，不直接暴露）
const opencode = spawn(
  "bunx",
  ["opencode", "web", "--port", INTERNAL_PORT, "--hostname", "127.0.0.1", "--print-logs", "--log-level", logLevel],
  {
    cwd: "/data/workspace/tradao",
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

// 插件端点列表 - 这些端点会路由到插件端口
// 注意：只匹配精确的插件端点，避免与 OpenCode 的 /global/health 等端点冲突
const PLUGIN_ENDPOINTS = ['/register'];
const PLUGIN_PREFIXES = ['/register/'];

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
  // Remove query string and hash for matching
  const pathname = url.split('?')[0].split('#')[0];
  // 精确匹配
  if (PLUGIN_ENDPOINTS.includes(pathname)) return true;
  // 前缀匹配
  if (PLUGIN_PREFIXES.some(prefix => pathname.startsWith(prefix))) return true;
  return false;
}

// 检查请求是否是 OpenCode API 端点
function isOpencodeApiEndpoint(url) {
  // Remove query string and hash for matching
  const pathname = url.split('?')[0].split('#')[0];
  return OPENCODE_API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'));
}

// 创建代理服务器
const server = http.createServer((req, res) => {
  // 检查 Basic Auth
  if (!checkAuth(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": `Basic realm="${AUTH_REALM}"`,
      "Content-Type": "text/plain"
    });
    res.end("Authentication required\n");
    return;
  }

  // 检查是否是可能需要注入脚本的 HTML 请求
  // API 端点不应被视为 HTML 请求
  const isApiReq = isOpencodeApiEndpoint(req.url);
  const isPluginReq = isPluginEndpoint(req.url);
  // Use pathname (without query string) for static file check
  const urlPathname = req.url.split('?')[0].split('#')[0];
  const isHtmlRequest = req.method === "GET" &&
    !isApiReq &&
    !isPluginReq &&
    !urlPathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json)$/);

  // 检查是否是 SSE (Server-Sent Events) 请求
  const acceptHeader = req.headers.accept || '';
  const isSSE = acceptHeader.includes('text/event-stream');
  
  // 检查是否是 WebSocket 升级请求 (在 HTTP/2 中可能以这种方式出现)
  const isWebSocketUpgrade = req.headers.upgrade === 'websocket' || 
                             req.headers.connection?.toLowerCase().includes('upgrade');

  // 确定目标端口：插件端点 -> 插件端口，其他 -> 内部 OpenCode 端口
  const targetPort = isPluginReq ? PLUGIN_PORT : INTERNAL_PORT;

  // 只在DEBUG_PROXY启用时记录请求信息
  if (process.env.DEBUG_PROXY) {
    console.log(`[proxy] ${req.method} ${req.url}`);
  }

  // 准备转发 headers
  const forwardHeaders = { ...req.headers };
  delete forwardHeaders.host;
  delete forwardHeaders.authorization; // 内部服务器不需要 auth

  // Rewrite /events to /global/event for backwards compatibility
  // OpenCode changed the endpoint from /events to /global/event
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

  // 对于 HTML 请求，需要获取完整响应并注入脚本
  // API、SSE 和 WebSocket 请求不应进行 HTML 注入
  if (isHtmlRequest && !isSSE && !isWebSocketUpgrade) {
    const proxyReq = http.request(options, (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';

      // 检查是否是 HTML 响应
      if (contentType.includes('text/html')) {
        // 收集完整响应体
        let body = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', (chunk) => { body += chunk; });
        proxyRes.on('end', () => {
          // 注入脚本到 </head> 前
          const modifiedBody = body.replace(/<\/head>/i, INJECTED_SCRIPT + '</head>');

          // 发送修改后的响应
          res.writeHead(proxyRes.statusCode, {
            ...proxyRes.headers,
            'content-length': Buffer.byteLength(modifiedBody),
          });
          res.end(modifiedBody);
        });
      } else {
        // 不是 HTML，直接流式转发
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      console.error('[proxy error]', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Gateway error\n');
      }
    });

    req.pipe(proxyReq);
  } else {
    // 非 HTML 请求或 SSE 请求，直接流式转发
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[proxy error]', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Gateway error\n');
      }
    });

    req.pipe(proxyReq);
  }
});

// WebSocket 升级处理
server.on('upgrade', (req, socket, head) => {
  // WebSocket 连接跳过 Basic Auth 检查
  // 浏览器不允许在 WebSocket URL 中使用 credentials
  const options = {
    hostname: "127.0.0.1",
    port: INTERNAL_PORT,
    path: req.url,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${INTERNAL_PORT}`,
    },
  };

  const proxyReq = http.request(options);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                 'Upgrade: websocket\r\n' +
                 'Connection: Upgrade\r\n' +
                 '\r\n');
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('error', (err) => {
    console.error('[websocket error]', err.message);
    socket.end();
  });
  
  proxyReq.on('response', (res) => {
    // If we get a response instead of an upgrade, the backend doesn't support WebSocket
    socket.end();
  });

  proxyReq.end();
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
