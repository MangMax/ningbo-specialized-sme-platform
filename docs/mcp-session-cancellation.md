# 有界 MCP 会话与取消（#444 组件 / #445 接线）

> 阅读范围：下文原有 #444/R1–R4 内容是 S1 交付时的历史记录，其中“#445 待验收/UNRUN”、1877 项旧 output 和 callback epoch 描述均保留原时点。当前 #445 合同及分层证据见末尾“#445 当前接线合同与证据”。后续 PASS 不覆盖历史 FAIL/UNKNOWN。

本票交付可注入的局部组件，不注册生产路由，不改变旧 `/mcp`、全局 toolkit 配置或企业工具。生产显式 `/mcp-session`、所有真实 handler 的完成回执、可信认证 epoch 来源，以及 source/compiled endpoint 验收属于 #445。SDK signal 到达不等于企业 native/worker 工作已停止；后者仍由 #439 独立验收。

本文在局部测试、完整 typecheck 和普通 app build 通过后写入。文档没有参与先前运行；运行输入 SHA 与最终含文档的审查输入分别保存。历史 FAIL/STOP/UNKNOWN 不被后续 PASS 覆盖。

## 装配与身份边界

#444 owner2 原句包含：“接收原native provider及toolkit server factory的薄adapter；标准SDK stateless装配；session委托、public close；无SDK私有Map/取消算法复制。”父后续明确裁定为：标准 SDK 真实装配加新有界 **stateful** 组件；新组件要求 session id，不允许 stateless 退化绕过身份或取消隔离。旧 stateless `/mcp` 的真实 SDK 兼容由 #445 保留旧入口合同。不能宣称本组件支持 stateless 会话取消。

锁定证据使用 toolkit 0.24.2、SDK 1.32.1、Nitro 2.13.4、Vitest 4.1.11。fixture 用真实 Nitro 生成 virtual config、storage 和 async event context，调用原 toolkit factory/node provider 与公共 SDK；不复制 provider、私有 controller/stream/handler Map 或取消算法。fixture 中的 memory 配置只作用于临时包，不是生产配置证明。

`authenticate(event)` 返回以下之一：

- `{kind:'invalid'}`：拒绝为 401 `invalid_identity`。
- `{kind:'anonymous',epoch}`：仅允许完全无 Authorization 的请求；空凭据也不是匿名。
- `{kind:'authorized',principal,epoch}`：需要非空凭据、非空有界 principal，epoch 为可信非负安全整数。

epoch 必须由 caller 提供可信单调代际，不能用 token hash 冒充。epoch 1→2→3 的 ABA 测试只证明回调契约，不证明生产配置轮换。sid 绑定身份类别、principal、epoch；错误身份或旧 epoch 返回 404 `session_not_found`，不关闭或续期合法 owner。初始化结束再次认证，身份变化不得发布候选。认证复核期间即使底层 admission lease 已 native-ready，未发布 handshake 仍收费；transport 在 reserve 前按 lives 中未 published 且未 closing 的 lease 原子核 8 上限。snapshot 的 ready 是底层资源状态，不等于已发布 sid。发布或同步 retire 后释放 handshake 名额，未完成 closing 仍计总额64。

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
| `OwnedIngress.subscribeClosed(listener)` | 实际 peer/socket close 的可撤销观察；已关闭须同步通知，detach 同步移除且不抛错，不能包装不可撤销的 Promise.then |
| `cleanupSession(sid)` | 精确两个 memory namespace 清理后返回严格 `{empty:true}`；void、false、多字段或拒绝都不能释放 |
| `lifecycleClock` | 可信 monotonic now 和组件自己的有界 timer；默认 performance.now，不用 vendor lastAccessed |

局部 fixture 用公共 `Server.setRequestHandler(CallToolRequestSchema, handler)` 与 `ListToolsRequestSchema` 注册完整 probe handler。tools/list 返回局部 probe 的显式元数据；进入、finally 和完成回执实际关联 sid/typed ID。它不是从私有 handlerMap 取出原厂实现，也不证明生产所有工具已接线。#445 必须覆盖全部实际注册 handler；缺回执明确 501 `handler_receipt_unavailable`，不能预先 resolve 一个假的完成 Promise。

SessionConnection 只依赖公开 sessionId、close、closeSSEStream、closeStandaloneSSEStream。公共 connect 边界捕获真实 transport；SDK 分配 sid 时即建立 lease 归属，响应 header 必须一致。provider 分配后抛错仍清理捕获的自身 sid；冲突 sid 不覆盖或清理别的会话。不能信任任意 event sid 做清理。

