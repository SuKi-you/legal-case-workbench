FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY ["底座/package.json", "底座/package-lock.json", "/app/底座/"]
RUN npm ci --omit=dev --no-audit --no-fund --prefix /app/底座
COPY ["底座/src", "/app/底座/src"]
COPY ["劳动法插件/package.json", "/app/劳动法插件/"]
COPY ["劳动法插件/src", "/app/劳动法插件/src"]
COPY ["Web封装与上线/案卷工作台/package.json", "/app/Web封装与上线/案卷工作台/"]
COPY ["Web封装与上线/案卷工作台/server", "/app/Web封装与上线/案卷工作台/server"]
COPY ["Web封装与上线/案卷工作台/public", "/app/Web封装与上线/案卷工作台/public"]

USER node
CMD ["node", "--env-file=/run/workbench-config/workbench.env", "/app/Web封装与上线/案卷工作台/server/index.mjs"]
