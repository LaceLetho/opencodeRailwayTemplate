FROM node:22-bookworm

ENV NODE_ENV=production
ARG OPENCODE_REF=v1.3.0

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

# Build OpenCode from source so the frontend and backend always come from the same ref.
ENV OPENCODE_SOURCE_DIR="/opt/opencode"
RUN ref="${OPENCODE_REF}" \
  && version="" \
  && channel="" \
  && case "${ref}" in \
    v[0-9]*|[0-9]*) version="${ref#v}"; channel="latest" ;; \
  esac \
  && git clone https://github.com/anomalyco/opencode "${OPENCODE_SOURCE_DIR}" \
  && cd "${OPENCODE_SOURCE_DIR}" \
  && git checkout "${ref}" \
  && if [ -n "${version}" ]; then OPENCODE_VERSION="${version}" OPENCODE_CHANNEL="${channel}" bun install; else bun install; fi \
  && bun run --cwd packages/app build \
  && if [ -n "${version}" ]; then OPENCODE_VERSION="${version}" OPENCODE_CHANNEL="${channel}" bun run --cwd packages/opencode build --single; else bun run --cwd packages/opencode build --single; fi

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy start script, server wrapper, runtime config helpers, and monitor script
COPY start.sh server.js runtime-config.js oh-my-opencode.default.json launch.js ws-proxy.js monitor.sh ./
RUN chmod +x monitor.sh

# Railway injects PORT at runtime
EXPOSE 8080

CMD ["sh", "start.sh"]
