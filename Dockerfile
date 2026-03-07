FROM node:22-bookworm

ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    curl \
    git \
  && rm -rf /var/lib/apt/lists/*

# Install Bun (official installer with bash)
RUN curl -fsSL https://bun.sh/install | bash

# Add Bun to PATH for subsequent commands
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

# Verify bun works
RUN bun --version

# Install OpenCode CLI
RUN bun install -g opencode-ai

# Persist workspace and state to Railway volume
ENV OPENCODE_WORKSPACE=/data/workspace
ENV OPENCODE_STATE=/data/state

WORKDIR /app

# Install proxy server deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY start.sh ./

# Railway injects PORT at runtime. Do not hardcode a default.
EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["bash", "start.sh"]
