# Atelier's daemon, containerised.
#
# Only the daemon. The browser is on the host by definition, and so is the agent
# — this image exists so that neither of them needs Node, a checkout, or a build
# step to use Atelier: `docker compose up`, then take the .mcp.json off the
# dashboard.

FROM node:22-alpine AS build
WORKDIR /app
# Manifests first, so a dependency install is only redone when dependencies
# actually change.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci
COPY server ./server
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist

# Inside a container, loopback is the container — a daemon bound there is
# reachable by nothing at all. The compose file puts the boundary back by
# publishing this port to the *host's* loopback rather than to every interface.
ENV ATELIER_BIND=0.0.0.0
# State lives on a volume, not in the image: workflows, assets and the token
# have to survive a rebuild.
ENV ATELIER_HOME=/data
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 7717

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:7717/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/daemon.js"]
