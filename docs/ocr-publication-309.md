# 在线 OCR 发布与恢复（#309）

本实现承接 `0001-source-domain-boundaries.md` 的 OCR 责任边界。只改变 OCR 任务和页结果写入；没有新表、迁移、UI 或通用任务协议。文件替换协议和解析输入血缘分别由 #311、#310 处理。

提交时冻结稳定文件 ID、登记 hash、实际 PDF hash、实际页图 hash 与目标页版本（不存在页为 null）。准备阶段只读取目标版本列，不读取旧正文/raw。执行前与发布事务内再次核对登记身份、文件与页图字节；付费提交将通过 hash 校验的单页 PNG 固定成不可变 Blob，避免 hash 后、异步上传前文件被替换。发布前校验全部目标页版本。全部目标可写才发布这一份文件，未列出的历史页保持原样，不再整份盲 replace。不同文件可以分别成功或失败。

`job.result.publication` 是 OCR 自己拥有的持久检查点：保存输入、目标版本、每页远端提交回执、原 markdown/raw 和发布状态。每次拿到原结果即检查点，随后才写可删缓存；页发布与 `publishedVersions` 检查点在同一 SQLite 事务。结果中的 `files`、`ok/failed/pages` 保持既有含义，详细的取消、部分采集、冲突和 unknown 看 `publication.files`。收到但未发布的原结果可以由调用方核实后通过现有显式页版本入口另行提交，恢复本身不会刷新冲突页的预期版本。

显式恢复仍提交 `POST /api/jobs`，参数为原 `files/model` 加 `resumeJobId`。原任务须已结束，并有同文件、模型、选项与服务地址指纹的检查点；新任务引用原任务，保留原输入/目标前提。已完成页复用任务中原结果，已接受的远端 ID 继续轮询，已发布文件只重放回执。恢复不会删除原任务或改写其失败历史。

恢复链共享首个终态源任务的 `job.result.ocrRecovery`：服务器追溯已存检查点中的来源，按文件内容身份、实际页号/页图、目标版本、模型、选项和服务地址指纹定位认领。每页先用 SQLite immediate transaction 原子写 `claimed`，再允许持有者发 POST；开始提交前转 `unknown`，拿到远端 ID 为 `accepted`，原 markdown/raw 落库后为 `complete`。并发恢复、旧源任务再次恢复及子任务别名都读取同一持久账本；accepted 只轮询同一 ID，complete 采用第一份持久原结果，已发布回执与页写入同事务。收到畸缺 accepted/complete 回执时明确失败，不能补发 POST。

只有当前认领的实际持有任务已结束，且调用者明确以该任务 ID 作为 `resumeJobId`，才可为 `unsubmitted/rejected/failed` 建立下一次尝试。旧祖先、只重放回执的子任务、caller request key 及自行传入的 anchor 都不能跳过它；各次尝试保留。`claimed/unknown` 没有超时释放，也不允许以其持有任务为锚点再次付费。未知旧归属不推断为某次新采集；旧付费产物仍可从原任务检查点核对。

共享账本只放在首个终态源任务：通用 checkpoint/finish/progress 和重启对账仅更新活跃任务，`enqueuePersistedJob` 只接收 queued；现有业务重开入口限定各自的非 OCR kind，公开 OCR 提交不走重开同 ID。OCR 只在事务中以 `json_set` 改指定 metadata 分支，不把旧整份 result 写回源任务；多页并发追加不会覆盖兄弟认领。子任务各自保留状态、错误、检查点和已知认领引用。即使恢复持有任务被另一进程启动对账标失败，迟到的原结果仍可追加到终态源任务账本，原失败历史保持；不扩大通用任务框架。

