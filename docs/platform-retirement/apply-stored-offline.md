# S / 71608 维护窗口离线 successor

#728 工具不注册 startup migration，不切换 reader/writer，不代表 W 或 R1a 接受。[原契约](contract.md)和[原列契约](apply-stored-query.md)继续拥有业务语义。

## 操作前提与一致快照

操作者先停止 HTTP/MCP 新写提交、任务派发并排空活动 worker，在整个采集、迁移、核验、切换窗口维持无并发写。源、固定快照和 target 均须由该窗口独占管理。工具不会停止服务、检测所有写者或提供在线迁移保证。文件 hash、read-only 连接、read transaction、dev/ino 检查均用于身份/完整性核验，**不证明排除并发写**；不使用 chmod/immutable 参数替代操作条件，也不需要独立 lock-owner 子进程、握手、心跳或监控。

在已获授权的维护窗口执行以下步骤（本票验证只用 synthetic SQLite，生产仍另行批准）：

1. 记录停写、任务排空及源路径身份；备份相关文件。用 SQLite backup 获取独立数据库快照，不能直接复制可能还有 WAL 提交的主文件：

   ```sh
   node upgrade/run-snapshot.mjs SOURCE NEW_SNAPSHOT NEW_EVIDENCE_DIR
   ```

   源以 read-only 打开，SQLite backup 包含一致视图的 WAL 已提交页；只在新快照上转换为 DELETE journal，关闭连接并核 integrity。已有输出（包括同路径/hardlink）拒绝覆盖。receipt 记录原路径/dev/ino、快照 SHA256/schema/phase；备份失败的输出保留用于诊断，不得使用。该 receipt 不声称已验证停写。采集期间无并发写保证快照就是窗口内最终状态，避免遗漏快照后的提交。
2. 最初旧源快照须在 T04/T05 receipt 链建立前获取并一直保留。已有链只能使用其**原文件 SHA/schema/T05a manifest 所绑定**的 legacy 快照；新做 backup 可能改变文件字节，不能拿它冒充原来源，也不能重写旧回执。已有可信 sealed archive 可独立恢复；缺少可信来源报告 uncaptured。
3. 71607 来源必须包括所有后加 command。可用上述 backup 获取它的固定独立快照，再在连接关闭、无 WAL/journal、无写者的条件下逐字节复制为独立 TARGET。迁移阶段只读该固定 SOURCE_71607 和可选原 legacy 快照，绝不从活库持续读取。

   ```sh
   cp SOURCE_71607 TARGET
   node upgrade/run-apply-stored.mjs SOURCE_71607 TARGET NEW_EVIDENCE_DIR RUN_ID PREDECESSOR_RUN_ID [FIXED_LEGACY_SOURCE]
   ```

   TARGET 必须预先存在且独立；source/target/legacy 同 inode 拒绝。有 WAL/活动 journal 的输入拒绝，先走快照采集。8 GiB 可用空间 floor；预留实际数据库及 DDL 临时空间，失败保留原快照与日志。
4. 核对 source/before/after 的完整 SQLite cell manifests、catalog/FK、source pointers、receipt/queryReady，以及独立旧 oracle。相同参数重跑核验完整 checkpoint、manifest 与来源绑定。只有 S、W、R1a 及既定后续切换门槛分别接受后才能切换；本工具成功不能替代这些接受。维持停写直到批准切换完成，不能把早期影子副本作为最终源。

## 保留的认证和事务约束

apply observation-owner 新增五个 exact cell 和独立 sql_fact_title 捕获分支。原 projection、身份、archive/seal、assignment 全 revisions、aliases、hash/time、sequence 高水位由完整前后 manifest 保护。sql_fact_title 使用原 raw SQLite cell 的旧 SQL grammar 和 JS trim，不以 JSON.parse 或 exact_title_raw 代替。

source-only 恢复须独立旧源的 phase0、无 migration run、原 T04/T05a/T05b/T05c/scope receipt 链一致；另重算 T05a manifest。绑定同一 predecessor/legacy 的封闭 callback token 只授予已认证 cell 访问，不提供持续锁保证；普通 verifier 仍要求 sealed snapshot，拒绝伪造 token/plain-cell override，不能用 target 残留旧列自证。sealed snapshot 与旧源冲突拒绝，原 refs 不补写、不 reseal。command basis 仅按旧插入规则 materialize，并核 revision1/key；不兼容保留 uncaptured。

缺档、非法 snapshot 编码、不可逆 cell 明确 uncaptured/queryReady=false；来源/hash/owner/mapping 矛盾拒绝。captured NULL 与未捕获不同。一个 FK-ON immediate transaction 完成七个 incoming owner 的 DDL 重建、恢复、双 captured deferred FK、不可变屏障、manifest、phase/receipt/checkpoint；普通异常连 DDL 一并回滚。重放不修改目标。旧 71607 verifier 在 DDL 前认证，71608 writer/verifier/replay 适配留 W；不能放宽旧 extra-field 检查。

失败保留完整71607和第一 FAIL；成功产物仍仅离线可用。回滚遵循原 contract：仅支持新 phase 的 binary 可打开 successor；不降 user_version、不以旧备份覆盖新事实。旧并发锁验收、原 R1a FAIL、baseline 6 PASS / 1 FAIL 均不被本维护窗口方案重标为 PASS。
