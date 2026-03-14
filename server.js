#!/usr/bin/env node
/**
 * OpenCode Railway Wrapper
 * 提供优雅关闭和日志分类功能
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || "8080";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;

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

console.log(`Starting OpenCode Web on port ${PORT}...`);
console.log(`Workspace: /data/workspace`);

// 启动 opencode web
const opencode = spawn(
  "bunx",
  ["opencode", "web", "--port", PORT, "--hostname", "0.0.0.0", "--print-logs"],
  {
    cwd: "/data/workspace",
    stdio: ["ignore", "pipe", "pipe"], // 捕获 stdout 和 stderr
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

// 处理 stderr (也做分类)
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

// 优雅关闭函数
function gracefulShutdown(signal) {
  if (receivedSigterm) {
    console.log(`[wrapper] Already shutting down, ignoring ${signal}`);
    return;
  }
  receivedSigterm = true;

  console.log(`[wrapper] Received ${signal}, initiating graceful shutdown...`);

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

console.log("[wrapper] Ready, waiting for requests...");
