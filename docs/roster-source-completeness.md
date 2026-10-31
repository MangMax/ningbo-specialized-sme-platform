# 文件交接事实对账

本工具是清洗交接验收接缝，不修改 API、数据库、资格规则或解析状态。`parsed` 仅证明文件段解析完成。旧 pipeline 的 `ParsedEntry`（`announcement.ts`）只携带 year/seq，`inputs.ts` 在段归一后覆盖逐行 year/seq 并标记 parsed，`import.ts` 插入事件时未携带 decidedYear/reviewOutcome；这条路径具备丢失正式复核事实的条件。不能仅凭历史空字段断言每行都由该版本产生。当前统一导入 `roster-import.ts` 已持久化传入的复核字段，formalValidity 由现有更正契约处理。

## 输入和执行

先从原页独立整理源事实清单，再读取已入库事件；不要用目标事件反向生成期望值。文件和回执放 Git 外。每份文件单独运行：

```sh
node scripts/verify-roster-source-completeness.mjs /outside-git/manifest.json /outside-git/readbacks.json
```

Node 24，使用仓库已有 zod。退出码 0 表示所声明范围对账一致，1 表示事实/覆盖不一致，2 表示输入非法。输出仅含行索引、字段名和统计，不输出公司或原文。保存输入哈希、读回时间、目标应用身份、命令版本、退出码及输出供交接；工具离线运行，不能证明输入的新鲜度或源事实转录正确性。

`manifest.json` 结构如下（合成示例）：

```json
{
  "sourceFile": "synthetic.pdf",
  "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "declaredRowCount": 1,
  "rows": [{
    "eventId": 51, "evidenceId": 71,
    "attachment": "附件2", "listNo": 1, "page": 2,
    "basis": "正文第1页结论与期限，附件第2页第1行",
    "facts": {
      "eventType": "review", "year": 2021, "batchSeq": null,
      "decidedYear": 2024, "reviewOutcome": "passed",
      "formalValidity": {
        "evidenceId": 71,
        "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "statementPages": [1],
        "interval": { "validFrom": "2024-01-01", "validThrough": "2026-12-31" }
      }
    }
  }]
}
```

`declaredRowCount` 是原件独立数出的全部正式行数，不能用已入库行数代替。每个附件/名单段的每行均需列入，包括未匹配平台、身份或原认定关联待核的行。`basis` 定位字段事实的原页；多段不同结论按行展开。所有 facts 键必填，未知明确 null；未知不强制目标为空，输出 unknown 清单继续交接，不能从平台审核映射 passed。formalValidity 沿用事件的结构（可有 publishedOn、originAwardEventId、interval 或 continuation），无已知期限事实填 null；原认定未关联不妨碍核对已知结论与区间。

`readbacks.json` 是所有相关 `GET /api/roster/events/{id}` **原始响应体数组**，每事件一次，不裁剪 evidence/files。不能使用预检 after、UNEXECUTED 请求或提交成功计数代替。工具核对原件路径/哈希、逐出处 ID/附件/序号/页码、全文件行集合，以及已知事件字段和结构化期限的实际读回；正文 notes 非空不算字段入库。超出 API 单次来源限制时保留失败并走既有窄范围查询流程，不能删掉未读回部分伪造通过。

## 验收边界

只有完整源清单与全部实际读回对账通过，才可报告该文件的“已知事实入库验收完成”；任何缺读回、缺行、重复行或字段差异都保持部分完成。unknown 清单必须随交接保留，不意味着已查清。另行验证当前资格与查询/导出，不能用此工具的通过代替业务结果。

已修的是缺少可执行交接核对的接缝；工具仅检测声明的事实与持久化读回差异，不解析 PDF、不自动判断原件真假、不强制服务端 parsed 状态。历史字段回填由清洗负责人通过当前正式 API 完成，未执行全库修复。
