#!/bin/bash
# Use exec to replace the shell, ensuring the working directory is changed
cd /data/workspace
echo "Current directory: $(pwd)"
echo "Starting OpenCode..."
exec bunx opencode-ai web --port "${OPENCODE_PORT:-4096}" --hostname 0.0.0.0
