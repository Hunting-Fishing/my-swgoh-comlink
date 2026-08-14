FROM node:24-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js bootstrap.js production.js recovery.js player-summary.js ./
COPY test ./test
RUN node --test --test-name-pattern="counts equipped|counts purchased|preserves public" test/player-summary.test.js

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "recovery.js"]
