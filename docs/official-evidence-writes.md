# 正式事实写入契约（#350，父 #302）

本契约消费 A 的 `official-evidence.ts`，不改表。旧载荷无下面字段时沿原协议；
`replay` / `convergeOnly` 明确拒绝这些事实字段。raw 只保存显式 nullable 原文，
不 trim、不取企业现名、record 首名或 canonical 值。C 的精确 reader/selector 留 #351。

## Typed 输入

`evidence.publishedRow: OfficialPublishedRow` 的字段全部显式提供：

```ts
type OfficialDeclaration =
  | { kind: 'existing'; sourceDocumentId: number; basis: string }
  | { kind: 'independent'; sourceDocument: {
      source: 'jxj'; title: string; docNumber: string | null;
      issueDate: string | null; path: string
    }; basis: string }
type OfficialPublishedRow = {
  nameRaw: string | null; usccRaw: string | null; districtRaw: string | null
  declaration: OfficialDeclaration
  storedFileId: number | null; path: string | null
  sha256: string | null; bytes: number | null
  attachment: string | null; sectionKey: string | null
  listNo: number | null; page: number | null; sourceBindingKnown: boolean
  actor: { type: 'user' | 'agent'; id: string }; basis: string
}
```

`existing` 必须命中真实 jxj 声明；显式外层 sourceDocument 元数据、evidence 坐标、
storedFile 及已核内容必须相容。`independent` 是调用者有依据确认的另一正式发布声明，
不经 source/title/docNumber 粗键复用。同批逐字相同的声明（含 basis）共享规划结果；
同 key 回执不重建。SHA/path/storedFileId/标题文号均不证明独立发布；跨批需明确给出
existing 或 independent，否则 ambiguity。没有新增全局自然键或第二来源实体。

path/附件/行/页与外层显式值矛盾即拒绝，不能静默选一层。`sourceBindingKnown=true`
要求真实声明、已核 sha256/bytes、非空 sectionKey 与正 listNo；attachment=null
表示明确无附件。storedFileId/path 不进入 K；null raw 不证明相同或不同。

typed 新事件的 sourceFile/path 与 attachment 保留逐字值，包括路径首尾空白和
attachment=""（与 null 不同）；归组、已核文件、最终计划与落库坐标完全相同。
纯 legacy 沿用原有归组/写入归一化。归组后与 typed 坐标重合的 legacy 重复项
必须拒绝，不能通过覆盖 publishedRow 丢失已公布原文。

`payload.officialEvidenceAppends` 为精确追加数组：

```ts
{ eventId: number; recordId: number; enterpriseId: number;
  expectedVersion: number; // 既有公开 event.revision，不新造第二版本协议
  evidence: { sourceFile: string; attachment: string | null; listNo: number | null;
    page: number | null; publishedRow: OfficialPublishedRow } }[]
```

新事件在原 announcement evidence 下提供 publishedRow；已有 event 不借普通公告重复
静默追加，须走此精确字段。追加 owner 来自当前 event→record→enterprise，不信任捕获 ID。
`payload.officialEvidenceCorrections` 复用原精确 correction request（actor/basis/operations，
不含独立 idempotencyKey），operation 保持 evidence/event/record/enterprise/expectedVersion
及完整 coordinate，仅增 `publishedRow?` 与 `expectedRowRevision?`；提供新 row 时必须
显式 expectedRowRevision（首次补核为0）。correction 的 expectedVersion 仍是原 GET version
SHA256；不与 append 的 event revision 混用。

预检返回 `preflight.officialEvidencePlanHash`，提交在
`payload.officialEvidencePlanHash` 原样带回。此字段不参与该计划的输入摘要；新命令必须
有匹配预检，锁内重读文件/版本/候选/merge 映射并重建计划。旧请求不受此要求。

## 例子

```jsonc
{
  "officialEvidenceAppends": [{
    "eventId": 11, "recordId": 7, "enterpriseId": 3, "expectedVersion": 2,
    "evidence": {
      "sourceFile": "notice.txt", "attachment": null, "listNo": 4, "page": null,
      "publishedRow": {
        "nameRaw": "2021公布旧名", "usccRaw": null, "districtRaw": "原属地",
        "declaration": { "kind": "existing", "sourceDocumentId": 9, "basis": "已核同一正式公布声明" },
        "storedFileId": 5, "path": "notice.txt", "sha256": "<已核64位小写SHA256>", "bytes": 123,
        "attachment": null, "sectionKey": "认定名单", "listNo": 4, "page": null,
        "sourceBindingKnown": true, "actor": { "type": "agent", "id": "reviewer" }, "basis": "原件逐行核实"
      }
    }
  }]
}
```

同事务最终视图移除全部被替换声称，再加入全部拟写声称，owner 按当前归属与本批合法
merge 的最终映射解释。先跨 event 核 K，再判 event 关联；已知 raw 逐字矛盾或确定主体
不同为 source_row_conflict，无法证明 owner 相容为 ambiguity。多 event 相容关联允许。
opt-in 混批的最终集合还包含实际拟新增 legacy 出处（先沿用原计划的事件归组、跳过既有
事件）；它们仍为 unknown，不伪造 sidecar/已知绑定。与 capture/append/correction
最终坐标发生未知重叠时，跨 event/owner 同样返回 ambiguity；纯 legacy 请求保持原义。
既有事件虽跳过插入，仍可能执行原计划冻结的 repointTargets；它们以原 evidenceId
撤旧 locator、加入实际最终 locator，和上述三条事实路径共用最终集合，不能从 payload
另猜收敛。等内容收敛不改真实 latest 的已知/未知及其 K/raw，也不造 sidecar；
unknown 不因同 SHA/同 owner/合法 merge 获豁免。实际 repoint 与 typed correction
不得同批改同一 evidence；同路径 noop、重复同目标沿用原冻结计划的既定规则。
opt-in planHash 包含 repoint 原 locator/事件版本/latest/实核文件，IMMEDIATE 内重读。
同 event 的等价关联只让真正不写入的 append 复用原 evidence；精确 correction
仍修改点名 evidence，其最终 locator 必须参与共同集合，不能因等价 K/raw 被排除。
坐标及 publishedRow 均未变的 correction 保持零修订、零审计、零 CAS113。
最终 claim 明确区分未替换 stored 与本批 proposal，numeric ID 不代表 stored。
同 event/K 的多项更正比较完整拟写事实；仅未替换 stored 才读真实 latest。
append 可复用完整最终事实相同的稳定 ID（stored 或显式 numeric correction）；
后者仍执行更正，不读其已撤去的旧 latest，也不让全新 append 互相充当既有关联。
新增操作合计100、每 evidence 一次、旧新 K 最多200；每 K 源候选/最终 scope 100，N+1
溢出拒绝，event 原300限保持。raw-only 也修订/审计/CAS113，每改变事件每批一次。

import 更正 audit.batchKey=NULL，before/after 明确 importBatchId；原 audit 不改。
merge 删除前原私有 batch recordsFolded 保存 fromRecordSnapshot/eventIds；普通 commit、
同 key retry、outcome 纯投影隐藏二者并仅加 snapshotRef，旧 lineage 全保留。receipt
仍从公开结果脱敏，不建私有复制链；旧缺快照不回填。
