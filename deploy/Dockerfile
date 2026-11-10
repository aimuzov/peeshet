# Сервер peeshet: Node сам запускает TypeScript, ничего не собирается.
FROM node:26.11.1-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
COPY deploy/runtime/package.json deploy/runtime/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund --loglevel=error
COPY package.json ./
COPY src ./src
CMD ["node", "src/main.ts"]
