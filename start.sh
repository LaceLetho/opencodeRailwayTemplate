#!/bin/sh
set -e

# 监控功能开关，默认开启
# 实际监控启动逻辑已移至 server.js，在 OpenCode 就绪后启动
export ENABLE_MONITOR="${ENABLE_MONITOR:-true}"

exec node /app/server.js
