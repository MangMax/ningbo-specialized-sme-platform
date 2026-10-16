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

    const actual = JSON.stringify(recorder.steps, null, 2)

    if (WRITE_GOLDEN) {
      writeFileSync(GOLDEN_PATH, `${actual}\n`, 'utf8')
    }
    const golden = readFileSync(GOLDEN_PATH, 'utf8')

    // 逐字比对：差一个字节就红（`expect` 的 diff 会指出第几行）。
    expect(actual).toBe(golden.trimEnd())
  })
})
