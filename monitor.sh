#!/bin/bash
# OpenCode Railway 智能监测 - v4.1 (Global SSE)
# 改进：使用 /global/event SSE 端点检测全局活动，修复进程 PID 匹配

set -uo pipefail

# ==================== 配置 ====================
IDLE_TIME_MINUTES=${IDLE_TIME_MINUTES:-10}
CHECK_INTERVAL_SECONDS=${CHECK_INTERVAL_SECONDS:-60}
MEMORY_THRESHOLD_MB=${MEMORY_THRESHOLD_MB:-2000}
CPU_THRESHOLD_PERCENT=${CPU_THRESHOLD_PERCENT:-5.0}
GENERATION_GRACE_SECONDS=${GENERATION_GRACE_SECONDS:-60}
LOG_FILE="${LOG_FILE:-/tmp/opencode_monitor_script.log}"
STATE_DIR="/tmp/opencode_monitor_state_v4"
mkdir -p "$STATE_DIR"

LAST_ACTIVITY_FILE="$STATE_DIR/last_activity"
LAST_GENERATION_FILE="$STATE_DIR/last_generation_time"
EVENT_MONITOR_PID_FILE="$STATE_DIR/event_monitor.pid"

RAILWAY_API_TOKEN="${RAILWAY_API_TOKEN:-}"
RAILWAY_PROJECT_ID="${RAILWAY_PROJECT_ID:-86df633b-79e2-4679-8b70-209e000fc6b6}"
RAILWAY_ENVIRONMENT_ID="${RAILWAY_ENVIRONMENT_ID:-866a8008-85c1-420f-8b5c-eb8b628c747c}"
RAILWAY_SERVICE_ID="${RAILWAY_SERVICE_ID:-04480a22-64b6-4c9d-9815-691aeea0a228}"

API_URL="http://127.0.0.1:18080"

log() {
    local msg="$1"
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $msg" | tee -a "$LOG_FILE"
}

echo "========================================"
echo "🚂 OpenCode Railway 智能监测 v4.1"
echo "========================================"
echo ""
echo "重大改进:"
echo "  ✓ 使用 /global/event SSE - 检测全局活动"
echo "  ✓ 修复 PID 匹配 - 正确识别工作进程"
echo "  ✓ 集成Railway API - 自动重新部署"
echo ""
echo "配置:"
echo "  空闲时间: ${IDLE_TIME_MINUTES} 分钟"
echo "  内存阈值: ${MEMORY_THRESHOLD_MB} MB"
echo "  CPU阈值: ${CPU_THRESHOLD_PERCENT}%"
echo "  检查间隔: ${CHECK_INTERVAL_SECONDS} 秒"
echo "  日志文件: ${LOG_FILE}"
echo "  Railway API: $([ -n "$RAILWAY_API_TOKEN" ] && echo "已配置" || echo "未配置")"
echo "========================================"