观察器注册在 `lease.initialize` 已同步进入 started 后进行。注册期间同步 close 或重入 shutdown 只撤销，不能走 unstarted 的无资源释放。正常同步通知返回的 detach 成功后可释放且 factory 不执行；部分登记后 throw、返回非函数、同步通知后的 detach 失败均返回无 owner 隔离记录，cleanup 失败保持 closing/total。组件不能根据 throw 猜测登记是否发生：即使测试外部 Set 为0，没有可靠解绑证明仍收费。失败至64后第65个不再注册，无自动重试，不关闭任何无归属 owner。

factory reject 或返回已登记 borrowed owner 时，先实际 detach 初始化观察；成功才允许 admission 释放无新资源的 lease。detach 在移除前失败时返回无 owner 隔离标记，cleanup 明确失败，保留 closing/total 收费并报告 shutdown incomplete；绝不关闭 borrowed owner，也不重试。新 owner 的公共 close/connect 读取或包装失败也走同一失败裁定：若已取得原始 close 则保存 coalesced closeOwned 并一次调用；无法取得可靠 close 则保持 closing。仅 callback 声称完成不能证明外部 listener 已移除；纯测试直接检查受控 listenerSet。

## 固定资源与方法合同

| 资源 | 上限/规则 |
| --- | --- |
| session 总数 | 64，包含 pending、ready、未完成 closing |
| 未发布 handshake | 8，包含第二次认证复核；第 9 个在 factory/connect/provider 前拒绝，无队列/自动重试 |
| 初始化期限 | created 起 5000 ms，持续到真正发布；factory ready 或认证复核开始不解除期限 |
| 普通 RPC | 每 session 4，全局 32 |
| control | 每 session 2，全局 8；initialized、cancel、DELETE 统一收费 |
| GET SSE | 每 session 1，全局 8；独立于普通与 control |
| 请求 ID | 生命周期最多 256 distinct，包含初始化；完成后保留有界 tombstone |
| body | reading + closing 共 40；initialize 16 KiB，已有 sid 请求 64 KiB |
| body deadline | 5000 ms；termination observation 250 ms，不是关闭成功保证 |
| TTL | idle 300000 ms；absolute 1800000 ms；每 live lease 至多一个 timer |

POST initialize 无 sid 时进行准入；已有 sid 的 POST 支持有 ID 的普通 RPC，以及无 ID 的 initialized/cancel notification。普通 RPC 要求 caller handler 回执。batch 不支持；已有 session 再 initialize 拒绝。number/string ID 不混淆；非初始化 0、空串、非安全整数拒绝，这是新组件合同，不改变旧 `/mcp`。重复 ID 返回 409，不覆盖或取消原请求。256 满返回 503。

字符串 ID 最多 128 UTF-8 bytes（不是 JS 字符数），初始化允许 number 0。cancel 的 reason 若存在，必须是字符串且最多 1024 UTF-8 bytes；超限或非字符串在 provider 前拒绝，不创建 ID 或改变请求收费。边界回归分别覆盖多字节 ID 128/129 bytes 与 reason 1023/1024/1025。

GET 先核身份和生命周期，再收费：同 sid 重复流 409 `stream_already_active`，全局满 503 `stream_capacity`；缺公共 standalone close 为 501。实际 response 完成、provider dispatch 结束及公共流关闭都完成后才释放。SDK Client 自行后台 GET/reconnect 是 SDK 行为，不是 repo 排队或重试。

DELETE 使用 control 配额；满时 503，合法会话继续存在。其他 HTTP 方法 405。无 session 的非 initialize POST 不实现，返回 501。响应使用安全 code，不回显凭据或异常详情。

普通 RPC 只有 handler 完成 **且** 原生 response finish/close 两边结束才释放配额和当前 context。拒绝/永不完成的回执保留收费；关闭不能凭空释放这些 job。控制不占普通槽：普通满时仍可取消，但 control 满或恶意慢 body 占满 40 槽时不保证 cancel 可达。

## body、共享 socket 与错误响应

caller 提供原始 header 对，严格要求一个十进制 Content-Length 且匹配实收 bytes；拒绝 TE、CL+TE、重复 CL、Content-Encoding。Node HTTP parser 提前拒绝与组件拒绝是不同证据层。使用未知长度/chunked body 的客户端需要调整，新端点不承诺任意 SDK fetch/body 形式均兼容。

