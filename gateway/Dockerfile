FROM node:24-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js bootstrap.js production.js recovery.js guild-service.js player-summary.js mod-normalizer.js mod-service.js verification-service.js ./
COPY test ./test
RUN npm test

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "recovery.js"]
