# the server (its one dependency is the Anthropic SDK) plus the UI, built beforehand into public/
# (deploy/deploy.sh runs `npm run build`; building it here would reinstall the build tools every time)
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
ENV HOST=0.0.0.0 PORT=3000 CACHE_DIR=/app/cache DATA_DIR=/app/data
# the source may arrive owner-only (e.g. 600 on a Mac); the app runs as "node" and must read it
RUN chmod -R a+rX /app && mkdir -p /app/cache /app/data && chown node:node /app/cache /app/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
