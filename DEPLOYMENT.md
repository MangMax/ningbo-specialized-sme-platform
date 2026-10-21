# 本机 Docker Compose 部署

Compose 镜像标签使用短 `CONFIG_SHA`，镜像 revision 标签由完整 `SOURCE_SHA` 标记实际 Git 提交。Node 基础镜像固定到官方 `node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` 多架构摘要，构建层和运行层共用此引用。项目使用 Node 24.x、pnpm `12.11.2`，继续使用现有 `pnpm-lock.yaml`，安装必须带 `--frozen-lockfile`。本次仅升级运行环境，ExcelJS 保持原版本。Nuxt 使用 Node server 产物启动。数据库迁移从 `/app/db/migrations` 加载。运行层只复制 `.output` 与迁移文件，不复制根 `node_modules`；构建阶段不执行 `pnpm prune`，避免它再次触发项目的 `postinstall`（`nuxt prepare`）。

## 从 Git 跟踪快照构建

在包含部署配置提交的仓库副本中运行。临时构建目录只含 Git 跟踪的文件，不会带入工作区里的文件库、数据库或其他未跟踪内容。

```sh
SOURCE_SHA="$(git rev-parse HEAD)"
CONFIG_SHA="$(git rev-parse --short=12 HEAD)"
BUILD_CONTEXT="$(mktemp -d /tmp/spztx-roster-build.XXXXXX)"
git archive "$SOURCE_SHA" | tar -xf - -C "$BUILD_CONTEXT"

export SOURCE_SHA CONFIG_SHA
export ROSTER_STATE_DIR="/absolute/path/outside/repository/roster-state"
export ROSTER_ENV_FILE="/absolute/path/outside/repository/roster-secrets.env" # 可选；不使用密钥时可省略
export ROSTER_PORT=3480

docker compose --project-directory "$BUILD_CONTEXT" -f "$BUILD_CONTEXT/compose.yaml" build
```

`ROSTER_STATE_DIR` 必须是绝对路径且已存在；目录由容器内 UID 1000 的 `node` 用户可写。它承载 `data/roster.db`、`files/`、`incoming/` 和两份 reconciliation JSON。将正式 seed 放在此目录前，应先完成独立备份与复制。

密钥只放在仓库外的 `ROSTER_ENV_FILE`；文件可包含 `NUXT_MCP_TOKEN`、`NUXT_API_TOKEN`、`NUXT_OCR_TOKEN` 等运行时变量。Compose 默认使用空的 `/dev/null`，不会从仓库读取 `.env`。密钥不参与镜像构建。

构建阶段只安装编译 `better-sqlite3` 所需的 `python3`、`make`、`g++`；运行阶段不带编译工具。PDF 页图走 PDFium WASM 与 sharp，DOCX 预览由浏览器内的 `@silurus/ooxml` 绘制，未发现 Poppler、LibreOffice 等外部命令依赖。最小 Debian 镜像未加 CJK 字体包；空 state 验证无法证明所有未嵌入字体的 PDF 在生产 seed 上都能正确显示，需用代表性文件做后续验收。

`better-sqlite3` 等原生模块必须在目标 Linux 架构的构建层安装或编译，不能复制宿主 macOS 或旧 Node ABI 的 `node_modules`。`.dockerignore` 排除宿主依赖与业务文件，pnpm 的 `allowBuilds` 保留原生构建白名单。跨架构发布需分别构建并运行验收，arm64 的成功不能代替 amd64 验收。运行用户仍为 `node`（UID/GID 1000）；新 native volume 应先由一次性初始化容器创建 `data/files/incoming` 并赋予 1000:1000，随后以非 root 启动应用。

## 升级前备份与回滚

1. 保存当前应用镜像 ID、基础镜像 digest、完整源码 SHA、部署配置和密钥文件位置；保留旧镜像，不覆盖旧标签。停写并停止应用后，归档整个 state（数据库、文件库、任务产物及配置 JSON）。若使用在线 SQLite backup API，只能读取已授权备份源并同时协调文件库一致性，不能直接复制活跃 DB/WAL 作为一致备份。
2. 先将一致备份恢复到本次独占的 Docker native volume，UID/GID 1000 可写。不要挂载宿主活跃生产 DB/WAL。新进程首次打开可写库会自动执行已有迁移；本票不新增或逆转迁移。
3. 用实际生产镜像检查 HTTP health、原生 SQLite 读写与一致备份、迁移 ledger 幂等、重启持久化、`PRAGMA integrity_check` 和 `foreign_key_check`。同一备份上对比升级前后的 HTTP 导出业务内容，并以真实工作簿验证现有解析行为；空库烟测不能代替真实数据验收。
4. 回滚时先停写、停止新容器，对升级后的整个 state 再做独立备份并保留。此票无 schema 变化时，可用保留的旧镜像连接同一 state，先在隔离副本检查兼容性；若需恢复升级前备份，应恢复到另一个目录或新卷，经核对完整性、外键、ID 和审计后切换挂载。保留升级后的卷与备份供对账，不混用不同时点的主库和 WAL，不逆迁移，不删卷、不用 `docker compose down -v`，不覆盖原数据。

## 启动和检查

```sh
docker compose --project-directory "$BUILD_CONTEXT" -f "$BUILD_CONTEXT/compose.yaml" up -d --no-build
docker compose --project-directory "$BUILD_CONTEXT" -f "$BUILD_CONTEXT/compose.yaml" ps
```

默认只监听 `127.0.0.1:3480`；可通过 `ROSTER_PORT` 临时换端口。健康检查读取 `/api/health`。容器使用 `restart: unless-stopped`。保留 `$BUILD_CONTEXT` 以便之后用同一 Compose 文件执行 `down`；其中只有 Git 跟踪快照。停止服务后可删除该临时构建目录，持久 state 不受影响。
