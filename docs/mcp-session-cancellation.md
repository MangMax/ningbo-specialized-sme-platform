# 有界 MCP 会话与取消组件（#444）

本票交付可注入的局部组件，不注册生产路由，不改变旧 `/mcp`、全局 toolkit 配置或企业工具。生产显式 `/mcp-session`、所有真实 handler 的完成回执、可信认证 epoch 来源，以及 source/compiled endpoint 验收属于 #445。SDK signal 到达不等于企业 native/worker 工作已停止；后者仍由 #439 独立验收。

本文在局部测试、完整 typecheck 和普通 app build 通过后写入。文档没有参与先前运行；运行输入 SHA 与最终含文档的审查输入分别保存。历史 FAIL/STOP/UNKNOWN 不被后续 PASS 覆盖。

## 装配与身份边界

#444 owner2 原句包含：“接收原native provider及toolkit server factory的薄adapter；标准SDK stateless装配；session委托、public close；无SDK私有Map/取消算法复制。”父后续明确裁定为：标准 SDK 真实装配加新有界 **stateful** 组件；新组件要求 session id，不允许 stateless 退化绕过身份或取消隔离。旧 stateless `/mcp` 的真实 SDK 兼容由 #445 保留旧入口合同。不能宣称本组件支持 stateless 会话取消。

锁定证据使用 toolkit 0.24.2、SDK 1.32.1、Nitro 2.13.4、Vitest 4.1.11。fixture 用真实 Nitro 生成 virtual config、storage 和 async event context，调用原 toolkit factory/node provider 与公共 SDK；不复制 provider、私有 controller/stream/handler Map 或取消算法。fixture 中的 memory 配置只作用于临时包，不是生产配置证明。

`authenticate(event)` 返回以下之一：

- `{kind:'invalid'}`：拒绝为 401 `invalid_identity`。
- `{kind:'anonymous',epoch}`：仅允许完全无 Authorization 的请求；空凭据也不是匿名。
- `{kind:'authorized',principal,epoch}`：需要非空凭据、非空有界 principal，epoch 为可信非负安全整数。

epoch 必须由 caller 提供可信单调代际，不能用 token hash 冒充。epoch 1→2→3 的 ABA 测试只证明回调契约，不证明生产配置轮换。sid 绑定身份类别、principal、epoch；错误身份或旧 epoch 返回 404 `session_not_found`，不关闭或续期合法 owner。初始化结束再次认证，身份变化不得发布候选。

## API 与 caller 回执

`createSessionAdmission()` 提供同步 `reserve()`、有代际的 lease、计数快照和 `shutdown()`。lease 的状态是 pending → ready → closing → closed；关闭可以从 pending 开始。reserve 在任何 factory await 之前收费，返回具体拒绝 reason；只有 transport 层映射 HTTP 状态。

`createSessionInitializationTransport(deps)` 返回 `handle(event, ownedIngress)`、`snapshot()`、`bodySnapshot()`、`requestSnapshot()`、`lifecycleSnapshot()` 和同步启动关闭的 `shutdown()`。

| 注入项 | caller 必须证明的事实 |
| --- | --- |
| `factory(event)` / `provider(factory,event)` | 原 toolkit factory 和 node provider；candidate 显式归属，不能复用他人 owner |
| `adopted(event)` | 本次 provider 实际采用的 owner；未采用 candidate 只关闭自身 |
| `replay(event,request,run)` | 唯一读取后的相同 bytes，经真实 Nitro/H3 公共桥接取得本次 event，不修改共享 event |
| `handlerFinished(event,{sessionId,id,method})` | 注册的完整 handler 实际完成；按 sid + number/string typed ID 关联，不能用 provider 返回 Response 代替 |
| `OwnedIngress.responseFinished` | 原生 response finish/close 的严格 `{finished:true}` 回执，不是 handler 返回或安排发送 |
| `OwnedIngress.closed` / `terminate(reason)` | 此请求所属读取/连接的真实关闭回执，不能把调用 destroy/cancel 当完成 |
| `cleanupSession(sid)` | 精确两个 memory namespace 清理后返回严格 `{empty:true}`；void、false、多字段或拒绝都不能释放 |
| `lifecycleClock` | 可信 monotonic now 和组件自己的有界 timer；默认 performance.now，不用 vendor lastAccessed |

