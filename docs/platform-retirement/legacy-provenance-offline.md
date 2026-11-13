# #755 历史分页补录 metadata 离线索引

本工具从完成的 **71612** 固定快照升级独立副本到 **71613**，transform 为 `collection-legacy-provenance-v1`。它落实[补录契约 §1、§6、§7](legacy-provenance-lifecycle.md)，只安装 `platform_collection_legacy_provenance` 并索引原 T04 八列封套。普通 startup migrations、runtime/import/worker guards 保持 CLOSED。

## 准备和执行

1. 在维护窗口停止提交并排空任务。用已有 SQLite backup 工具取得包含已提交 WAL 的独立一致 71612 快照。保留原快照及回执；不能把可写活库当作固定源。文件 hash、只读连接和文件身份检查不证明其他进程已经停写。
2. 将快照复制为新的独立 target。两者必须是 standalone regular files、nlink=1，没有非空 WAL/journal，不得同路径、同 inode 或硬链接。至少保留 8 GiB 可用磁盘。
3. 在本 checkout 使用 Node 24.22.2 执行只读预检。证据目录必须不存在：

   ```sh
   JITI_FS_CACHE=false /Users/mang/.vite-plus/js_runtime/node/24.22.2/bin/node upgrade/run-legacy-provenance.mjs FIXED_SOURCE_71612 INDEPENDENT_TARGET NEW_PREFLIGHT_EVIDENCE RUN_ID --preflight
   ```

4. 确认 `receipt.json` 的 `state=ready`，再用相同源、target、run ID 和另一个全新证据目录执行：

   ```sh
   JITI_FS_CACHE=false /Users/mang/.vite-plus/js_runtime/node/24.22.2/bin/node upgrade/run-legacy-provenance.mjs FIXED_SOURCE_71612 INDEPENDENT_TARGET NEW_RUN_EVIDENCE RUN_ID
   ```

5. 保留 stdout/stderr、exit、`invocation.json`、`receipt.json` 或 `failure.json`、固定源与 target。成功返回 `state=complete,version=71613`。由操作者记录源码 SHA/tree、文件类型、mode、nlink、size 和 SHA256。源快照不得改写或重新备份后冒充同一绑定。

预检使用只读 target 连接，不安装 schema、不预占 segment、不写 run/checkpoint。源必须有 71612 必要列与已完成的 difference reference transform；不递归认证全部 predecessor 回执。它检查 FK/integrity、全 collection/query alias、observation/relation alias、原 provenance PK 集、固定 sealed collection ref 集、archive bytes/length/hash 和已知 archive FK owner 清单。

T04 的八列按原长度帧读取，与保留旧表的逐列 SQLite storage class/bytes 比较。metadata 原 TEXT 与 safe INTEGER 直接转入；source identity 不 trim，SHA/fingerprint 不重算。collection cell 的原 TEXT/BLOB 留在原封套中，不解码、不重新序列化。原没有 provenance 的 T04 collection 和普通 W4a collection 不生成 metadata 行。缺 archive/alias、类型不支持、跨 owner、重复 SHA/segment、未知或未完成源、target 漂移均整体拒绝。

## 事务和恢复

安装 schema 与初始 run/checkpoint 同一事务。每批 metadata INSERT 和累计 checkpoint 同一 IMMEDIATE 事务；默认每批100，程序入口允许1..1000。schema 阶段失败不留下新表；批次失败不留下半批。promotion 失败保留 running 状态及已完成批次。没有 UPDATE、DELETE、REPLACE 或 truncate metadata 的恢复口。

同 run 续跑重新核对冻结源文件 SHA、源 schema、原全库 facts/log/sequence 摘要、transform、目标精确 schema 和 checkpoint。逐条核对已完成历史索引，再继续。最终全 PK 双向覆盖、八列与 metadata、原全库 cells、历史 logs/sequence、schema、FK 和 integrity 全部通过后，在同一事务提交 `user_version=71613` 与 `state=complete`。

失败后先保存失败证据。在原固定源与相同 target 上，以相同 run ID、全新证据目录重试。绑定或 checkpoint 漂移应停止核对来源；不要删除 run、放宽约束或覆盖 metadata 来强行继续。

已完成 run 重放只核对本 run 冻结的历史 metadata、collection、alias、refs、archives、八列与 checkpoint。它不要求 runtime 的总行数仍等于迁移时总数，不重新执行全库初始 manifest 比较。原来无 provenance 的历史 collection 可有后续合法 supplement；新 collection、观察、supplement 和 receipts 保留。重放也不为新行补 metadata。schema 变更或历史绑定漂移会拒绝。

尚未开放写入的失败副本可丢弃并从同一固定源重新复制。**开放写入后须停写，在独立一致副本前向修复，并保留切换后所有 collection、观察、supplement 和 receipts。禁止以 predecessor 备份覆盖新提交。** 本工具未提供逆迁移或生产执行授权。

## 归档所有权和后续 owners

`t04_envelope` 只允许精确引用同 collection、已 sealed 的原 `legacyProvenance` archive。它是二次索引。`supplement` 必须引用独立 TEXT JSON object archive，且 collection 已有 sealed refs、没有原 legacyProvenance ref。全表唯一 `(source_sha256,segment_index)` 跨 origin 生效，archive FK 也唯一。

新表、三个 ref 与 observation fingerprint basis 的 INSERT 边界进行对称排他；仅上述同 owner T04 指针例外。投影/canonical、candidate scope、witness 和 exact title 的原约束继续要求它们指向既有 sealed ref/basis，不能用作新的 provenance archive owner。DDL/triggers、PRAGMA 与原 cell manifest 属于离线 SQLite 基础设施例外；常规 metadata/run/checkpoint CRUD 使用 Drizzle。

typed target schema 和 `requireLegacyProvenanceReady` 仅描述必要列、明确版本与本 successor completion，不导入 upgrade、不在请求时迁移、不建立运行时 predecessor hash 信任链。

W #756 拥有原 query/rows serializer/oracle、公开预检/提交/回执、显式导入与 source writer 的 71613 admission。现有 collection command 拒绝 71613；本票的完成重放证据通过 typed collection、archive、alias 和 receipt owner 接缝构造合成后续数据，没有开放 W command。R #757 拥有统一读取、evidence/display、预算、快照与相关 consumers admission。原 fingerprint 重建仍 UNPROVEN。本 S 候选不接受 W/R、完整 wire、全迁移或生产。

原 first FAIL、#752 baseline 2 FAIL、#753 projection-shape 3 FAIL、旧比较读取失败、wire/OpenAPI timeout/4 UNRUN、历史 TMP 缺口与 #751 配置 custody 偏差保留；本票的定向验证不消除这些历史债务。资格 #738–742 保持冻结。
