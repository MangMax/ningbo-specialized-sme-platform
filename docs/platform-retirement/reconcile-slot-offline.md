# 建立 reconcile 旧槽 capture 的离线 target

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


本操作属于 #764 B1，按[已接受 capture 契约](reconcile-slot-capture.md)建立新鲜 target。保留原 schema0 snapshot 和全部旧 target。只在独立副本上操作。

## 安装 prerequisite 并运行 T04

固定 schema0 source 的文件 hash、schema hash 和输入清单。关闭 source 的写入方，使用 rollback journal。为每次执行分配自己的证据目录，保持至少 8GiB 可用空间。target 必须是新路径。

```sh
JITI_FS_CACHE=false NODE_DISABLE_COMPILE_CACHE=1 \
node upgrade/run.mjs isolated-upgrade-reconcile-slot \
  "$SOURCE" "$TARGET" "$EVIDENCE" "$T04_RUN" 100
```

该命令复制 source、执行普通 expand，再安装 business status BLOB prerequisite 和 reconcile capture prerequisite。T04 的 transform 固定为 `t04-collection-reconcile-slot-v2`。新增 capture 列不进入普通 expand 或启动 guard。

核对证据目录中的 `status-prerequisite.json`、`reconcile-prerequisite.json`、`source-manifest.jsonl` 和 `receipt.json`。新 manifest 包含全部原 relation 输入，不只包含查询和通用 scope。

失败后保留输出。在新的证据目录使用同一个 source、target、run ID 和命令重试。已有 target 必须已具备两个 prerequisite。命令不会在已有 target 上补 DDL。若 prerequisite 安装失败，保留失败 target，从同一个固定 source 建立另一个新 target。

旧 `isolated-upgrade` 和 `isolated-upgrade-status-blob` 保持原 transform、manifest 和回执。不要向已有 running 或 completed target 安装本 prerequisite。

## 完成所有后继离线阶段

按已有操作文档依次执行以下阶段。T05a 使用原 T04 run ID，按已绑定 transform 重验，不重新选择旧 transform。

1. [T05a 观察迁移](t05a-observations.md)和 [T05b 本源投影](t05b-projections.md)。两阶段核对 capture 输入、全部 relation alias、sequence、原 cells 和 sealed archives。T05b 另外核对逐观察的 stored、parsed、reconciled 和 conflict。
2. [T05c 与 collection scopes](t05c-finalization.md)。
3. [fingerprint basis](fingerprint-basis.md)、[apply stored](apply-stored-offline.md)、[candidate scope](current-candidate-scope-capture.md)、[recognized stored](recognized-stored-title.md)、[recognized witness](recognized-witness-capture.md)和 [process stored](process-stored-query.md)。
4. [correspondence](h1c-correspondence-offline.md)、[difference references](difference-references-offline.md)和 [legacy provenance](legacy-provenance-offline.md)，直到 71613。

为各阶段固定所要求的独立 predecessor 副本。保留同一个原 schema0 source，供 fingerprint custody 和 capture 最终核对使用。所有阶段保留新增列、FK、不可变屏障和原 archive ownership。71613 provenance 的新 variant 接受原 T04 provenance envelope；旧 catalog 的 DDL bytes 保持原样。

## 记录 capture completion

71613 和原 provenance completion 完成后，使用原 schema0 source、现有 target 和原 T04 run ID。

```sh
JITI_FS_CACHE=false NODE_DISABLE_COMPILE_CACHE=1 \
node upgrade/run.mjs complete-reconcile-slot \
  "$SOURCE" "$TARGET" "$NEW_EVIDENCE" "$CAPTURE_RUN" "$T04_RUN"
```

核对 `receipt.json`。transform 必须为 `reconcile-slot-capture-v1`，source snapshot hash 必须等于第一次 T04 的固定输入。completion 复用现有 migration run 与 checkpoint 表。

completion 在同一事务核对历史 collection 的身份上下文、原 rawResponse ref、输入 digest、全部观察映射、原档及逐观察比较事实。schema 必须仍等于已完成 71613 provenance 的 catalog。错误或回调故障回滚 completion，不留半条回执。

重复执行时保持同一个 completion run ID。重放只核对本 run 的固定历史集合，允许后续 collection、assignment 和 receipts 留在库中。历史 capture 漂移仍拒绝。测试中的直接 successor 插入只证明这个集合边界，不代表 B2 在线 writer 生命周期已接受。

## 保存验证证据

`tests/reconcile-slot-offline-764.test.ts` 使用 `OFFLINE_764_ROOT` 私有目录。测试要求预先冻结 exact-base T04 模块和旧 71612 predecessor，分别放在 `frozen/base-collections.ts` 与 `frozen/old-71612.sqlite`。前者只调整模块解析路径，保留 exact-base 函数正文；后者必须与 `PLATFORM_757_FIXTURES/normal-71613.sqlite` 的原 receipt 绑定。核对原 archive member 和 hash 后，只提取必要文件。

用一个固定 schema0 source 建立全链基准，故障与漂移 case 使用阶段副本的 COPY0600。不要逐 case 重建全链。每个完成的私有批次归档一次，流式核对全部成员的长度与 SHA256，再释放该批次原始文件和 TMP。保留首个 FAIL、命令、退出码、输入绑定和清理 receipt。

B2 新写与 replay、B3 正常 reconcile、current readers、全局 guards 和生产切换另行接受。本操作不开放这些入口。