局部 fixture 用公共 `Server.setRequestHandler(CallToolRequestSchema, handler)` 与 `ListToolsRequestSchema` 注册完整 probe handler。tools/list 返回局部 probe 的显式元数据；进入、finally 和完成回执实际关联 sid/typed ID。它不是从私有 handlerMap 取出原厂实现，也不证明生产所有工具已接线。#445 必须覆盖全部实际注册 handler；缺回执明确 501 `handler_receipt_unavailable`，不能预先 resolve 一个假的完成 Promise。

SessionConnection 只依赖公开 sessionId、close、closeSSEStream、closeStandaloneSSEStream。公共 connect 边界捕获真实 transport；SDK 分配 sid 时即建立 lease 归属，响应 header 必须一致。provider 分配后抛错仍清理捕获的自身 sid；冲突 sid 不覆盖或清理别的会话。不能信任任意 event sid 做清理。

## 固定资源与方法合同

| 资源 | 上限/规则 |
| --- | --- |
| session 总数 | 64，包含 pending、ready、未完成 closing |
| pending | 8；第 9 个在 factory/connect 前拒绝，无队列/自动重试 |
| 普通 RPC | 每 session 4，全局 32 |
| control | 每 session 2，全局 8；initialized、cancel、DELETE 统一收费 |
| GET SSE | 每 session 1，全局 8；独立于普通与 control |
| 请求 ID | 生命周期最多 256 distinct，包含初始化；完成后保留有界 tombstone |
| body | reading + closing 共 40；initialize 16 KiB，已有 sid 请求 64 KiB |
| body deadline | 5000 ms；termination observation 250 ms，不是关闭成功保证 |
| TTL | idle 300000 ms；absolute 1800000 ms；每 live lease 至多一个 timer |

POST initialize 无 sid 时进行准入；已有 sid 的 POST 支持有 ID 的普通 RPC，以及无 ID 的 initialized/cancel notification。普通 RPC 要求 caller handler 回执。batch 不支持；已有 session 再 initialize 拒绝。number/string ID 不混淆；非初始化 0、空串、非安全整数拒绝，这是新组件合同，不改变旧 `/mcp`。重复 ID 返回 409，不覆盖或取消原请求。256 满返回 503。

GET 先核身份和生命周期，再收费：同 sid 重复流 409 `stream_already_active`，全局满 503 `stream_capacity`；缺公共 standalone close 为 501。实际 response 完成、provider dispatch 结束及公共流关闭都完成后才释放。SDK Client 自行后台 GET/reconnect 是 SDK 行为，不是 repo 排队或重试。

DELETE 使用 control 配额；满时 503，合法会话继续存在。其他 HTTP 方法 405。无 session 的非 initialize POST 不实现，返回 501。响应使用安全 code，不回显凭据或异常详情。

普通 RPC 只有 handler 完成 **且** 原生 response finish/close 两边结束才释放配额和当前 context。拒绝/永不完成的回执保留收费；关闭不能凭空释放这些 job。控制不占普通槽：普通满时仍可取消，但 control 满或恶意慢 body 占满 40 槽时不保证 cancel 可达。

## body、共享 socket 与错误响应

caller 提供原始 header 对，严格要求一个十进制 Content-Length 且匹配实收 bytes；拒绝 TE、CL+TE、重复 CL、Content-Encoding。Node HTTP parser 提前拒绝与组件拒绝是不同证据层。使用未知长度/chunked body 的客户端需要调整，新端点不承诺任意 SDK fetch/body 形式均兼容。

body 仅消费一次，再精确 bytes 重放，不使用 clone tee 孤儿分支。成功 EOF 释放读槽。timeout/oversize/framing 错误启动自有 ingress termination；250ms 后尚无真实 receipt 则 closing 继续计额，late receipt 可一次释放；拒绝/never 不伪成功，不自动重试。socket 已毁时 HTTP 错误可能不可达，以 server-close/peer EOF/reset 记录为准。

`createSocketOwnership()` 是 caller 可复用的辅助器。listener 必须在路由前登记同 socket 的所有 request/response，包括非 adapter 路由；完成依据真实 request end/close 与 response finish/close。termination 执行前动态复核所有 owner，后续 pipeline 请求可以阻止 destroy；Connection: close 不代表独占。共享 prior 未完成时本请求可保持 closing。代际 handle 禁止旧请求销毁已重用连接。fixture 证明该合同；#445 不能省略全路由登记。

