FROM node:22-bookworm

ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    bash \
    procps \
  && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

# Verify bun
RUN bun --version

# Install OpenCode CLI
RUN bun install -g opencode-ai

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy start script, server wrapper, websocket proxy helper, and monitor script
COPY start.sh server.js ws-proxy.js monitor.sh ./
RUN chmod +x monitor.sh

# Railway injects PORT at runtime
EXPOSE 8080

CMD ["sh", "start.sh"]
