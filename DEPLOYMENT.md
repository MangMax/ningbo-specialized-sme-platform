# 本机 Docker Compose 部署

镜像运行源代码固定为 `3a7d896d8c5d76647e94c94f2a843fe35a0c12fc`，Node 基础镜像固定到官方 `node:22-bookworm-slim` 多架构摘要，依赖按 `pnpm-lock.yaml` 和 pnpm `12.11.2` 安装。Nuxt 使用 Node server 产物启动。数据库迁移从 `/app/db/migrations` 加载。运行层只复制 `.output` 与迁移文件，不复制根 `node_modules`；构建阶段不执行 `pnpm prune`，避免它再次触发项目的 `postinstall`（`nuxt prepare`）。

## 从 Git 跟踪快照构建

在包含部署配置提交的仓库副本中运行。临时构建目录只含 Git 跟踪的文件，不会带入工作区里的文件库、数据库或其他未跟踪内容。

```sh
CONFIG_SHA="$(git rev-parse --short=12 HEAD)"
BUILD_CONTEXT="$(mktemp -d /tmp/spztx-roster-build.XXXXXX)"
git archive "$CONFIG_SHA" | tar -xf - -C "$BUILD_CONTEXT"

export CONFIG_SHA
export ROSTER_STATE_DIR="/absolute/path/outside/repository/roster-state"
export ROSTER_ENV_FILE="/absolute/path/outside/repository/roster-secrets.env" # 可选；不使用密钥时可省略
export ROSTER_PORT=3480

docker compose --project-directory "$BUILD_CONTEXT" -f "$BUILD_CONTEXT/compose.yaml" build
```

`ROSTER_STATE_DIR` 必须是绝对路径且已存在；目录由容器内 UID 1000 的 `node` 用户可写。它承载 `data/roster.db`、`files/`、`incoming/` 和两份 reconciliation JSON。将正式 seed 放在此目录前，应先完成独立备份与复制。

密钥只放在仓库外的 `ROSTER_ENV_FILE`；文件可包含 `NUXT_MCP_TOKEN`、`NUXT_API_TOKEN`、`NUXT_OCR_TOKEN` 等运行时变量。Compose 默认使用空的 `/dev/null`，不会从仓库读取 `.env`。密钥不参与镜像构建。

构建阶段只安装编译 `better-sqlite3` 所需的 `python3`、`make`、`g++`；运行阶段不带编译工具。PDF 页图走 PDFium WASM 与 sharp，DOCX 预览由浏览器内的 `@silurus/ooxml` 绘制，未发现 Poppler、LibreOffice 等外部命令依赖。最小 Debian 镜像未加 CJK 字体包；空 state 验证无法证明所有未嵌入字体的 PDF 在生产 seed 上都能正确显示，需用代表性文件做后续验收。

## 启动和检查

```sh
docker compose --project-directory "$BUILD_CONTEXT" -f "$BUILD_CONTEXT/compose.yaml" up -d --no-build
docker compose --project-directory "$BUILD_CONTEXT" -f "$BUILD_CONTEXT/compose.yaml" ps
```

默认只监听 `127.0.0.1:3480`；可通过 `ROSTER_PORT` 临时换端口。健康检查读取 `/api/health`。容器使用 `restart: unless-stopped`。保留 `$BUILD_CONTEXT` 以便之后用同一 Compose 文件执行 `down`；其中只有 Git 跟踪快照。停止服务后可删除该临时构建目录，持久 state 不受影响。
