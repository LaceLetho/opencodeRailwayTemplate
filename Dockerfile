FROM node:22-bookworm

ENV NODE_ENV=production
ARG OPENCODE_REF=v1.14.25
ARG SOURCE_MODE=true
ENV SOURCE_MODE=${SOURCE_MODE}
ENV OPENCODE_SOURCE_DIR="/opt/opencode"
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    bash \
    procps \
  && rm -rf /var/lib/apt/lists/*

RUN if [ "${SOURCE_MODE}" = "false" ]; then \
    npm install -g opencode-ai@latest; \
  else \
    curl -fsSL https://bun.sh/install | bash \
    && bun --version \
    && ref="${OPENCODE_REF}" \
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
    && if [ -n "${version}" ]; then OPENCODE_VERSION="${version}" OPENCODE_CHANNEL="${channel}" bun run --cwd packages/opencode build --single; else bun run --cwd packages/opencode build --single; fi \
    && install -m 755 "$(find "${OPENCODE_SOURCE_DIR}/packages/opencode/dist" -type f -path "*/bin/opencode" | head -n 1)" /usr/local/bin/opencode; \
  fi

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy start script, server wrapper, runtime config helpers, and monitor script
COPY start.sh server.js plugin-refresh.js runtime-config.js oh-my-opencode.default.json launch.js source-mode.js ws-proxy.js monitor.sh ./
RUN chmod +x monitor.sh

# Railway injects PORT at runtime
EXPOSE 8080

CMD ["sh", "start.sh"]
