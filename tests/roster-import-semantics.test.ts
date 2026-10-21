/**
 * RL-18 —— **写入语义**的逐字回归：改「怎么找既有行」不许改「找到之后做什么」。
 *
 * 做法：把一整套有代表性的批次（七张表 + 事件/出处 + 重名候选 + 归并血缘 + 幂等重放 +
 * 逐项错误的失败批次 + 导出快照）跑进一个全新库，把可观察的写入结果规范化后与
 * `tests/fixtures/roster-import-semantics.golden.json` **逐字比对**。
 *
 * 黄金文件是在**集成 tip（RL-18 之前）**上生成的 —— 所以它冻结的正是「改前」的行为，
 * 本票的任何改动只要让写入结果差一个字节，这条用例就会红。这比「既有用例还绿」更强：
 * 既有用例只覆盖到它各自断言的那几列，这条覆盖**所有列 + 所有逐项结果 + 全部血缘**。
 *
 * 重新生成黄金文件（**只有在确认语义确实该变时才做**，并在提交信息里说明为什么）：
 *
 * ```bash
 * RL18_WRITE_GOLDEN=1 pnpm vitest run tests/roster-import-semantics.test.ts
 * ```
 *
 * 规范化规则（丢 `createdAt`、按 `id` 排序）见 `tests/helpers/roster-import-semantics.ts`。
 *
 * ── 一次**有据的**重新生成（2026-10-16，合入时）─────────────────────────────
 * 黄金文件原先冻结在 `f71825b`。合入 RL-18 时它与集成 tip 不一致，父代理**逐行核对差异**，
 * 确认**只有 14 行**、且**全部**来自 RL-16b 那条被授权的行为新增：归并项的 `detail` 多了
 * `canonicalName` 与血缘 `rename`（以及随之变化的 `itemResultsSha`）——
 * 这是**新增可观察字段**，不是"找到之后做什么"被改动。RL-18 自身的改动（按键定位）**未改任何字节**。
 * 因此在该合并提交里重新生成，并在此留痕；**今后再要重新生成，同样必须先逐行归因**。
 *
 * ── 第二次**有据的**重新生成（2026-10-16，RL-19 合入时）──────────────────────
 * RL-19（收敛可重放）只做了两件事，且都**不涉及「找到之后做什么」**：
 *  1. 预检结果多两个**只读字段**：`evidenceRepoints`（行口径的收敛预算）与
 *     `batchStatus`（预检时该幂等键在库里的批次状态）；
 *  2. 提交摘要多一个**只读字段**：`evidenceRepointed`（真改掉的出处行数）。
 * 逐行核对本文件的差异，确认**只有这三类新增**（以及随之变化的 `preflightResultSha` /
 * `summarySha` —— 它们是对含新字段的规范化 JSON 求的哈希）：本文件覆盖的七个场景里
 * 一条收敛都没发生，故三个新字段**处处为 0**，`add/update/remove/review/failed/written/skipped`
 * 与全部行计数**一个字节都没变**。RL-19 自己那条链路的语义断言在
 * `tests/roster-evidence-repoint.test.ts`（真件上 510 项 / 511 行）。
 *
 * ── 第三次**有据的**重新生成（2026-10-16，合入 RL-18 收尾时，父代理）─────────────
 * 合入 RL-18 收尾（`4e64617`）后本文件出现**两代混拼**：HEAD 侧是**第二次重生成**的版本
 * （`b8d02a5`，已含 RL-19 的三个只读字段），RL-18 侧则是**基于 `ccab1f3`（早于 RL-19）
 * 自己重生成**的版本（`4e64617`）。git 在**文件尾部**把两者接起来，于是**同一个批次在前后的
 * 哈希自相矛盾** —— 合并态里最后那个场景的 `preflightResultSha` 是 RL-18 那一代的
 * （`debcb54b…`），而它前面几步是 RL-19 那一代的（`3fba3bba…`）。**实际输出才是新的，
 * 黄金是旧的那一侧。** 故在**合并后的代码**上第三次重生成，并逐行归因：
 *  1. 与**合并态**相比：只多 1 行 `"evidenceRepointed": 0`、1 行 `failed` 的尾逗号，
 *     以及 6 个 `preflightResultSha` + 6 个 `summarySha`，**共 14 行，再无其它**。
 *     两类哈希变化的原因**不一样**，别混为一谈：
 *       · `summarySha` —— 提交摘要多了只读字段 `evidenceRepointed`；
 *       · `preflightResultSha` —— **预检载荷里根本没有 `summary`**，它是多了两个只读字段
 *         `evidenceRepoints` / `batchStatus`（末步那份 RL-18 时代的载荷缺这两个）。
 *  2. 与**合并前 HEAD（第二次那版）**相比：**375 行新增 / 0 行删除**，单一片段自第 1173 行起，
 *     即**前 1172 行逐字相同**；375 行**全部**是 RL-18 授权新增的那一步
 *     「commit: 同名多主体（按名定位取「第一行」的口径探针）」。**0 删除**即证明既有步骤
 *     一行未被改动、未被重排、未被丢弃。
 * ⇒ 两侧带来的都只有**只读字段的新增**与**已授权的新步骤**，
 * **「找到之后做什么」一个字节未变**。今后再要重新生成，同样必须先逐行归因。
 *
 * ── 上述归因已由**独立审查代理**复核（2026-10-16），结论比父代理的说法更强 ─────────
 * 它不采信自述，自己**按本文件助手的规则复算了哈希**
 * （`sha256(JSON.stringify(v)).slice(0,16)`，见 `tests/helpers/roster-import-semantics.ts`）：
 * `digest({written,skipped,failed})` 正是合并态那个值、`digest({…,evidenceRepointed:0})`
 * 正是新值，且两份文件里 **7/7 步**都满足 `summarySha === digest(outcome.summary)`；
 * 预检侧同理复算出 `digest(preflight − batchStatus − evidenceRepoints)` 正是合并态那个值
 * —— 这就是「两代混拼」的**直接证据**，不是推测。
 * 它另用 `git diff <侧分支> <合并提交>` 对**全部单侧文件**做了合并完整性扫描
 * （**55/55 + 1/1 + 44/44 + 6/6** 全等），并用 `git merge-tree --write-tree` 证明两次合并的树
 * **与 git 自己的自动合并结果逐字节相同** —— 即**父代理一次人工解冲突都没做过**，
 * 不存在手改走样的可能。
 * （它同时纠正了父代理两处说法：相同前缀是 **1172** 行而非 1163；以及上面那条
 * `preflightResultSha` 的成因 —— 父代理原先写成「随摘要多一字段而变」是错的。）
 *
 * ── 内部重放记账不进入 API 黄金（2026-10-17，RL-10 收尾）────────────────────
 * `evidenceRepointTargets` 与 `evidenceRepointPlanFingerprint` 持久化供显式 replay 复用，
 * 但不属于调用方逐项结果。语义记录器对 `item_results` 按同一公开投影求摘要，故此类内部
 * 记账变动不要求重生黄金；API 返回的逐项结果仍逐字冻结。
 *
 * ── #59 兼容新增采集证据（2026-10-18）──────────────────────────────
 * 逐行核对后仅为两个旧 platformQuery 行补 collectionEvidence:null；无结果/计数/哈希变动。
 * 新来源的非空证据与行为由 platform-recognized-evidence.test.ts 验收。
 *
 * ── RL-10 批次身份歧义规则（2026-10-17）──────────────────────────────
 * 本轮只重生新增的最后一步：其 name-only 项与两个不同 USCC 候选同名，现须按 §8.9
 * 返回 `enterprise_ambiguous` 并使整批失败。此前黄金记录了“取第一行”并成功写入，已不再
 * 符合合同；前七步及其可观察结果仍必须逐字不变。
 *
 * ── #99/#100 schema 默认字段（2026-10-19，#103 同步集成 tip）──────────
 * 父 tip f31f57b 在隔离 checkout 上同样失败；逐字段核对后仅新增 7 个默认值：
 * 三条事件 revision=1，一条别名 version=1 及三个 original* 字段为 null。
 * 既有 outcome、行计数、所有原值和 JSON 摘要逐字未变；不将 #103 回执表加入旧快照。
 * 最终合入 #102 后，仅给原差异行追加 8 个 nullable 生命周期字段（均 null）。
 * 集成字段级证明：/tmp/ningbo-spec98/merge-101-104/golden-delta-proof-102.json。
 * 未创建生命周期决定，原字段、结果、行数及摘要不变。
 *
 * ── PR126 修复的可选资格字段（2026-10-20）────────────────────────────
 * 0026 仅为原差异行追加 currentQualification:null；所有原字段、结果、行数及摘要不变。
 * 明确迁入资格的非空字段由 current-export-pr126-fixes-http.test.ts 通过公开API验证。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { useDb } from '../db'
import {
  commitRosterImport,
  preflightRosterImport,
} from '../server/utils/roster-import'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { createSemanticRecorder } from './helpers/roster-import-semantics'

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/roster-import-semantics.golden.json')
const WRITE_GOLDEN = process.env.RL18_WRITE_GOLDEN === '1'

const dirs: string[] = []

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-sem-'))
  dirs.push(dir)
  return useDb({ dbPath: join(dir, 'roster.db') })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** 一批写完「公布文件 + 查询/关系 + 别名/差异 + 归并」——形状照抄 RL-11 的验收用例。 */
