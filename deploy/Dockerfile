# Сервер peeshet: Node сам запускает TypeScript, ничего не собирается.
FROM node:26.11.1-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error
COPY src ./src
CMD ["node", "src/main.ts"]