fixture 对已确认属于组件的有界 JSON 错误，用 Node ServerResponse 精确 status/headers/bytes 排队，Content-Length 精确且只 end 一次。包括 501 handler_receipt_unavailable；不缓冲正常 SSE/binary，不复制 H3。纯测试验证组件 501，无 handler/provider dispatch；真实 restart 验证 501 的 137-byte 响应和 Content-Length，并独立要求 tools/list 真正成功。

## 取消、TTL 与两阶段 DELETE

合法 cancel 沿原 provider/SDK controller 通路。验收观察 server 的真实 extra.signal 和 handler gate/finally，不能以 Client Promise reject、client.close 或最终超时替代。两 Client 同 typed ID（含同 token）由 sid 隔离；同 session 兄弟请求不被连带取消。内部业务 gate waiting 是工具内部等待，不是 repo 队列。

unknown、completed、repeated cancel 不创建 ID 状态、不转发给会续 vendor lastAccessed 的 provider、不续 TTL。首次有效 active cancel、成功初始化、已准入普通请求、GET、initialized 才更新 eligible activity。错误身份、容量拒绝不续命；absolute 不受任何 activity 延长。

期限到达先同步 revoke/disarm，再公共 standalone close → owner.close → 捕获 transport.close → 精确 storage receipt → 全部 job 双回执 → 删除 session/claims/ID/timer → lease release。pending late factory resolve 必须先清理，不得发布；factory/cleanup/receipt never 或失败仍 closing，占总额并报告 incomplete。

DELETE 的 204 只表明公共资源与 storage 阶段完成；最终 lease 仍需等待 DELETE 自己的 response 回执及其余请求。handler 忽略 abort 时，204 后仍可 closing。这样避免 DELETE 自等回执死锁。TTL/DELETE/shutdown 竞争共享同一关闭路径；shutdown 停新 admission、清 timer，但不承诺同步 complete=true 或立即 GC。

实际 transport.close 调用尝试可能来自 owner 路径及显式 captured close，两次尝试不等于底层关闭两次。专门 L 证据在 SDK 公共 onclose 层安全链原 hook，观察每 sid 一个底层事件、一个 owner close、一个 storage 验证；保留 attempt/event 的区别。

storage 限定真实 memory backend，按安装源码的相对 getKeys 语义处理父 mount 键和 namespace 子键，逐一 remove 后再次 getKeys。A 故障验收保留 foreign sid 与相似前缀 witness，不全 mount 清扫。owner/transport close 失败仍尝试精确 storage 清理，但任一失败保留收费。callback `{empty:true}` 本身不是外部真实性证明。

## 分层证据与限制

审查原件根目录：`/tmp/issue444-list-recovery-jKBwu4`。临时路径是本机审查证据，不是部署依赖；合并前需由父保管原件。

| 要求 | 证据与性质 |
| --- | --- |
| 准入、配额、ID、body、共享 socket、GET/TTL/epoch callback | 本轮 pure 68 PASS：原 67 回归加 Q_missing_handler_receipt_safe_501_no_dispatch；受控 Promise/clock，不冒真实网络 |
| 重启与局部 tools/list/call | 本轮 O_real_restart_rejects_old_sid_and_accepts_new_Client PASS；同 fixture 包两进程顺序自然退出；旧 sid 404/factory0，新 Client initialize/list/probe/DELETE；memory 不跨进程保存 |
| 8 pending 拒 9、body 慢流/超限、共享 pipeline、A 分配后异常 | 父已接受历史真实 evidence，当前生产组件未更改；本轮不冒 fresh 重跑 |
| GET 1/8、SDK reconnect、ordinary/control 饱和独立 | 历史 M_real_GET_limits_reconnect_and_independent_quotas PASS；raw GET 与真实 Client 事件分列 |
| TTL 活跃 RPC/GET、每 sid 一次底层 onclose | 历史 N_real_TTL_active_RPC_GET_signal_and_shutdown 及关闭事件窄重验 PASS；只驱动组件时钟，不宣称等待 30 分钟墙钟 |
| 取消隔离、active/internal waiting、late/repeat/unknown | 历史 X_real_sdk_signal_quota_identity_and_late_cleanup PASS；真实 SDK signal 归属 oracle 保留 |
| 完整 type | 本轮固定 Node24.22.1/Nuxt typecheck PASS；type 专用 NODE_PATH；router plugin 实际 load/SHA 验证；raw TS/MODULE_NOT_FOUND gate |
| 普通 app build | 本轮固定 Node 直接 Nuxt build exit0，无 NODE_PATH；全 output/四入口/native/models/maps 封存；未启动产物 |
| compiled 新 endpoint、生产 auth/epoch/全部工具回执、旧 stateless 入口兼容 | UNRUN，#445 独立接线与验收，不能从 build exit0 外推 |

