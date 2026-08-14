# 阶段 1：构建后台管理前端（React + AntD），仅产出静态文件，不进入运行时镜像
FROM node:20-alpine AS admin-build
WORKDIR /build
# 与仓库结构一致（vite outDir 为 ../public/admin），单独 COPY 依赖清单以复用层缓存
COPY admin/package.json admin/package-lock.json ./admin/
WORKDIR /build/admin
RUN npm ci
COPY admin/src ./src
COPY admin/index.html ./index.html
COPY admin/vite.config.js ./
RUN npm run build

# 阶段 2：运行时镜像（只保留运行所需产物，体积最小化）
FROM node:20-alpine

# 时区设为上海（云托管容器默认 UTC，差 8 小时）
ENV TZ Asia/Shanghai
RUN apk add --no-cache tzdata && cp /usr/share/zoneinfo/${TZ} /etc/localtime && echo ${TZ} > /etc/timezone

WORKDIR /app

# 后端依赖独立成层：package.json 不变时复用缓存，加快构建/推送
COPY package.json ./
RUN npm install --production

# 拷贝后端源码
COPY . .

# 用构建产物覆盖仓库中的 public/admin（保证与源码一致），并清理前端源码目录
COPY --from=admin-build /build/public/admin /app/public/admin
RUN rm -rf /app/admin

# 云托管默认端口
ENV PORT=80
EXPOSE 80

CMD ["node", "server.js"]