原始执行器也不能绕过这一付费权威。每次新 POST 前，OCR 在 immediate transaction 内核验原任务仍为 running，并把该页 unknown 检查点写入同一行，再允许离开事务发 POST。若对账先将原任务标终态，旧执行器在 POST 前被拦住；若 unknown 检查点先提交，对账和恢复必能看到原尝试的 unknown，不能再认领一次 POST。检查与持久回执间没有让对账插入的间隙，也不依赖只读一次状态或进程内取消标记。原始执行器后续的 accepted/rejected/failed/complete 回调在事务内选择活跃行检查点或终态源任务 metadata；对账后不再整份写终态原 result，迟到付费原结果不会随静默 checkpoint 丢失。发布事务同样拦住已终态的原执行器，保留 capture 供显式恢复发布；已结束原任务的失败史保持。

付费 capture 的 `createdAt` 允许 null（unknown），可删缓存的写入契约仍要求 string。采集分支取得共享首份 capture 后只在时间为 string 时写缓存；未知时间保留在持久 capture/raw 来源封套，跳过这一可删加速件，不改成当前时间。旧缓存缺失时间的读回仍归一为 null，不放宽其它缓存字段契约。

提交前先记录 unknown，收到远端 ID 再记录 accepted。网络中断/进程退出发生在两者之间时，不能判断远端是否接受；恢复明确报告 unknown 并拒绝自动重复付费。在线任务关闭原先整张 PNG 的自动 5xx 重提，避免把第二个付费 job 隐藏在同一回执下。其他调用者的既有 OCR API 重试默认保持。取消只停止发新请求/继续轮询；已接受 ID 和已经拿到的结果保留，后续可显式恢复。

`ocr_result.raw` 使用 `ocr-provenance-v1` JSON 封装保存 `captures` 与 `revisions`。每份 raw 原载荷放在 `captures[].raw`，与采集来源、原 markdown 及已知在线输入引用关联；新采集追加，文本修订引用保留的采集而不冒领其来源。旧行仅在本次被写入时封装，旧 raw 原值完整保留，采集来源和原 markdown 均为 null（unknown），不从最后一次修改的 channel/model 倒填。行上的 markdown/channel/engine/model 仍表示当前文本修订；既有 REST/MCP 页 DTO、页版本和 ID 保持。直接读取存储 raw 的消费者应识别该封装，不能把行来源当成 raw 来源。

代码回滚不会自动把该封套解包；原载荷仍保留在封套内。回滚后的直接 raw 消费者兼容性需单独核对。

验证在真实隔离 SQLite 上，H3 挂载实际任务提交/状态/取消及页路由，识别器为延迟的本地合成 HTTP 服务；MCP 用真实 SDK 内存传输与实际工具 schema/handler，Nitro toolkit 注册及鉴权层不在该 harness 内。两个独立 H3 子进程共用合成 SQLite，验证并发认领。SIGKILL 分别覆盖 claimed 已提交事务但尚未 POST、服务端已接受但客户端未收到 ID、accepted ID 已持久化、complete 原结果已持久化但未发布；重启删缓存后核对真实 POST 数、原 raw 和公开页读回。测试运行 fixtures 使用短 `/tmp/issue309-*`，token 由各 fixture 自行合成，不注入全局非空 token。没有真实付费调用或生产数据。

原执行器对账竞态由两个真实 HTTP 子进程验证：在实际缓存读取已得到 miss 后暂停旧执行器，另一进程首次公开读任务触发真实重启对账；恢复 accepted 或已发布后再放行原执行器，POST 仍只一次。另在原 unknown 事务 COMMIT 后、POST 前 SIGSTOP，另一进程恢复保持 unknown；SIGCONT 只允许原尝试 POST，SIGKILL 则原回执仍不回收。原 POST 服务端已接受但未回 ID 时对账，迟到原 raw 保留后由显式恢复发布。多页同时含原执行器付费页与恢复新认领页，分别保留 owner 与 sibling 回执。测试调度门只在独立 helper 包装实际文件读取/SQLite 事务提交观察点，不替换生产认领逻辑。

文件系统与 SQLite 不是一个原子资源。本票在发布事务内同步重算字节 hash，拒绝观察到的改变；不声称阻止外部进程在最后一次 hash 核对后再换文件，也不实施文件替换协议。远端已接受但客户端永远未收到 ID 的请求保持 unknown，不伪称自动恢复成功。
