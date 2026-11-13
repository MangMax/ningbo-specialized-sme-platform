# schema0 reconcile 原重放输入

本实现只处理 #771 的 schema0 producer。表示规则来自[原重放断言契约](reconcile-replay-input.md) §1–7 和[对应 ADR](../adr/2026-11-13-reconcile-replay-input.md)。作者交付一个本地候选，独立 Standards、Spec 和 LOCAL 接受由父级安排。#768、#763、#706 仍 NOTREADY，global guards CLOSED。

`freshStoredSlotsSnapshot` 仍先选择最新槽位，再用原 `legacyRowOf` 和 `readCompleteLegacySlot` 认证页。比较和分类保留旧 projection。选中后，`StoredReplayOriginal.read` 在同一同步事务、同一连接中读取原 query 和全部有序 relations。其构造函数私有，调用方只给 query ID，不能提供 raw bag。

snapshot 保存全部 schema 列、原物理 ID、sequence、relation key、name、USCC、alias、sourceText 和源字段。raw 单独区分 SQL NULL 与已解码 JSON，并保留原 storage class 和 hex。TEXT `null`、空对象、历史标量、array 和合法 JSON BLOB 沿原 decoder 读取。business status 保留 string、Buffer 或 NULL，apply status 保持 TEXT 或 NULL。缺 query、坏 bytes 和非法来源类型直接失败。

`PlatformQueryInput` 的内部 stored 分支携带该 snapshot。builder 先按原顺序构造旧 query 对象。encoder 检查完整 sequence 集合和原 normalization，然后调用现有 `platformQuerySourceConflict` 比较所有显式不可变断言。这个调用只选择表示，原 writer 仍负责认证。

旧对象的全部断言兼容时，encoder 返回该对象本身。其 own fields、顺序、NULL、typed raw、普通 bootstrap 和已有请求字节保持。旧 fallback 把 native business status 放入合成 raw 的情形，在调用原 serializer 前选择 reference。

合成断言失真时，整条 query 改为下列固定形状。relations 列出全部原 sequence，不重新编号，也不从 raw.id 重建原 key。

```json
{
	"interface": "business_list",
	"queryKey": "91330211000000771X",
	"rdjb": "1",
	"queriedAt": "2026-11-13T00:00:00.000Z",
	"reuseExisting": true,
	"relations": [{"sequenceNo": 1}]
}
```

该选择发生在 writer 调用之前。外部显式错误请求不经过 encoder。preflight、commit、source authentication、key 和 receipt 规则仍由原 owner 执行。writer 的任何错误都会结束本次调用。

[定向测试](../../tests/reconcile-replay-input-771.test.ts)通过真实 getComparison、原采集 producer、统一导入、正常 service、实际 payload builder 和默认 writer。NULL、空对象、历史 raw、native status、源列冲突、sequence gaps、普通补齐、已提交重放、旧失败恢复和事务故障各有独立断言。完整命令、第一次 FAIL、literal request、cells、receipt、类型诊断与 Git 绑定保存在仓外 `reconcile-slot-capture/replay-input-producer` 证据根。证据中的受控配置只用于本地验证，不改仓库配置。

原 key 为 `" SOURCE771 "` 或空串时，原 `assertPlatformObservationReplay` 与 query comparator 的 key normalization 边界仍会拒绝。测试保存正常 service 的失败和 sequence-only literal reference 的独立失败。这些输入仍 NOTREADY。target 的 ordinary BLOB、bootstrap 和 committed-key 组合没有在本票运行，继续属于 #768。

本票没有 target carry、迁移或公共契约改动。全套测试、build、Nuxt prepare、Nitro、HTTP、MCP、独立 worker、browser、CI、真实业务库和生产均 UNRUN。configured 类型检查的整体 FAIL 与受影响入口的严格诊断差分分别记录，不把差分为零称为 typecheck PASS。