get_current_deployment_id() {
    local graphql_query='{"query": "query deployments($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status } } } }", "variables": { "input": { "projectId": "'"$RAILWAY_PROJECT_ID"'", "serviceId": "'"$RAILWAY_SERVICE_ID"'", "environmentId": "'"$RAILWAY_ENVIRONMENT_ID"'" } } }'
    
    local response
    response=$(curl -s -X POST https://backboard.railway.com/graphql/v2 \
        -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$graphql_query" 2>&1)
    
    # Extract deployment ID from response
    local deployment_id=$(echo "$response" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"$//')
    
    if [ -n "$deployment_id" ]; then
        echo "$deployment_id"
        return 0
    else
        return 1
    fi
}

trigger_deployment_restart() {
    log "  🚀 调用Railway API重启当前部署..."
    
    if [ -z "$RAILWAY_API_TOKEN" ]; then
        log "  ⚠️ 未设置 RAILWAY_API_TOKEN，跳过API重启"
        log "     请设置环境变量: RAILWAY_API_TOKEN"
        return 1
    fi
    
    # Get current deployment ID
    local deployment_id
    deployment_id=$(get_current_deployment_id)
    
    if [ -z "$deployment_id" ]; then
        log "  ⚠️ 无法获取当前部署ID，尝试重新部署..."
        trigger_railway_redeploy
        return $?
    fi
    
    log "  📦 当前部署ID: $deployment_id"
    
    local graphql_query='{"query": "mutation deploymentRestart($id: String!) { deploymentRestart(id: $id) }", "variables": { "id": "'"$deployment_id"'" } }'
    
    local response
    response=$(curl -s -X POST https://backboard.railway.com/graphql/v2 \
        -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$graphql_query" 2>&1)
    
    local http_code=$?
    
    if [ $http_code -eq 0 ] && echo "$response" | grep -q "deploymentRestart"; then
        log "  ✅ Railway部署重启已触发"
        return 0
    else
        log "  ⚠️ Railway API调用失败: $response"
        log "  🔄 尝试重新部署..."
        trigger_railway_redeploy
        return $?
    fi
}

trigger_railway_redeploy() {
    log "  🚀 调用Railway API触发重新部署..."
    
    if [ -z "$RAILWAY_API_TOKEN" ]; then
        log "  ⚠️ 未设置 RAILWAY_API_TOKEN，跳过API部署"
        log "     请设置环境变量: RAILWAY_API_TOKEN"
        return 1
    fi
    
    local graphql_query='{"query": "mutation environmentTriggersDeploy($input: EnvironmentTriggersDeployInput!) { environmentTriggersDeploy(input: $input) }", "variables": { "input": { "projectId": "'"$RAILWAY_PROJECT_ID"'", "environmentId": "'"$RAILWAY_ENVIRONMENT_ID"'", "serviceId": "'"$RAILWAY_SERVICE_ID"'" } } }'
    
    local response
    response=$(curl -s -X POST https://backboard.railway.com/graphql/v2 \
        -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$graphql_query" 2>&1)
    
    local http_code=$?
    
    if [ $http_code -eq 0 ] && echo "$response" | grep -q "environmentTriggersDeploy"; then
        log "  ✅ Railway重新部署已触发"
        return 0
    else
        log "  ⚠️ Railway API调用失败: $response"
        return 1
    fi
}

# ==================== 获取OpenCode进程ID ====================
get_opencode_pid() {
    pgrep -f "/\.opencode web" | head -1
}

# ==================== 方法1: SSE事件流监控 ====================
start_event_monitor() {
    log "🔄 启动SSE事件流监控..."
    
    # 后台运行事件监控
    (
        while true; do
            log "  [SSE] 连接到事件流..."
            
            # 连接到SSE端点，捕获活动事件
            curl -N -s "${API_URL}/global/event" 2>/dev/null | while read -r line; do
                # 只检测真正的用户活动事件，过滤系统心跳
                if echo "$line" | grep -qE "data:"; then
                    # 过滤掉系统心跳和连接事件
                    if ! echo "$line" | grep -qE '"type":"server\.(heartbeat|connected)"'; then
                        # 有真正的活动！更新时间戳
                        date +%s > "$LAST_ACTIVITY_FILE"
                        log "  [SSE] 用户活动: $line"
                    fi
                fi
            done
            
            # 如果连接断开，等待后重连
            log "  [SSE] 连接断开，5秒后重连..."
            sleep 5
        done
    ) &
    
    local pid=$!
    echo $pid > "$EVENT_MONITOR_PID_FILE"
    log "  [SSE] 事件监控已启动 (PID: $pid)"
}

stop_event_monitor() {
    if [ -f "$EVENT_MONITOR_PID_FILE" ]; then
        local pid=$(cat "$EVENT_MONITOR_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            log "  [SSE] 事件监控已停止"
        fi
        rm -f "$EVENT_MONITOR_PID_FILE"
    fi
}

# ==================== 活动检测 ====================
is_generating_content() {
    local pid
    pid=$(get_opencode_pid)
    [ -z "$pid" ] && echo "NO_PID" && return 1
    
    local is_generating=0
    local reasons=""
    
    # 检测 1: SSE活动（检查最后活动时间）
    if [ -f "$LAST_ACTIVITY_FILE" ]; then
        local last_activity=$(cat "$LAST_ACTIVITY_FILE")
        local current=$(date +%s)
        local time_since_activity=$((current - last_activity))
        
        if [ "$time_since_activity" -lt 15 ]; then
            is_generating=1
            reasons="${reasons}SSE活动(${time_since_activity}s) "
            date +%s > "$LAST_GENERATION_FILE"
        fi
    fi
    
    # 检测 2: 冷却期
    if [ -f "$LAST_GENERATION_FILE" ]; then
        local last_gen
        last_gen=$(cat "$LAST_GENERATION_FILE")
        local current
        current=$(date +%s)
        local time_since_gen=$((current - last_gen))
        if [ "$time_since_gen" -lt "$GENERATION_GRACE_SECONDS" ]; then
            is_generating=1
            reasons="${reasons}冷却期(${time_since_gen}s) "
        fi
    fi
    
    if [ $is_generating -eq 1 ]; then
        echo "GENERATING|$reasons"
        return 0
    else
        echo "IDLE"
        return 1
    fi
}

# ==================== 获取内存使用 ====================
get_memory_mb() {
    # 统计所有用户进程的 RSS 总和
    local total_kb=$(ps aux | awk 'NR>1 {sum+=$6} END {print sum}' 2>/dev/null || echo 0)
    echo $((total_kb / 1024))
}

# ==================== 重启 ====================
restart_opencode() {
    local reason="$1"
    local mem_before
    mem_before=$(get_memory_mb)
    
    log "========================================"
    log "🔄 触发 OpenCode 重新部署"
    log "  原因: $reason"
    log "  当前内存: ${mem_before}MB"
    
    stop_event_monitor
    
    rm -f "$LAST_GENERATION_FILE" "$LAST_ACTIVITY_FILE"
    
    # 直接调用 Railway API 触发部署重启
    trigger_deployment_restart
    
    log "  ✅ 部署重启请求已发送"
    log "========================================"
    
    # 继续监控，等待 Railway 重新部署容器
    sleep 60
}

# ==================== 主循环 ====================
main() {
    log "🚀 监测服务启动 v4.1 (Global SSE 模式)"
    
    local start_time
    start_time=$(date +%s)
    local consecutive_checks=0
    local check_count=0
    
    # 初始化活动时间
    date +%s > "$LAST_ACTIVITY_FILE"
    
    # 启动SSE事件监控
    start_event_monitor
    
    while true; do
        check_count=$((check_count + 1))
        
        pid=$(get_opencode_pid)
        if [ -z "$pid" ]; then
            sleep "$CHECK_INTERVAL_SECONDS"
            continue
        fi
        
        local current_mem
        current_mem=$(get_memory_mb)
        local uptime
        uptime=$(($(date +%s) - start_time))
        local uptime_hours=$((uptime / 3600))
        
        # 显示状态（每5次检查）
        if [ $((check_count % 5)) -eq 1 ]; then
            log "⏱️ ${uptime_hours}h | 内存:${current_mem}MB"
            
            if [ -f "$LAST_ACTIVITY_FILE" ]; then
                local last_activity=$(cat "$LAST_ACTIVITY_FILE")
                local current=$(date +%s)
                local time_diff=$((current - last_activity))
                log "  [SSE] 最后活动: ${time_diff}s 前"
            fi
        fi
        
        # 检查生成状态
        local gen_status
        gen_status=$(is_generating_content)
        local gen_state
        gen_state=$(echo "$gen_status" | cut -d'|' -f1)
        local gen_info
        gen_info=$(echo "$gen_status" | cut -d'|' -f2-)
        
        # 如果正在生成，重置计数
        if [ "$gen_state" = "GENERATING" ]; then
            if [ $consecutive_checks -gt 0 ]; then
                log "  📝 生成中: $gen_info"
            fi
            consecutive_checks=0
            sleep "$CHECK_INTERVAL_SECONDS"
            continue
        fi
        
        # 检查是否空闲
        if [ -f "$LAST_ACTIVITY_FILE" ]; then
            local last_activity=$(cat "$LAST_ACTIVITY_FILE")
            local current=$(date +%s)
            local idle_time=$(( (current - last_activity) / 60 ))
            
            if [ $idle_time -ge "$IDLE_TIME_MINUTES" ] && [ "$current_mem" -gt "$MEMORY_THRESHOLD_MB" ]; then
                log "💤 空闲 ${IDLE_TIME_MINUTES} 分钟且内存占用 ${current_mem}MB > ${MEMORY_THRESHOLD_MB}MB，执行重启"
                restart_opencode "空闲且高内存"
            elif [ $((check_count % 5)) -eq 0 ]; then
                log "  🟢 全部空闲 (${idle_time}/${IDLE_TIME_MINUTES} 分钟), 内存: ${current_mem}MB"
            fi
        fi
        
        sleep "$CHECK_INTERVAL_SECONDS"
    done
}

trap 'log "🛑 监测退出"; stop_event_monitor; exit 0' SIGINT SIGTERM
main "$@"
