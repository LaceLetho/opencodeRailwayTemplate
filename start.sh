#!/bin/sh
set -e

# Railway 注入的端口
PORT="${PORT:-8080}"

# 验证必需的环境变量
if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "ERROR: OPENCODE_SERVER_PASSWORD is required" >&2
  exit 1
fi

# 创建持久化目录
mkdir -p /data/workspace /data/.local/share/opencode /data/.local/state/opencode /data/.config/opencode

# 设置 HOME 为持久化目录，这样 OpenCode 的数据会存储在 /data 下
# - 数据库: /data/.local/share/opencode/opencode.db
# - 配置: /data/.config/opencode/
# - 状态: /data/.local/state/opencode/
export HOME="/data"

# 设置配置目录（可选，覆盖默认的 XDG 路径）
export OPENCODE_CONFIG_DIR="/data/.config/opencode"
export OPENCODE_CONFIG="/data/.config/opencode/config.json"

# 进入工作目录并启动 OpenCode Web 服务
cd /data/workspace

echo "Starting OpenCode Web on port $PORT..."
echo "Workspace: $(pwd)"

# 启动 opencode web 并通过 wrapper 路由日志
# --port: 使用 Railway 提供的端口
# --hostname 0.0.0.0: 让网络可访问
# --print-logs: 使日志输出到 stderr，然后通过管道路由到不同流
#
# 日志路由规则：
# - DEBUG/INFO -> stdout (Railway 显示为 info 级别)
# - WARN/ERROR -> stderr (Railway 显示为 error 级别)
bunx opencode web --port "$PORT" --hostname 0.0.0.0 --print-logs 2>&1 | while IFS= read -r line; do
  case "$line" in
    ERROR*|WARN*)
      # 错误和警告输出到 stderr
      echo "$line" >&2
      ;;
    *)
      # 其他所有日志（INFO, DEBUG等）输出到 stdout
      echo "$line"
      ;;
  esac
done