body 仅消费一次，再精确 bytes 重放，不使用 clone tee 孤儿分支。成功 EOF 释放读槽。timeout/oversize/framing 错误启动自有 ingress termination；250ms 后尚无真实 receipt 则 closing 继续计额，late receipt 可一次释放；拒绝/never 不伪成功，不自动重试。socket 已毁时 HTTP 错误可能不可达，以 server-close/peer EOF/reset 记录为准。

`createSocketOwnership()` 是 caller 可复用的辅助器。listener 必须在路由前登记同 socket 的所有 request/response，包括非 adapter 路由；完成依据真实 request end/close 与 response finish/close。termination 执行前动态复核所有 owner，后续 pipeline 请求可以阻止 destroy；Connection: close 不代表独占。共享 prior 未完成时本请求可保持 closing。代际 handle 禁止旧请求销毁已重用连接。fixture 证明该合同；#445 不能省略全路由登记。

初始化观察的是 socket close，不把正常 request end 或 response finish 当 abort。每个 active owner 至多一个初始化 observer；publish、retire 和失败出口实际 detach，socket close 通知并清空。正常请求不再给共享 closed Promise 累加 reaction；只有 body termination 需要真实 close receipt 时才取得等待链，受 40 个 body charge 限制。缺 subscribeClosed 返回 503；caller detach 违约抛错时仍执行 retire/公共关闭/storage 清理，保留 closing 收费，不宣称已完整回收违约 caller 的外部监听器。

fixture 对已确认属于组件的有界 JSON 错误，用 Node ServerResponse 精确 status/headers/bytes 排队，Content-Length 精确且只 end 一次。包括 501 handler_receipt_unavailable；不缓冲正常 SSE/binary，不复制 H3。纯测试验证组件 501，无 handler/provider dispatch；真实 restart 验证 501 的 137-byte 响应和 Content-Length，并独立要求 tools/list 真正成功。

## 取消、TTL 与两阶段 DELETE

合法 cancel 沿原 provider/SDK controller 通路。验收观察 server 的真实 extra.signal 和 handler gate/finally，不能以 Client Promise reject、client.close 或最终超时替代。两 Client 同 typed ID（含同 token）由 sid 隔离；同 session 兄弟请求不被连带取消。内部业务 gate waiting 是工具内部等待，不是 repo 队列。

unknown、completed、repeated cancel 不创建 ID 状态、不转发给会续 vendor lastAccessed 的 provider、不续 TTL。首次有效 active cancel、成功初始化、已准入普通请求、GET、initialized 才更新 eligible activity。错误身份、容量拒绝不续命；absolute 不受任何 activity 延长。

期限到达先同步 revoke/disarm，再公共 standalone close → owner.close → 捕获 transport.close → 精确 storage receipt → 全部 job 双回执 → 删除 session/claims/ID/timer → lease release。pending late factory resolve 必须先清理，不得发布；factory never、cleanup/receipt never 或失败仍 closing，占总额并报告 incomplete。无资源 factory reject 在确认 observer 已解绑后可以释放。

未发布初始化使用独立 5 秒期限，发布后 idle 仍为 300000 ms。最终 detach 是 caller 回调，即使它正常移除 listener 且正常返回，也可能同步重入 shutdown 或推进组件时钟。组件在 detach 返回并确认 observer 未失败后，再次核对 deadline <= now、life.closing 和 lease ready；撤销或越期返回 503 且不发布 sid，已取得 owner/transport/storage 仍走一次关闭路径。关闭其他 lease 本身不撤销合法的当前 lease。timer 延迟或认证复核挂起同样不能迟到发布。初始化期间 peer close 同样 revoke；已分配 sid 的迟到 provider 返回必须清理自身真实 memory namespace。

DELETE 的 204 只表明公共资源与 storage 阶段完成；最终 lease 仍需等待 DELETE 自己的 response 回执及其余请求。handler 忽略 abort 时，204 后仍可 closing。这样避免 DELETE 自等回执死锁。TTL/DELETE/shutdown 竞争共享同一关闭路径；shutdown 停新 admission、清 timer，但不承诺同步 complete=true 或立即 GC。

实际 transport.close 调用尝试可能来自 owner 路径及显式 captured close，两次尝试不等于底层关闭两次。专门 L 证据在 SDK 公共 onclose 层安全链原 hook，观察每 sid 一个底层事件、一个 owner close、一个 storage 验证；保留 attempt/event 的区别。