function combinedBatch(idempotencyKey: string): RosterImportRequest {
  return {
    idempotencyKey,
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2026/1/一批到底.pdf',
    payload: {
      platformQueries: [
        {
          interface: 'business_list',
          queryKey: '91330211255994457P',
          rdjb: '3',
          queriedAt: '2026-10-16T03:00:00.000Z',
          status: 'success',
          rawResponse: '<table><tr><td>宁波上航测绘</td></tr></table>',
          relations: [
            { sequenceNo: 1, relationKey: 'SQ-1', usccRaw: '91330211255994457P', nameRaw: '宁波上航测绘股份有限公司', matchBasis: 'uscc', verificationStatus: 'confirmed' },
            { sequenceNo: 2, relationKey: 'SQ-2', usccRaw: '91330211255994457P', nameRaw: '宁波上航测绘有限公司', matchBasis: 'alias', verificationStatus: 'confirmed' },
          ],
        },
        { interface: 'apply_list', queryKey: '91330211255994457P', queriedAt: '2026-10-16T03:01:00.000Z', status: 'no_record' },
      ],
      announcement: {
        sourceDocument: { source: 'jxj', title: '一批到底', docNumber: '甬经信中小〔2026〕1号' },
        records: [
          {
            enterprise: { name: '宁波上航测绘股份有限公司', uscc: '91330211255994457P' },
            titleCode: 'specialized_sme',
            events: [
              {
                eventType: 'award',
                year: 2022,
                batchSeq: 2,
                evidence: [{ sourceFile: 'jxj/announcement/2022/145号.pdf', attachment: '附件1', listNo: 74, page: 74 }],
              },
              { eventType: 'review', year: 2022, decidedYear: 2025, reviewOutcome: 'passed' },
            ],
          },
          // 无统代主体，待本批归并。
          { enterprise: { name: '宁波上航测绘有限公司' }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2021, batchSeq: 1 }] },
        ],
      },
      aliases: [
        {
          uscc: '91330211255994457P',
          name: '宁波上航测绘有限公司',
          sourceKind: 'platform_business',
          verificationStatus: 'confirmed',
          sourceRelationRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3', queriedAt: '2026-10-16T03:00:00.000Z', sequenceNo: 2 },
        },
      ],
      differences: [
        {
          uscc: '91330211255994457P',
          titleCode: 'specialized_sme',
          direction: 'missing_in_miit',
          status: 'confirmed_reason',
          reasonCode: 'platform_stale',
          measureCode: 'mark_platform_snapshot',
          verificationStatus: 'confirmed',
          recordedAt: '2026-10-16T04:00:00.000Z',
          evidenceQueryRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3' },
          evidenceRelationRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3', sequenceNo: 1 },
        },
      ],
      merges: [
        {
          fromEnterpriseName: '宁波上航测绘有限公司',
          intoUscc: '91330211255994457P',
          aliasName: '宁波上航测绘有限公司',
          sourceKind: 'platform_business',
          sourceRelationRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3', sequenceNo: 2 },
          evidenceQueryRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3' },
        },
      ],
    },
  }
}

