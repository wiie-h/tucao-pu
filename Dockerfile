FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

RUN mkdir -p /data
ENV DATA_DIR=/data
ENV PORT=3000

EXPOSE 3000
VOLUME ["/data"]

# 用非 root 用户运行
USER node

CMD ["node", "server.js"]
