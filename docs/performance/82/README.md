# #82 全规模隔离基线调查

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


范围：scope:spike，高难度；只交调查报告、位置清单、聚合证据和复现脚本。来源代码 `d198a09f5a6fab2d5358d442d1b6ce47670c7506`；开工时分支 `t3/perf-baseline-spike-82`、集成分支 `t3/implement-spec-81-89`、merge-base 三者相同。#81/#82/#19 通过 gh 读取正文与评论，评论均为空；#19 保持 OPEN。本票不关闭任何 issue，不创建 PR，不修改生产代码/数据库。

先读 [冻结预算](budgets.md)，再读 [调查报告](report.md)。`distribution.json` 只含结构、计数、字段字节分布和参数化查询计划。`inventory.json` 是完整静态位置清单：REST、MCP、ORM/native SQL、事务、JSON、文件与缓存候选；每个入口有归属与保守结论。[fixtures.json](fixtures.json)记录隔离快照指纹、0x/2x规模及5x容量缺口；`measurements.json` 只含聚合结果，不含业务原文、响应内容、查询键或凭据。

## 复现

Node 24.22.0 / pnpm 12.11.2；使用仓库锁文件，无新增依赖。Python 只使用 uv 管理的 3.12 和标准库。原始数据库、文件、请求、凭据、私有日志放在 Git 之外，私有工作目录权限 0700。禁用 core dump；不要启用 heap snapshot（会泄露原文）。一次只运行一个性能命令，避免自身测量互相污染；记录同机其他负载。

```sh
pnpm install --frozen-lockfile
umask 077
mkdir -p /tmp/perf82-private
ulimit -c 0
# SOURCE 是获授权的本机静止数据库文件或既有一致备份；绝不是生产 HTTP URL。
# 脚本仅以文件方式读取源主库/WAL，源端不打开 SQLite。
PYTHONUTF8=1 uv run scripts/perf-82/snapshot.py --source "$SOURCE" --output-dir /tmp/perf82-private/full
node scripts/perf-82/profile.mjs /tmp/perf82-private/full/roster.db /tmp/perf82-private/distribution.json
node scripts/perf-82/inventory.mjs /tmp/perf82-private/inventory.json
node scripts/perf-82/run.mjs --db=/tmp/perf82-private/full/roster.db --work=/tmp/perf82-private --out=/tmp/perf82-private/read.jsonl --concurrency=1,2,5 --rounds=5
node scripts/perf-82/summarize.mjs /tmp/perf82-private/summary.json /tmp/perf82-private/read.jsonl
```

`snapshot.py` 对主库/WAL 在复制前后检查设备/inode/size/mtime/ctime，再核对源/副本 SHA256，并再次核对状态；期间发生变化就拒绝。**不复制 SHM，不打开源 SQLite，不在源端执行 checkpoint/backup/SQL**。在私有副本恢复 WAL 后做 SQLite backup、integrity_check 和 foreign_key_check。仍需选择静止区间；这不是任意活跃数据库的通用热备份保证。既有归档前备份只有约 186MiB，不能代表最终数据；本轮用最终稳定主库+WAL取得一致副本。

默认 run 执行实际仓库 route 模块，放在真正的 h3/loopback HTTP 上；它替代 Nuxt 自动导入并显式归属 JSON 序列化，**不包括 Nitro middleware/MCP 传输**。SQL 主阶段为 better-sqlite3 执行加行物化；SQL字节是返回文本/Blob UTF-8 字节、数值按8字节估算，不是磁盘 I/O。JSON.parse、JSON.stringify 单独计时；logicResidual 包括 Drizzle 映射、聚合、脱敏、框架和测量开销，不能称为纯聚合 CPU。客户端给 TTFB 和首字节后接收时间，不能当作真实公网传输性能。heap/RSS 为 SQL边界、每100次parse及请求结束采样；进程 maxRSS 补充高水位，失败请求只能给最后检查点下界。无需把内部函数测量伪称完整产品接缝。

冷态是新 Node 进程；没有清空 OS 文件缓存。热态是在同进程冷请求之后重复。并发1/2/5是同时入站HTTP请求，单进程同步 SQLite 不会因此获得 SQL 并行。summary 用 nearest-rank，必须保留样本数；小样本 p95/p99 只是观测分位数，不是可靠尾延迟估计。超时/断连与 V8 stderr 明确 OOM 分开记录，失败不计入成功分位数。

写入和扩容只对额外创建的可丢弃副本执行：