/** 导出快照批次（版本替换路径：先 v1，再用**另一个 sha** 出 v2）。 */
function snapshotBatch(key: string, sha: string, year: number): RosterImportRequest {
  return {
    idempotencyKey: key,
    sourceKind: 'platform_export',
    sourceIdentity: 'miit/export/专精特新中小企业导出Excel.xlsx',
    payload: {
      exportSnapshot: {
        titleCode: 'specialized_sme',
        year,
        collectedOn: '2026-10-16',
        originalFilename: '专精特新中小企业导出Excel.xlsx',
        sha256: sha,
        rows: [
          { sourceRowNo: 3, nameRaw: '甲企业', usccRaw: null, rawFields: { '1': '甲企业' } },
          { sourceRowNo: 4, nameRaw: '乙企业', usccRaw: '91330211255994457P', rawFields: { '1': '乙企业' } },
        ].map((row) => ({ ...row })),
      },
    },
  }
}

/**
 * **同名多主体**批次 —— 验证 `findEnterpriseByNorm` / `findEnterprisesByNorm` 不会让
 * name-only 项按 `enterprise_name_norm_idx` 中的首行猜配（该索引**不唯一**）。
 *
 * 三条记录用**逐字相同**的名字：
 *  1. 带统代 A ⇒ 新建企业 A；
 *  2. 带统代 B ⇒ 新建企业 B（与 A **同名不同统代**，正是本模型要如实保留的同名多主体），
 *     并按 `findEnterprisesByNorm` 报出一条指向 A 的重名候选；
 *  3. **不带统代** ⇒ 两个不同 USCC 候选同名，必须报 `enterprise_ambiguous`。
 *
 * 黄金把第 3 条的结构化错误及整批无写入作为可观察契约，防止按数据库行序猜配。
 */