fixture 双进程 PID/观测身份、原生 HTTP status/body、typed ID、handler/response/ownership/storage 事件、自然 exit 与所有 binding/生成源码保留。selected restart 没有 raw socket emergencyDestroy 路径，fixture 未强杀；supervisor signals[] 单独记录。61 秒自然退出窗口覆盖 vendor interval 下一 tick，是有限观察，不是精确墙钟保证。正常 fixture dispose 的历史 namespace clear 不能替代 A 的精确无残留证据，也不外推任意 storage 故障。

所有 lane 使用独立 grant/root、900/870/30 秒、5 GiB sampled aggregate RSS、FREE-only 非阻塞锁、same-grant byteCAS 与 release-FIRST。ps birth 秒粒度、未见短命进程和瞬时 RSS 仍 UNKNOWN，封装不是外部硬 watchdog。native 未提供的 process-level unhandled 字段仍 UNKNOWN。

旧 restart 的 H3 request-level unhandled=true、早期类型 FAIL、安装越界/Invalid Authorization/其他历史 STOP 原样保留。本轮无匹配 H3 request error/unhandled 的日志不抹旧失败。构建 warnings 保留原文，不以 exit0 代表无 warning。源 fixture 不是 app compiled endpoint。

## #445 接线清单与审查状态

#445 需要真实认证与单调 epoch 来源、每请求 currentevent、所有已注册 handler 的真实完成回执、全 listener socket ownership、唯一 ingress/replay、原生 response/close 回执和精确 storage 清理；在显式新入口验证 source/compiled 两层，保留旧 `/mcp` 合同。不得把本 fixture 公共 tools/list/probe handler 当生产业务实现。

本票四 owner 已形成候选：admission、transport、test、本文。未修改原 1822 tracked 文件、生产 route/config/index；无企业 DB/native 执行、commit/push/PR。独立 Spec/Standards 审查和最终合并由父安排；本说明不是生产启用或 #439 native 取消完成声明。

## D1–D5 收口矩阵

| 冻结项 | 已有证据 | 仍不可外推 |
| --- | --- | --- |
| D1 真实装配 | 临时 Nitro、原 factory/provider/SDK、initialize/list/call/DELETE 控制及本轮两进程 restart | app 生产配置和 compiled endpoint；四入口 app build 未接入新组件 |
| D2 关闭与 storage | 一次公共底层 onclose、精确 memory receipt、foreign witness、自然进程退出 | 任意 storage 故障可靠性、立即 GC、61 秒精确退出保证 |
| D3 有界资源 | 64/8、4/32、2/8、GET1/8、body40、16/64KiB、5秒与双回执 | control 满或恶意慢 body 下取消必达；repo 没有队列/自动重试 |
| D4 revoked/late | late init 不发布、cleanup/receipt failed/never 保持 closing、late reconcile 一次释放 | 未观察对象的完整回收；失败后不能强杀冒充产品成功 |
| D5 身份/epoch | anonymous/authorized/invalid、session/typed ID 隔离、ABA callback 单测、真实 wrongidentity/cancel隔离 | 生产 epoch 来源、完整生产工具 context 与回执，由 #445 接线 |

本次 app output 封存含 1877 项、186 个 source map、9 个 native 文件和 58 个外置 package 清单；四入口为 server index、enterprise-read-worker、import-execution-worker、current-export-worker。source map 未发现新 mcp-session 组件引用，符合尚未接生产路由的范围。该构建不能当新组件 compiled 集成证明；组件真实执行证明来自独立 Nitro source fixture。
