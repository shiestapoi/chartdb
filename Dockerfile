FROM node:24-alpine AS builder

WORKDIR /usr/src/app

COPY package.json package-lock.json ./

RUN npm ci --no-audit --no-fund

COPY . .

RUN npx vite build

FROM node:24-alpine AS production

ENV NODE_ENV=production \
    PORT=80 \
    DATA_DIR=/data

WORKDIR /app

COPY --from=builder /usr/src/app/dist ./dist
COPY server ./server

RUN mkdir -p /data

EXPOSE 80

CMD ["node", "server/index.mjs"]