storage 限定真实 memory backend，按安装源码的相对 getKeys 语义处理父 mount 键和 namespace 子键，逐一 remove 后再次 getKeys。A 故障验收保留 foreign sid 与相似前缀 witness，不全 mount 清扫。owner/transport close 失败仍尝试精确 storage 清理，但任一失败保留收费。callback `{empty:true}` 本身不是外部真实性证明。

## 分层证据与限制

R4 恢复原件根目录：`/tmp/issue444-r4-restore-1uZ60o`；R3 `/tmp/issue444-r3-restore-642448`、R2 `/tmp/issue444-r2-restore-VPxgLx`、R1 `/tmp/issue444-r1-restore-ort2Y2` 与更早原件均保留。本文此次更新在 R4 type/build 成功后写入，不属于这些 runtime 的输入。临时路径是本机审查证据，不是部署依赖；合并前需由父保管原件。

| 要求 | 证据与性质 |
| --- | --- |
| 准入、配额、ID、body、共享 socket、GET/TTL/epoch callback | R4 pure 99 PASS：原 96 expected 保持，加 3 个最终 detach 重入/期限/隔离回归；phase 用例验证 it.skipIf 实际使用的 helper，已去掉恒真映射；受控 Promise/clock，不冒真实网络 |
| detach 后发布检查 | R4 三项纯回归 PASS：正常移除 listener 后同步 shutdown、只推进 clock 越期限不调 timer、关闭另一初始化会话但当前仍发布；实际 Set/一次 cleanup/jobs/total/shutdown 回执断言，不冒真实 SDK 重入注入证据 |
| 注册失败上界 | R4 重跑既有五种失败各64/65、同步正常notify、三种重入shutdown、foreign owner隔离纯回归PASS；实际listenerSet与charge同时断言 |
| 未发布 handshake 8/9 | R4 AUTH 1 PASS；八个真实 SDK Client 并发第二次认证挂起，第九个实际 HTTP503，factory/connect/provider 均保持8；释放后八sid独立并逐一DELETE |
| 初始化断连/期限/字段 | R4 INIT 1 PASS；真实 provider 分配 sid 后断连和组件时钟到期均不发布，精确清理；真实 Client 控制与 raw 字段边界分列 |
| 重启与局部 tools/list/call | 继承上一轮 O_real_restart_rejects_old_sid_and_accepts_new_Client PASS；两进程顺序自然退出，旧 sid 404/factory0、新 Client 正常；本轮未重跑 |
| 8 pending 拒 9 | R4 T 专用 adapter phase 1 PASS；其他 rpc/get/ttl/restart phase 跳过 T，纯 phase 矩阵独立验证 |
| body 慢流/超限、共享 pipeline、A 分配后异常 | 历史真实 evidence 有限继承，本轮失败出口与 handshake 接缝由 pure 与真实 INIT/AUTH/T 覆盖；不冒历史 case fresh 重跑 |
| GET 1/8、SDK reconnect、ordinary/control 饱和独立 | 历史 M_real_GET_limits_reconnect_and_independent_quotas PASS；raw GET 与真实 Client 事件分列 |
| TTL 活跃 RPC/GET、每 sid 一次底层 onclose | 继承 R2 L 1 PASS；本轮未重跑，只驱动组件时钟，不宣称等待 30 分钟墙钟 |
| 取消隔离、active/internal waiting、late/repeat/unknown | 继承 R1 X 1 PASS；本轮 X/GET/TTL 主逻辑未变，有限继承，不冒 fresh |
| 完整 type | 本轮固定 Node24.22.1/Nuxt typecheck PASS；type 专用 NODE_PATH；router plugin 实际 load/SHA 验证；raw TS/MODULE_NOT_FOUND gate |
| 普通 app build | 本轮固定 Node 直接 Nuxt build exit0，无 NODE_PATH；全 output/四入口/native/models/maps 封存；未启动产物 |
| compiled 新 endpoint、生产 auth/epoch/全部工具回执、旧 stateless 入口兼容 | UNRUN，#445 独立接线与验收，不能从 build exit0 外推 |

fixture 双进程 PID/观测身份、原生 HTTP status/body、typed ID、handler/response/ownership/storage 事件、自然 exit 与所有 binding/生成源码保留。selected restart 没有 raw socket emergencyDestroy 路径，fixture 未强杀；supervisor signals[] 单独记录。61 秒自然退出窗口覆盖 vendor interval 下一 tick，是有限观察，不是精确墙钟保证。正常 fixture dispose 的历史 namespace clear 不能替代 A 的精确无残留证据，也不外推任意 storage 故障。

