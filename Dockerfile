# Linux, so the sandbox can mask connection secrets (on macOS/Windows the SDK degrades mask → deny).
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
# bubblewrap + socat: the Claude Code sandbox on Linux. git/curl/ca-certificates: what agents usually need.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap socat git curl ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV NODE_ENV=production DATA_DIR=/data
RUN useradd -m -u 10001 claude && mkdir -p /data && chown claude:claude /data
USER claude
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]