```sh
cp /tmp/perf82-private/full/roster.db /tmp/perf82-private/write.db
node scripts/perf-82/run.mjs --db=/tmp/perf82-private/write.db --work=/tmp/perf82-private --out=/tmp/perf82-private/write.jsonl --write --scenarios=preflight_1,preflight_300,preflight_1000,commit_300,commit_1000,mixed_read_write --concurrency=1,2,5 --rounds=5
PYTHONUTF8=1 uv run scripts/perf-82/scale.py --source /tmp/perf82-private/full/roster.db --output /tmp/perf82-private/empty.db --factor 0
PYTHONUTF8=1 uv run scripts/perf-82/scale.py --source /tmp/perf82-private/full/roster.db --output /tmp/perf82-private/scale2.db --factor 2
PYTHONUTF8=1 uv run scripts/perf-82/scale.py --source /tmp/perf82-private/full/roster.db --output /tmp/perf82-private/scale5.db --factor 5
```

2x/5x 保留原文列逐行字节分布及外键拓扑；复制全部业务表，重映射主键/外键和唯一坐标，删除 service_credential。原始 JSON 内嵌身份/ID不重写，副本身份坐标追加后缀；这是**容量工作负载**，不是业务等价夹具，也不是新增真实企业分布。空库保留字典和迁移记录。绝不在这些副本上推导真实业务判断。

最终构建的独立公开传输校验：

```sh
pnpm build
node scripts/perf-82/public.mjs /tmp/perf82-private/full/roster.db /tmp/perf82-private/public.jsonl /tmp/perf82-private
```

该脚本自己保留 loopback 端口、启动 `.output/server/index.mjs`，限制2048MiB堆、只读DB、空文件根、清除继承凭据并禁止外部fetch，打实际HTTP和 `/mcp` JSON-RPC；只测精确查询键，验证200/结构/MCP错误与响应字节，结束后停止自有进程。观察器不修改应用路由。公共传输结果与分段诊断分开保留，不用精确键结果替代广域请求结论。

共享原始证据位置为 `/tmp/ningbo-perf-81-89/evidence82/`，早期同步笔记为 `/tmp/ningbo-perf-81-89/baseline.md`。这些路径是本轮本机交接，可能随临时目录清理失效；仓库只保留可分享聚合材料。复现时重新取得自己的授权副本；不要上传这些私有文件。

受磁盘限制时，先测完并回收自己生成的2x副本，再生成5x。`scale.py --clone-seed --reserve-gib 4` 可要求本地文件系统CoW复制初始1x种子（macOS使用原生clonefile，其他平台要求Node支持强制CoW；种子必须稳定且无非空WAL）；随后仍实际插入全部复制行并校验FK/完整性/原文字节总数。CoW不减少SQL可见行数或逻辑载荷，不是稀疏假数据；仅节省重复种子物理块。默认磁盘预留8GiB，显式最小4GiB；这是夹具磁盘预算，运行堆/SLO不变。副本未完整校验前不能计入基线。

文件读取与冷回填可以用注册源文件的验证副本，避免直接对源目录压测：

```sh
PYTHONUTF8=1 uv run scripts/perf-82/copy_files.py --db /tmp/perf82-private/full/roster.db --source-root "$FILES_SOURCE" --output-root /tmp/perf82-private/owned-files
# 必须新建可丢弃write.db；已有写入测量后的库不能当作干净写基线。
node scripts/perf-82/run.mjs --db=/tmp/perf82-private/write.db --work=/tmp/perf82-private --files=/tmp/perf82-private/owned-files --out=/tmp/perf82-private/files.jsonl --write --scenarios=files,ocr_metadata,ocr_markdown,file_stream --concurrency=1,2,5 --rounds=5
```

copy_files只读隔离DB和原始文件，核对复制前后mtime/size及数据库保存的sha256，不输出私有文件名；缺失数量明确记录。file_stream诊断适配器调用同一个文件正文route，通过私有路径参数转发，仍不是对Nitro路由匹配/Range契约的完整验收。外部OCR API、PDFium渲染、上传、取消/重启恢复仍需#88/#91。

建议第一次在1x上增加 `--selectors=/tmp/perf82-private/selectors.private.json`，把固定企业/event/relation/query ID、精确查询键与文件路径冻结在私有0600文件；后续2x/5x/写入复用同一参数。初次找最大原文会扫描种子，这属于夹具准备，不计HTTP时延，并会预热OS缓存。公共传输脚本可把同一selector路径作为第四个参数，避免每次另扫最大原文。私有selector含企业查询键/文件名，绝不提交Git。空库负例可以使用相同固定ID并记录404/400的预期边界。

精确重现本轮旧实现：检出调查提交 `0bb678dae601e3c7f8cc1c84927a9f16a4e6ce2a`（应用源码仍等于d198a09，只新增研究材料），再准备自己的授权副本运行以上命令。之后合入的集成分支含#83/#85/#87等改动；在合并HEAD重跑属于优化后量测，必须另存输出，不混入d198a09基线。inventory脚本会把相对d198a09已变更/新增的源码标为需重新量测；入仓的inventory/结构/measurements均为冻结的旧实现证据。