所有 lane 使用独立 grant/root、900/870/30 秒、5 GiB sampled aggregate RSS、FREE-only 非阻塞锁、same-grant byteCAS 与 release-FIRST。ps birth 秒粒度、未见短命进程和瞬时 RSS 仍 UNKNOWN，封装不是外部硬 watchdog。native 未提供的 process-level unhandled 字段仍 UNKNOWN。

旧 restart 的 H3 request-level unhandled=true、早期类型 FAIL、安装越界/Invalid Authorization/其他历史 STOP 原样保留。本轮无匹配 H3 request error/unhandled 的日志不抹旧失败。构建 warnings 保留原文，不以 exit0 代表无 warning。源 fixture 不是 app compiled endpoint。

## #445 接线清单与审查状态

#445 需要真实认证与单调 epoch 来源、每请求 currentevent、所有已注册 handler 的真实完成回执、全 listener socket ownership、唯一 ingress/replay、原生 response/close 回执和精确 storage 清理；在显式新入口验证 source/compiled 两层，保留旧 `/mcp` 合同。不得把本 fixture 公共 tools/list/probe handler 当生产业务实现。

本票四 owner 已形成候选：admission、transport、test、本文。R4 恢复保持 admission 和原 1822 tracked 文件不变；production 精确保持父最窄修复，本轮仅补 test 和后置本文，无 commit/push/PR 更新。R1–R4 历史发现及父静态跟进保留。R4 Standards attempt02 完整静态审查 0 finding；Spec attempt02 成立的 P2 为本次修复依据，但其 test bytes [68804,147377)、[154123,171445) 等未读，不能签完整 PASS。下一复审须按固定范围完整覆盖并独立整合；旧静态 finding 不伪称运行 RED。本次 dirty 候选由父核验；本说明不是生产启用或 #439 native 取消完成声明。

## D1–D5 收口矩阵

| 冻结项 | 已有证据 | 仍不可外推 |
| --- | --- | --- |
| D1 真实装配 | 临时 Nitro、原 factory/provider/SDK、initialize/list/call/DELETE 控制及继承的两进程 restart | app 生产配置和 compiled endpoint；四入口 app build 未接入新组件 |
| D2 关闭与 storage | 一次公共底层 onclose、精确 memory receipt、foreign witness、自然进程退出 | 任意 storage 故障可靠性、立即 GC、61 秒精确退出保证 |
| D3 有界资源 | 总64/未发布handshake8（含auth复核）、4/32、2/8、GET1/8、body40、16/64KiB、5秒与双回执 | control 满或恶意慢 body 下取消必达；repo 没有队列/自动重试 |
| D4 revoked/late | late init 不发布、cleanup/receipt failed/never 保持 closing、late reconcile 一次释放 | 未观察对象的完整回收；失败后不能强杀冒充产品成功 |
| D5 身份/epoch | anonymous/authorized/invalid、session/typed ID 隔离、ABA callback 单测、真实 wrongidentity/cancel隔离 | 生产 epoch 来源、完整生产工具 context 与回执，由 #445 接线 |

本次 app output 封存含 1877 项、186 个 source map、9 个 native 文件和 58 个外置 package 清单；四入口为 server index、enterprise-read-worker、import-execution-worker、current-export-worker。source map 未发现新 mcp-session 组件引用，符合尚未接生产路由的范围。该构建不能当新组件 compiled 集成证明；组件真实执行证明来自独立 Nitro source fixture。


## #445 当前接线合同与证据

本节是六 owner 实现候选的后置文档，不是整体 ready、审查通过、CI 或生产发布声明。代码运行输入与本次仅含 docs 的最终审查输入分别封存；文档没有参与前述 type/runtime。固定 base 为 `87befe3ade1d2a0b3240a026e19bb3ec5d149df0` / tree `ef85a02ec797ffd5edf5edbd5902bd58a531aed6`。S1 admission/transport/test 字节未改。

### 两个入口与身份

以下身份/RPC错误码以装配、合法framing等更早关卡已通过为前提；public错误优先级见下文。

