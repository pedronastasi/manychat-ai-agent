# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Reinstall without dev dependencies so they cannot reach the runtime image.
RUN pnpm install --frozen-lockfile --prod

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runs as an unprivileged user. node:alpine ships a `node` user for this.
RUN apk add --no-cache tini && chown -R node:node /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Migrations are applied at startup, so they must ship with the image.
COPY --chown=node:node db/migrations ./db/migrations

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards signals, so SIGTERM reaches the graceful
# shutdown path instead of the container being killed outright.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
