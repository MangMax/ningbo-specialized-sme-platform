# #749 差异决定证据引用离线转接

本切片落实既有 retirement contract：固定完整 71611 副本到独立 71612 副本，保留同一 `difference_reason`。不加入普通 startup migrations，不切换全局 runtime、导入或三个 worker，不迁移 decision-lifecycle、113/114 或 difference-refresh 的写业务。

## 目标布局与读取

`evidence_query_id` 保留列名，当前存储值经 `platform_legacy_query_alias` 转为 `platform_collection.id`；`evidence_relation_id` 经 `platform_legacy_relation_alias` 转为 `platform_business_observation.id`。两列的 FK 指向各自目标 owner，NULL 保持 NULL。query-only、relation-only、paired 与无来源决定均保留。迁移不新增业务配对规则，也不改历史 serialized JSON 中的 external ID。

`difference-reference-target.ts` 声明 typed target table，公开读取通过 aliases 反向投影原 `evidenceQueryId` / `evidenceRelationId`。current、history、详情及 #748 preview 的选择、撤回、排序和分页语义不变。物理目标 ID 不成为公开证据 ID。

仅既有接受的 explicit target writer/replay、fingerprint、来源 reader、correspondence、annual、candidate 与 comparison 支持完整 71612。普通 declarations 仍为 71608；annual 内部事实读取继承既有窄例外。就绪检查只读取支持版本、必要列与相关迁移完成状态，不认证递归 receipt/hash/DDL，不枚举整库业务行。

## 执行与失败恢复

1. 维护窗口停止提交并排空任务，使用已有 snapshot 工具取得 standalone 固定 71611 快照，包含已提交 WAL。保留来源和原回执。操作者维持停写条件；文件 hash 不证明无其他 writer。
2. 独占复制该固定快照为新 target。不得同路径、同 inode、覆盖现有完成目标或用硬链接；源与目标均无未提交 journal/WAL，至少保留 8GiB 可用磁盘。
3. 在本 checkout 使用 Node24.22.2：

   ```sh
   JITI_FS_CACHE=false /Users/mang/.vite-plus/js_runtime/node/24.22.2/bin/node upgrade/run-difference-references.mjs FIXED_SOURCE_71611 INDEPENDENT_TARGET NEW_EVIDENCE_DIR RUN_ID
   ```

4. 查看 `before.json`、`receipt.json`；失败看 `failure.json`。缺失映射列出决定 PK、旧 query/relation ID 及映射目标。整体拒绝，不删行、不补 NULL、不猜配对。
5. 工具在一个 IMMEDIATE 事务内保存原表和必要入向 FK owner、重建原表与 FK、按 alias 复制引用，再恢复原索引、trigger、self previous_id 链和 AUTOINCREMENT 高水位。`foreign_keys` 全程 ON，仅事务内延迟检查；提交前 `foreign_key_check` 与 `integrity_check` 必须通过。
6. 离线完成时比较所有业务表的 PK/行/每单元格 storage class 与字节，只将两列当前存储 FK 逆映射再比；原 migration run/checkpoint 与所有 sequence 同时比对。原 113/114 revision、impact、review、receipt、audit、请求 hash/幂等键、JSON 空白及 external ID 原字节保留。记录新完成状态后才提交 71612。
7. 事务异常整体回滚到原 71611；保留失败证据，用原固定源和同 run 重试，并选新 evidence 目录。已经完成的同源同 run 只读回结果，保留后续正常写入，不从固定源覆盖目标。run/source 冲突应停止并核对输入。

开放目标写入前可回到原快照和原二进制。开放目标写入后不得用旧快照覆盖新提交；继续使用支持 71612 的二进制并前向修复，或另行验证完整逆向工具后恢复。这个迁移没有提供业务逆迁移或生产批准。

此切片仍保留旧 query/relation 表及其他 job/FK。来源当前证据可读不代表 decision-lifecycle、113/114、refresh 写业务已迁移；其业务 owner 继续承接后续工作。完整 Nuxt wire、`_openapi`、全 MCP dispatcher、全项目旧表删除与生产切换不属于本票验证。
