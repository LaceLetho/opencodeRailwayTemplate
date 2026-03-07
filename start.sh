#!/usr/bin/env bash
set -euo pipefail

# Railway 注入的端口
PORT="${PORT:-8080}"

# 验证必需的环境变量
if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "ERROR: OPENCODE_SERVER_PASSWORD is required" >&2
  exit 1
fi

# 创建持久化目录
mkdir -p /data/workspace

# 进入工作目录并启动 OpenCode Web 服务
cd /data/workspace

echo "Starting OpenCode Web on port $PORT..."
echo "Workspace: $(pwd)"

# 启动 opencode web
# --port: 使用 Railway 提供的端口
# --hostname 0.0.0.0: 让网络可访问
exec bunx opencode web --port "$PORT" --hostname 0.0.0.0
