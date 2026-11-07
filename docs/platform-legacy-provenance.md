# 旧关联办理采集的独立分页来源补证

`platformLegacyProvenance` 是统一名录导入的显式增量命令，仅用于已有 `business_list` 且 `collectionEvidence=null` 的查询。它保存外部冻结原档已有的采集时间、条件、分页和完整性，不将旧字符串投影提升为 typed 原始响应，不补造 `rawData`、`dataRows` 或响应正文。新采集的既有 typed envelope 准入规则保持不变。

通过 `POST /api/roster/import/preflight` 和 `/commit`，或 `preflight_roster_batch` / `save_roster_batch` 使用同一个幂等键。`sourceKind=platform_archive`；每批 1–100 项，按接口现有正文限制分块。请求字段如下，示例均为合成值：

```json
{
  "idempotencyKey": "legacy-pagination-file-sha-segment-0",
  "sourceKind": "platform_archive",
  "sourceIdentity": "frozen-legacy-pagination",
  "payload": {
    "platformLegacyProvenance": [{
      "queryId": 123,
      "interface": "business_list",
      "queryKey": "9133020078041158X6",
      "rdjb": "1,2,3",
      "queriedAt": "2026-11-06T01:00:00.000Z",
      "sourceIdentity": "frozen/item.json",
      "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "segmentIndex": 0,
      "collection": {
        "source": "businessList",
        "status": "no_record",
        "effectiveConditions": { "uscc": "9133020078041158X6", "combination": "and" },
        "titleScope": { "mode": "selected", "rdjb": ["1", "2", "3"] },
        "queriedAt": "2026-11-06T01:00:00.000Z",
        "completedAt": "2026-11-06T01:00:01.000Z",
        "rows": [],
        "pages": [
          { "source": "businessList", "rdjb": "1", "page": 1, "status": "success", "fetchedCount": 0, "declaredTotal": 0, "error": null },
          { "source": "businessList", "rdjb": "2", "page": 1, "status": "success", "fetchedCount": 0, "declaredTotal": 0, "error": null },
          { "source": "businessList", "rdjb": "3", "page": 1, "status": "success", "fetchedCount": 0, "declaredTotal": 0, "error": null }
        ],
        "fetchedCount": 0, "declaredTotal": 0,
        "completeness": "complete", "fullRange": true, "unfinished": [], "error": null,
        "limits": { "maxRequests": 100, "maxRows": 5000, "maxDurationMs": 60000, "pageSize": 50 }
      },
      "relations": []
    }]
  }
}
```

非空结果的 `collection.rows` 必须是原档完整字符串行集；`relations` 为同序逐行 `{sequenceNo,relationKey,rawFields}`，`relationKey` 必须与该原行 `id` 及库中原关系相等。空字符串、字段缺失和字符串值保持原样，不能从其他查询补值。服务端核对原行总数、顺序、关系键、完整 `rawFields`、页分配及行级 `rdjb`；自然键必须与 `queryId` 指向的查询一致。分页数量、终页、未完成范围与完整性仍走原封套的严格校验。已存补证不同、已占用文件段、查询或原行漂移均整批拒绝。

`sourceSha256` 指整个原 item 文件的 SHA-256；`segmentIndex` 指该文件内的原采集段序号。调用方负责在冻结文件上独立计算摘要并确定原段，应用不会读取调用方机器上的路径，也不能单凭摘要验证未上传的原文件内容。应用将这组来源断言不可变地绑定到查询，并在事务中再次核验现存原行。预检返回 `platformLegacyProvenanceSources` 中的源指纹；随后同键提交重核该指纹。完全相同的补证可幂等重放，另一批同内容补证仅跳过，不覆盖最初 `importBatchId`。

迁移 `0044_platform_legacy_provenance` 新增独立表；补证不更新原查询、原关系 ID/JSON/审核、业务内容版本、采集观察、对应决定或差异解释。成功项明确返回 `provenanceKind=legacy_pagination`、`typedState=unknown`。该命令使用预检/提交，不能通过维护用 replay 端点执行。

公开查询和企业详情的 `query.legacyProvenance` 返回 `kind=legacy_pagination`、来源文件身份/SHA/段序号、批次 ID、源指纹和 `collection` 元数据；默认移除 `collection.rows`，不重复加载大字段。原 `collectionEvidence` 继续为 null；关系的 `sourceRdjb/sourcePage` 可读取独立页来源。原档完整行仅通过 `GET /api/platform/queries/{queryId}/evidence?field=legacyProvenance` 或 `get_platform_query_evidence` 的相同字段分块读回；其内容是独立 legacy collection 的精确 JSON 字节，缺少补证时返回 `isNull=true`。

服务端接缝是 `readLegacyPlatformProvenance(db, queryIds)`（每 400 个 ID 一次元数据查询）和 `legacySourcePositionForSequence(metadata.collection, sequenceNo)`。分页来源不构成 typed 证据，不赋予正式认定效力，也不自动传播人工决定。
