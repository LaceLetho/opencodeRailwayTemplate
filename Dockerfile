FROM node:22-bookworm

ENV NODE_ENV=production
ARG OPENCODE_VERSION=1.3.2

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

# Install a pinned OpenCode version so redeploys do not silently drift.
RUN bun install -g opencode-ai@${OPENCODE_VERSION}

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy start script, server wrapper, launch helper, websocket proxy helper, and monitor script
COPY start.sh server.js launch.js ws-proxy.js monitor.sh ./
RUN chmod +x monitor.sh

# Railway injects PORT at runtime
EXPOSE 8080

CMD ["sh", "start.sh"]