- 旧 `/mcp` 保持 toolkit stateless：无 session header 的 HTTP 只读和原 URL 的 SDK Client 继续可用；既有写工具鉴权、敏感读取保护、schema 与 configured token 来源规则保留。没有新增旧入口热更新能力承诺。
- 新 `/mcp-session` 显式启用进程内 memory session。工具白名单只有 `list_enterprises`、`get_enterprise_detail`；同时在路由和实际工具集合限制，不能只依赖 `readOnlyHint`。resources/prompts 不引入额外能力；协议初始化、通知、GET、DELETE 等按 S1 合同。
- 新入口只识别 Authorization。任何 `x-mcp-token` 出现（含空值、同时附合法 Authorization）均 `401 invalid_identity`。完全无 Authorization 可以是 anonymous；无效/空凭据不冒充 anonymous。
- sid 绑定 anonymous/authorized 身份、owner 与进程 registry。有效 token 配上别的 anonymous owner sid 是 `404 session_not_found`，不是401；无效 token 仍先401。拒绝不关闭/借用合法 owner，原 owner 仍能只读。字符串/数字 typed ID 不混用，跨 sid/owner 的完成或取消不能解锁别的请求。
- `params.task`、`params._meta['io.modelcontextprotocol/related-task']`、`tasks/*` 在新入口前置拒绝；普通 `_meta` 保留。新入口写工具调用精确403 `tool_not_allowed`，task 为400 `task_not_supported`。

进程启动 capture 不可变 credential snapshot，轮换必须重启。已观察到 `NUXT_MCP_TOKEN` 或本次 event 的当前配置与 snapshot 不同，新 initialize 和已有 sid 的新 dispatch 均 sticky 拒绝，恢复 A 也不复活。当前精确响应是 **401 `invalid_identity`**。父先前指定503属于测试 oracle 过度指定，已更正，仅新 sticky case 改为401；旧503静态候选、正逆差量仍保留。未被观察到的瞬时配置变化不保证检测；无新增热配置控制面，不用 token hash 冒充递增 epoch。跨进程不要求共享数字 epoch：A→B→A 用三个真实进程及新 registry 证明隔离。

### 接线 authority 与完整回执

[nuxt.config.ts](../nuxt.config.ts) 捕获原 toolkit config/transport 虚拟 factory，不把 repo index 的默认配置对象当 route handler。新 [route](../server/routes/mcp-session.ts) 调用实际 toolkit handler，复用 [index](../server/mcp/index.ts) 的原 schema/鉴权；仅由私有对象身份标记的新 event 切换 sessions/两个工具，旧 event 分支保持原义。[runtime helper](../server/utils/mcp-session-runtime.ts) 关联本次 event、实际 factory candidate、原 provider、捕获的公共 transport 和真实 response。

锁定 SDK1.32.1 `Protocol.setRequestHandler` 原 parse+handler 完整注册 thunk，保留 registry 写入与原值/throw，只观察已认领 owner。它包含输入校验、真实 callback、输出校验及 await 的 onCalled；业务 callback finally 不等于完成。cancel 后 SDK 可 suppress send，必须等完整 thunk；unknown method 没有注册 thunk时仅用实际 error send 的严格 ID/owner 关联 fallback。禁止复制 dispatcher/controller/私有 Map。native response finish/close 与 handler 两侧结束才释放，失败/late/永不结束不假 free。DELETE204仅公共资源/storage阶段完成，不替代最终双回执。

原生 body 只读一次。S1 在 toolkit 首次 `readBody` 前收费/限额；POST 对相同有界 bytes 建立 replay。H3 middleware 先得到公开 parsed-body cache，toolkit `toWebRequest` 得到同 URL/method/headers、同 bytes 的 fresh Request，避免已 consumed Request 导致 SDK400。GET/DELETE 不走 JSON.parse/fresh body replay。缓存和 Request 有额外有界拷贝，未提高 initialize16KiB/ordinary64KiB。公共 H3+SDK paired 控制和真实 app 初始化分别证明接缝，不能只凭400消失宣称初始化成功。

### public framing、source 前端与 compiled listener

POST 严格一个十进制 Content-Length，禁止 TE、重复 CL、CL+TE、Content-Encoding；无 sid 16KiB、有 sid 64KiB。当前 public 缺长度是 **400 `invalid_framing`**，超限413 `body_too_large`；早期 #445 issue body 的411是已撤销旧文案，原文仍封存，不是当前测试/产品合同。Node parser 对 duplicate CL、TE+CL 可提前400，和 adapter/frontend code 分开归因，未到 worker 不签 worker PASS。

Nuxt source 的真实 client socket 在 frontend；proxy 重建后的 worker headers/socket 不能冒称 raw client。采用本 Nuxt 实例公开 listen hook、唯一实例 request listener 包装和 app 第一层 scoped handler；不改 Server.prototype/CLI/完整 entry、不 removeAllListeners。pins 同时核 realpath/SHA/次数/ESM export 来源；ufo/radix3 的 ESM pin 不用 require-CJS 入口替代。method/target/baseURL 选择按锁定 H3 routing 语义，baseURL来自可信 Nuxt config，不信 Host 或用户内部 header。

