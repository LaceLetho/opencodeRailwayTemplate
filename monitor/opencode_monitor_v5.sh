#!/bin/bash
# OpenCode Railway Monitor Script v5
# Monitors system resources and OpenCode process health

set -o pipefail

INTERVAL="${MONITOR_INTERVAL:-30}"
LOG_FILE="${MONITOR_LOG:-/tmp/opencode_monitor.log}"
PID_FILE="/tmp/opencode_monitor.pid"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log "Monitor started - PID: $$, Interval: ${INTERVAL}s"

get_memory_info() {
    local mem_info
    mem_info=$(cat /proc/meminfo 2>/dev/null || echo "")
    
    if [ -n "$mem_info" ]; then
        local mem_total=$(echo "$mem_info" | grep MemTotal | awk '{print $2}')
        local mem_available=$(echo "$mem_info" | grep MemAvailable | awk '{print $2}')
        local mem_free=$(echo "$mem_info" | grep MemFree | awk '{print $2}')
        local buffers=$(echo "$mem_info" | grep Buffers | awk '{print $2}')
        local cached=$(echo "$mem_info" | grep '^Cached:' | awk '{print $2}')
        
        if [ -n "$mem_total" ] && [ -n "$mem_available" ]; then
            local mem_used=$((mem_total - mem_available))
            local mem_used_mb=$((mem_used / 1024))
            local mem_total_mb=$((mem_total / 1024))
            local mem_percent=$((mem_used * 100 / mem_total))
            
            echo "Memory: ${mem_used_mb}MB/${mem_total_mb}MB (${mem_percent}%)"
        else
            echo "Memory: N/A"
        fi
    else
        echo "Memory: N/A (no /proc/meminfo)"
    fi
}

get_swap_info() {
    local swap_info
    swap_info=$(cat /proc/meminfo 2>/dev/null | grep -E "^(SwapTotal|SwapFree):" || echo "")
    
    if [ -n "$swap_info" ]; then
        local swap_total=$(echo "$swap_info" | grep SwapTotal | awk '{print $2}')
        local swap_free=$(echo "$swap_info" | grep SwapFree | awk '{print $2}')
        
        if [ -n "$swap_total" ] && [ "$swap_total" -gt 0 ]; then
            local swap_used=$((swap_total - swap_free))
            local swap_used_mb=$((swap_used / 1024))
            local swap_total_mb=$((swap_total / 1024))
            local swap_percent=$((swap_used * 100 / swap_total))
            
            echo "Swap: ${swap_used_mb}MB/${swap_total_mb}MB (${swap_percent}%)"
        else
            echo "Swap: 0MB/0MB (0%)"
        fi
    else
        echo "Swap: N/A"
    fi
}

get_process_info() {
    local process_name="$1"
    local pids
    pids=$(pgrep -f "$process_name" 2>/dev/null || echo "")
    
    if [ -n "$pids" ]; then
        local total_rss=0
        local count=0
        for pid in $pids; do
            if [ -f "/proc/$pid/status" ]; then
                local rss=$(grep VmRSS "/proc/$pid/status" 2>/dev/null | awk '{print $2}' || echo "0")
                total_rss=$((total_rss + rss))
                count=$((count + 1))
            fi
        done
        
        if [ $count -gt 0 ]; then
            local total_rss_mb=$((total_rss / 1024))
            echo "${process_name}: ${count} processes, ${total_rss_mb}MB RSS"
        else
            echo "${process_name}: running (memory N/A)"
        fi
    else
        echo "${process_name}: NOT RUNNING"
    fi
}

get_disk_info() {
    local disk_usage
    disk_usage=$(df -h / 2>/dev/null | tail -1 || echo "")
    
    if [ -n "$disk_usage" ]; then
        local usage=$(echo "$disk_usage" | awk '{print $5}')
        local size=$(echo "$disk_usage" | awk '{print $2}')
        local avail=$(echo "$disk_usage" | awk '{print $4}')
        echo "Disk: ${usage} used (${avail} avail / ${size} total)"
    else
        echo "Disk: N/A"
    fi
}

get_load_info() {
    local load
    load=$(uptime 2>/dev/null | awk -F'load average:' '{print $2}' | tr -d ',' | xargs || echo "")
    
    if [ -n "$load" ]; then
        echo "Load: $load"
    else
        if [ -f /proc/loadavg ]; then
            local load_avg=$(cat /proc/loadavg | awk '{print $1,$2,$3}')
            echo "Load: $load_avg"
        else
            echo "Load: N/A"
        fi
    fi
}

# Main monitoring loop
counter=0
while true; do
    counter=$((counter + 1))
    
    # System info
    mem_info=$(get_memory_info)
    swap_info=$(get_swap_info)
    disk_info=$(get_disk_info)
    load_info=$(get_load_info)
    
    # Process info
    opencode_info=$(get_process_info "opencode")
    bun_info=$(get_process_info "bun")
    node_info=$(get_process_info "node")
    
    # Log summary
    log "=== Monitor Tick #$counter ==="
    log "$mem_info | $swap_info | $load_info"
    log "$disk_info"
    log "Processes: $opencode_info | $bun_info | $node_info"
    
    # Check if critical processes are running
    if ! pgrep -f "opencode" > /dev/null 2>&1; then
        log "WARNING: OpenCode process not found!"
    fi
    
    # Sleep for the interval
    sleep "$INTERVAL"
done