function duplicateNameBatch(idempotencyKey: string): RosterImportRequest {
  const sameName = '宁波甲乙丙丁有限公司'
  return {
    idempotencyKey,
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2026/2/同名多主体.pdf',
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '同名多主体', docNumber: '甬经信中小〔2026〕99号' },
        records: [
          { enterprise: { name: sameName, uscc: '91330200000000001H' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 1 }] },
          { enterprise: { name: sameName, uscc: '91330200000000002L' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 1 }] },
          // ★ 不带统代，面对两个不同 USCC 候选时不得按名称猜配。
          { enterprise: { name: sameName }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 1 }] },
        ],
      },
    },
  }
}

/** 逐项报错的批次：`sourceRowNo` 重复 ⇒ 整批 failed，业务数据一行不落。 */
function brokenBatch(key: string): RosterImportRequest {
  const base = snapshotBatch(key, '3'.repeat(64), 2026)
  return {
    ...base,
    payload: {
      exportSnapshot: {
        ...base.payload.exportSnapshot!,
        rows: [
          { sourceRowNo: 3, nameRaw: '甲' },
          { sourceRowNo: 3, nameRaw: '乙' },
        ],
      },
    },
  }
}

describe('RL-18 写入语义快照：与集成 tip 的行为逐字一致', () => {
  it('整条序列的全部可观察写入结果与黄金文件逐字相同', () => {
    const db = makeDb()
    const recorder = createSemanticRecorder(db)

    /** 跑一步、记一步快照。`outcome` 只留稳定字段（挂钟时间列已由记录器丢掉）。 */
    const step = (label: string, run: () => unknown) => {
      recorder.capture(label, run())
    }

    step('preflight: 公布文件批次（只算影响，不写业务数据）', () =>
      preflightRosterImport(db, combinedBatch('sem/announce#sha256:a1')),
    )
    step('commit: 同一批（预检 → 提交不漂）', () =>
      commitRosterImport(db, combinedBatch('sem/announce#sha256:a1')),
    )
    step('commit: 同内容换幂等键重放（每个计划项都命中既有行）', () =>
      commitRosterImport(db, { ...combinedBatch('sem/announce#sha256:a1'), idempotencyKey: 'sem/announce-replay#sha256:a1' }),
    )
    step('commit: 导出快照 v1', () => commitRosterImport(db, snapshotBatch('sem/exp-v1#sha256:b1', '1'.repeat(64), 2025)))
    step('commit: 导出快照 v2（另一个 sha ⇒ 版本替换，两版并存）', () =>
      commitRosterImport(db, snapshotBatch('sem/exp-v2#sha256:b2', '2'.repeat(64), 2026)),
    )
    step('commit: 逐项错误的批次（整批 failed，业务数据一行不落）', () =>
      commitRosterImport(db, brokenBatch('sem/broken#sha256:c1')),
    )
    step('commit: 修好后以同一幂等键重试（本批转为 committed）', () =>
      commitRosterImport(db, snapshotBatch('sem/broken#sha256:c1', '3'.repeat(64), 2026)),
    )
    step('commit: 同名多 USCC 候选含 name-only（失败关闭）', () =>
      commitRosterImport(db, duplicateNameBatch('sem/duplicate-name#sha256:d1')),
    )

    const actual = JSON.stringify(recorder.steps, null, 2)

    if (WRITE_GOLDEN) {
      writeFileSync(GOLDEN_PATH, `${actual}\n`, 'utf8')
    }
    const golden = readFileSync(GOLDEN_PATH, 'utf8')

    // 逐字比对：差一个字节就红（`expect` 的 diff 会指出第几行）。
    expect(actual).toBe(golden.trimEnd())
  })
})