能力声明从 listen hook 成功安装且真实 app handler 发布开始。此前 CLI loading/error 窗口不宣称新 endpoint 已可用；不要求首次 TCP accept 前 MCP 已注册。安装形状/pin/profile 不成立，新功能503 failclosed。安装成立后 public framing400/413优先于 worker auth/graph；合法 framing 再按 worker assembly503 → auth401 → body/RPC 处理。component profile 显式不冒充 frontend axis；compiled direct-node 原 entry 两处 listener 实参使用同一纯 header gate，不依赖 source proxy。

每条原生 route（含非 MCP）登记 request/response ownership，无 MCP 全局 cap 去压旧 route。error JSON 先向精确 native response 有限 end，再等真实 finish/close 后调用原请求 termination；不在 JSON 排队前 destroy worker/proxy socket造成 timeout。不用 Connection:close 充当独占，不无界 drain/缓冲未经鉴权 body。执行 termination 前动态核 prior/later foreign；共享 socket 未结束就不能误毁。listen 前已经存在的未知 socket 无可靠 disposal authority，不能从一个 owner 完成推出整 socket 可回收；unknown close 不假 cleanup。前端额外诊断至多64、worker256条；没有 token/sid/request body 原文或生产 HTTP debug。

### 资源继承和实际证据分层

S1固定64含closing、未发布handshake8、pending5s、ordinary4/32、control2/8、GET1/8、distinct ID256、body40/16–64KiB/5s+250ms观察、idle300000/absolute1800000ms等合同沿用上文。rendezvous/replay受已收费容量及有限 replay集合支配，不新增服务端任务队列；真实关闭失败继续收费。本票没有重复全部容量饱和或30分钟墙钟；继承只限未改 S1 组件及其已证范围。

| 层次 | 实际证据 | 不可外推 |
| --- | --- | --- |
| SDK公开控制 | InMemoryTransport initialize/list、真实 notifications/cancel 到 extra.signal；send-only反例仍保留 | 单独控制不代表 toolkit/Nitro 接线 |
| component source / compiled | 最终两个独立1 PASS，显式 component profile；source1 chunk、compiled4 chunks，各图与输出SHA/边/并集；完整thunk/input/output/onCalled/current-event/cancel send0及owners/requests0 | 临时只读 probe 不是实际企业工具，也不是 Nuxt frontend |
| source app A/W/B/D | actual模块扫描原index及真实readtools；独立迁移DB/企业literal；legacy/no-header/REST；合法schema后精确拒绝/零写；401 pipeline；断连两表面与sibling | A旧诊断overflow不抹除；prelisten未知旧socket仅literal范围；修复版本继承见交付矩阵 |
| source public frontend F/E | 安装/app-entered/refusal-end真实到达；[200,400,200]；gzip400/超限413；parser400单列；worker未收到拒绝不能签workerbody通过 | 不以worker重建CL证明原始framing；旧E invalid_body冲突保留 |
| app compiled C/N/R | 同一真实普通build产物，direct node+enterprise-read native模型/SQL literal；旧入口/REST、合法schema拒绝/零写、400/413/pipeline/sibling；required CJS cache与OS native loads | 不是 componentcompiled 替代实际app，不代表全app可选功能 |
| 三进程 epoch | A→B→A同artifact/同业务DB；旧授权与匿名sid在第三A均404，新Client实际读；旧进程先close再下一spawn原断言完成 | postreadback无独立关闭时间戳、完整snapshot payload、enterprise单独exit，保留UNKNOWN |
| 同进程 sticky | 原owner先真实读；test-only nonce IPC置B/回A ACK；四次本event已存在config cache实际比对及init/原SID精确401 | 仅实际env路径；任意runtimeConfig热API、原在途enterprise gate收口未证 |
| 最终标准T | CLI exit0、raw TS/plugin诊断0；router/Volar/TS shim真实load/SHA；当前完整标准project配置 | 308个物理Vue inventory不等于完整TS program读文件实测；不称全CI |

同进程在途 handler 的可控 config-change gate 没有实际证据，明确 UNKNOWN；未为测试向生产加 probe/热配置 HTTP。企业 native 取消退出由 #439，当前本票 UNRUN。main 子进程与测试DB关闭、saved same-grant FREE和 sampled owned=[]分列；enterprise或fixture child没有单独 exitCode/signal原件时保留UNKNOWN。正常测试关闭可发送SIGTERM；runner emergency signals=[]不等于“无任何signal”。unhandled/短命进程/瞬时RSS完整性同样未知。

