# ---- JSON Schema 表单生成器：一体化构建镜像 ----
# 单镜像内构建前端静态产物并由后端 Express 托管，SQLite 文件落到挂载卷。
FROM node:20-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 优先使用预编译二进制；保留最小构建链以防回退源码编译
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm install

COPY tsconfig.base.json vitest.config.ts ./
COPY packages ./packages
RUN npm run build

# ---- 运行阶段 ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
ENV DB_PATH=/app/data/app.db

COPY package.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
# 仅安装服务端运行时依赖（express、better-sqlite3）；前端为已构建静态文件
RUN npm install --omit=dev --workspace=@jsb/server --include-workspace-root

COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=4s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
