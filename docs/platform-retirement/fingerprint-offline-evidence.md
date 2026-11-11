# #724 离线 fingerprint 恢复输入

状态：S 候选实现，等待独立审查与集成；不代表完整迁移接受。

此入口仅用于隔离副本的 71606 → 71607 successor。不是公开写入口，也不接 C 的 runtime capture/replay。#722 未被引入，F1/F2 不由本入口放行。

`finalizeFingerprintBasis` 的 `source` 是完成且 checkpoint 相符的 71606 predecessor，`target` 是它的隔离副本。`legacySource` 必须是 predecessor receipt 绑定的原始旧源文件。原 receipt、hash、raw/source、alias、索引时间和 seal 不变。

predecessor 之后有索引事件时，调用方还须提供 `eventSource: { path, sha256, snapshot }`：

- `path` 指独立保留的原执行/checkpoint 证据 JSON；`sha256` 固定该文件的原字节。
- `snapshot` 指该证据绑定的完整、冻结、71606 after-state SQLite 副本，包含新旧事实、归档、别名、迁移 receipt 和 allocation highwater。
- 它们来自受信任的原执行证据保管者。工具不生成事件来源证据，不把导出的 target manifest 升格为事件证明。仅有当前 target、request、rule、assignment origin 或 hash 命中时，不能自行填写这个文件。

证据 JSON 的最窄格式：

```json
{
  "predecessorSha256": "原 predecessor 文件 SHA256",
  "targetSha256": "独立冻结 after-state 文件 SHA256",
  "events": [
    {
      "observationId": 12,
      "lifecycle": "command",
      "originalInput": {
        "collectionId": 1,
        "position": { "sequenceNo": 2, "positionState": "unknown" },
        "row": { "sequenceNo": 2, "rawFields": null },
        "assignment": {
          "matchBasis": "none", "verificationStatus": "pending",
          "origin": "command", "actor": { "type": "agent", "id": "original" },
          "basis": "原调用记录"
        }
      }
    }
  ]
}
```

`originalInput` 是原 writer 实际消费的完整对象。不得从 DTO、当前归属或 hash 搜索重建；保留 nested own keys、omitted/null、extra keys、position 和数组顺序。校验使用原对象，Zod 只验证边界，不替换为 clone。该对象按原 envelope canonical 化后与旧 fingerprint 比较，再在内存副本用同源旧 writer 生成独立的持久化投影，检查原事实、raw/source bytes、record/version、全部三来源 projection owner、canonical archive 和 revision1。当前 revision2+ 保留且不进入原 hash。

已证明 command lifecycle 但原输入确未保留时，省略 `originalInput`，封存为 `uncaptured`，不认证 fingerprint。显式 `null` 或不完整对象是输入冲突，不当作缺失。原输入之后找回时也不能替换 uncaptured；须另行授权新隔离目标重建。

bootstrap 事件使用 `{ "observationId": 11, "lifecycle": "legacy-bootstrap" }`。必须有 predecessor 的 paired not_indexed、原 full-raw owner、独立 bootstrap 执行证据和完整 after-state；同时提供原 legacySource，核对原 alias、cells、raw/source bytes、原 envelope 和新索引 mapping。不根据 request 存在或 digest 选择生命周期。未索引观察继续无 basis；未知事件、冲突或缺来源均拒绝。

原 recognized writer 可能在复用旧 version 时，将原本三项均未捕获的 source-fidelity 字段做追加捕获。事件校验只允许这三个字段的原有转换：新观察必须由独立事件证明，sealed raw 的 canonical 内容须等于该 version，三个值须精确等于原 parser 的结果，其他旧字段全部相同。S 只核对冻结的 after-state，不执行该业务更新；任意额外漂移均拒绝。

来源与 after-state 在整个 successor 事务期间冻结。目标完整 manifest、旧 receipt 和 highwater 同新 run/checkpoint 绑定。恢复只追加 basis/archive；DDL、barrier、phase、receipt、恢复行在一个 immediate 事务中提交，任何错误回滚。CLI 写独占 evidence 目录并保留失败目标 manifest、catalog 和逐观察拒绝原因。

CLI 参数：

```text
node upgrade/run-fingerprint-basis.mjs SOURCE_71606 TARGET EVIDENCE RUN_ID PREDECESSOR_RUN_ID [FROZEN_LEGACY_SOURCE] [EVENT_JSON EVENT_SHA256 EVENT_SNAPSHOT]
```

纯 command 恢复无需 legacySource 时，保留该位置为空字符串。必须一次给全三个 event 参数。证据目录必须尚不存在。运行要求实际 FK ON、可用空间不少于 8GiB 并留足输出余量；不允许降低 guard、覆写原证据或清理数据库来继续。