### build、类型环境和固定 profile closure

真实 app普通 build的 **native CLI exit0** 与原 wrapper **STOP**同时成立：原闭包审计把ESM边错用require条件寻找不存在的`.cjs`，不得把后续离线审计写成原wrapper成功。后续按Node24真实import/require条件、exists/realpath/SHA及 artifact边界重审；BigInt target、浏览器crypto外置、render-worker运行时URL、chunk-size及plugin-timing warnings保留原文和分类；该次B原log没有secure-exec warning，secure-exec缺边是独立离线审计事实，不伪造日志。

接受 profile `445-readonly-direct-node24.22.1-darwin-arm64-no-codemode-v1`：manifest `3b38f6bdb576eb4c1508c35a2f8509fd683b507e87108f03e5e644aff2e31bfe`，scope validation `cec2259f827c4737801dbefcf4aa43d4a173915cc122d0a19c5e2d1d54ab626d`，runtime obligation `f955ae56307760fbaf49df2eae03557e9035f165e8dcfd44e9d26fe190771ce5`。optional17/dynamic22分类不等于全artifact依赖闭包PASS；固定CodeMode=false/undefined及不可由RPC/headers开启的分支才可豁免，native/model/Drizzle/Sharp/libvips必须实际加载见证。写worker只inventory，不为凑证启动写业务。全部2001项artifact保持封存SHA，生产源0073…与后增的test-only loader/sourcepins分开。

标准T仅type使用本安装vue-router邻接node_modules的 NODE_PATH；锁定公开 `vue-router/volar/sfc-route-blocks` 的CJS实际target SHA `0186b559341b0cfebf9c3f3faf0595ca173e934ea0db73fc0e462ebbcc9c15d1`，必须实际checker load，resolve不能替代load。该环境不传build/runtime，不改deps/tsconfig/include。最终T允许标准`.nuxt`生成357→358共7项差量并完整保留，不能继续声称357exact。T、组件及app产物证据不是一次统一全套测试。

### 六个 TODO 的实际替代与剩余范围

原六条 `it.todo` 不删除，不计PASS。它们是早期清单标题，当前按独立可执行case/分阶段receipt对照，不通过改TODO文字制造绿灯。

| 原TODO尾名 | 实际替代case | 证据/剩余 |
| --- | --- | --- |
| `C_import_control_pinned_SDK_toolkit_H3_Nitro_from_assigned_installation` | `C_public_SDK_import_and_initialize_listTools`；两个 `F_registered_thunk_validation_hook_and_cancel_send_zero` | SDK控制的toolkit/Nitro只是resolve守卫；完整运行接线由两个真实fixture和app C/N/R各自补证 |
| `C_local_SDK_cancel_signal_and_full_thunk_receipt_without_send` | `C_public_SDK_notification_aborts_real_extra_signal`；两个 F | InMemory signal控制与真实完整thunk/onCalled/send0分开；native企业退出不在此范围 |
| `C_registered_output_validation_and_unknown_error_send_fallback` | 两个 F；helper negatives | 输入/输出validation、unknown error-send、late/typedID/foreign隔离均有独立guard，不能用业务finally替代 |
| `C_source_frontend_proxy_pipeline_disconnect_no_collateral_close` | D、W、public frontend F、E；frontend literals | 真实source双ingress与pipeline/断连各自证据；未知prelisten socket回收不宣称实证 |
| `C_compiled_entry_markers_and_legacy_stateless_zero_effect_guards` | compiled C、N、R；最终component-compiled F | 实际app entry2/装配/native模型、旧入口/拒绝零写、raw listener分别证明；fixture不代app |
| `C_three_process_A_B_A_old_sid_never_revives` | `E_three_process_A_B_A_old_authorized_and_anonymous_sid_never_revive` | 真实三进程native PASS加后置离线复核；原读回工具FAIL与缺失原件保持 |

完整fullname、每lane实际selected/filtered/TODO、源码→build→audit→artifact→run SHA、修复版本继承边界、历史FAIL索引在本机最终交付包 `/tmp/issue445-final-offline-IJTmmF`。旧40case正文/expected保持；不是“本轮40项全PASS”。本节没有将原inflight gate、enterprise独立退出、全CI/生产等UNKNOWN/UNRUN归为已覆盖。
