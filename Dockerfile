# syntax=docker/dockerfile:1
#
# The VPS path from CLAUDE.md §11: a plain Node process with persistent writable storage.
# Deliberately NOT a serverless image — the monitor's whole baseline lives in data/, and
# claiming persistence on ephemeral storage would be a lie.

# ---- dependencies -----------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app

# corepack is unbundled from Node 25+, so pnpm is installed explicitly. Pinned to match
# the packageManager field, so the image resolves the same dependency graph as a laptop.
RUN npm install -g pnpm@12

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# NOT --prod: this project has no build step, so `tsx` runs the TypeScript directly and is a
# genuine runtime requirement despite living in devDependencies.
RUN pnpm install --frozen-lockfile

# ---- runtime ----------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
# The app binds to 127.0.0.1 by default, which is unreachable through a port mapping, so the
# container listens on all of its own interfaces. Exposure on the host is decided by compose.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3666

RUN npm install -g pnpm@12

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY config ./config
# The committed snapshot baseline ships in the image so the container can run standalone.
# A mounted volume will shadow it — see docker-compose.yml.example.
COPY data ./data

# data/ is written on every check, so it must be owned by the unprivileged user.
RUN chown -R node:node /app/data
USER node

EXPOSE 3666

# /api/status needs no API key, which makes it a valid liveness check even when chat is
# unconfigured — monitoring is designed to work without LLM credentials.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3666)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
