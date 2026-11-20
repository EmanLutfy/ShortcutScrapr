FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# --omit=optional skips playwright/puppeteer (Chromium uses 300-500 MB RAM).
COPY package.json ./
RUN npm install --omit=optional --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY index.js ./
COPY lib ./lib
COPY server ./server

USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server/index.js"]
