# Không có bước npm install: dự án chỉ dùng thư viện lõi của Node 22.
FROM node:22-slim
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/trs6.sqlite
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","--disable-warning=ExperimentalWarning","server/index.js"]
