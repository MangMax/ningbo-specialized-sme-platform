import { createClassifiedFile } from '../../../server/utils/roster-file-classification'
import {differencePublicColumns} from '../../../lib/platform/difference-reference-target'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { nativeQueryRows, nativeRelationRows } from '../../platform/fixtures/native-evidence'
import { initializeDb } from '../../../db/client'
/** Import core and real HTTP contracts. Worker isolation is tested separately. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema } from '../../../db'
import { normalizeName } from '../../../lib/domain'
import { getRosterEnterpriseDetail } from '../../../lib/roster/enterprise-roster'
import {
  RosterImportApiError,
  createRosterImportClient,
  type RosterImportRequest,
} from '../../../lib/roster-import-client'
import {
  commitRosterImport,
  enterpriseExists,
  preflightRosterImport,
  readImportBatchOutcome,
  readMergeLineage,
  rosterRowCounts,
  searchEnterpriseIdsByName,
  validateImportRequest,
} from '../../../server/utils/roster-import'
import { MCP_WRITE_TOOLS } from '../../../server/utils/mcp-auth'
import { listDifferences, listEnterprises } from '../../../server/utils/mcp-roster'
import { startRosterApi as startWorkerRosterApi, executeNativeImport } from './fixtures/import-server'
const startRosterApi: typeof startWorkerRosterApi = options => startWorkerRosterApi({ ...options, executeImport: options.executeImport ?? executeNativeImport })
import { minimalPdf } from '../../support/minimal-pdf'

const TOKEN = 'test-api-token-value'
const SAME_SOURCE_SHA = 'a'.repeat(64)
const dirs: string[] = []

/** 每个用例一个**全新临时库**（互不干扰；`useDb` 按路径缓存）。 */
function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-'))
  dirs.push(dir)
  return initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 一份「公布文件」批次的载荷：一个企业 × 一个称号 × 一条复核事件 + 一条出处。 */
function announcementRequest(over: Partial<RosterImportRequest> = {}): RosterImportRequest {
  return {
    idempotencyKey: over.idempotencyKey ?? 'jxj/省专/2024/192号#sha256:abc',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2024/2/甬经信中小〔2024〕192号.pdf',
    sourceSha256: 'abc',
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '关于公布专精特新中小企业名单的通知', docNumber: '甬经信中小〔2024〕192号' },
        records: [
          {
            enterprise: { name: '宁波上航测绘股份有限公司', uscc: '91330211255994457P' },
            titleCode: 'specialized_sme',
            events: [
              {
                eventType: 'review',
                year: 2021,
                batchSeq: 2,
                decidedYear: 2024,
                reviewOutcome: 'failed',
                evidence: [
                  { sourceFile: 'jxj/announcement/2024/2/甬经信中小〔2024〕192号.pdf', attachment: '附件2', listNo: 3, page: 7 },
                ],
              },
            ],
          },
        ],
      },
    },
    ...over,
  }
}

function evidencePlanRequest(
  idempotencyKey: string,
  sourceFile: string,
  source: 'jxj' | 'miit' = 'jxj',
): RosterImportRequest {
  return {
    idempotencyKey,
    sourceKind: 'announcement',
    sourceIdentity: sourceFile,
    sourceSha256: SAME_SOURCE_SHA,
    payload: {
      announcement: {
        sourceDocument: { source, title: '合成计划测试公告' },
        records: [
          {
            enterprise: { name: '合成计划企业有限公司', uscc: '91330211255994457P' },
            titleCode: 'specialized_sme',
            events: [
              {
                eventType: 'award',
                year: 2026,
                batchSeq: 1,
                evidence: [{ sourceFile, attachment: '附件1', listNo: 1, page: 7 }],
              },
            ],
          },
        ],
      },
    },
  }
}

function seedEnterprise(
  db: ReturnType<typeof makeDb>,
  input: { name: string; uscc?: string | null; district?: string | null },
) {
  return db
    .insert(schema.enterprise)
    .values({
      name: input.name,
      nameNorm: normalizeName(input.name),
      usccNorm: input.uscc ?? null,
      district: input.district ?? null,
      qualityFlags: input.uscc ? [] : ['uscc_missing'],
    })
    .returning({ id: schema.enterprise.id })
    .get().id
}

function seedRecord(
  db: ReturnType<typeof makeDb>,
  enterpriseId: number,
  titleCode: string,
  source: 'jxj' | 'miit',
) {
  return db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source })
    .returning({ id: schema.record.id })
    .get().id
}

function seedEvent(
  db: ReturnType<typeof makeDb>,
  recordId: number,
  eventType: 'award' | 'review' | 'maintain' | 'nurture',
  year: number,
  batchSeq?: number,
) {
  return db
    .insert(schema.recordEvent)
    .values({ recordId, eventType, year, batchSeq, sortKey: year })
    .returning({ id: schema.recordEvent.id })
    .get().id
}

/** 合成文件身份的服务端 SHA 证据；文件内容不落入仓库或真实文件库。 */
function seedStoredFileHash(db: ReturnType<typeof makeDb>, relPath: string, sha256: string) {
  const filename = relPath.split('/').at(-1) ?? relPath
  const ext = filename.includes('.') ? filename.split('.').at(-1)!.toLowerCase() : ''
  createClassifiedFile(db, { relPath, filename, ext, bytes: 1, sha256 }, { categoryState: 'unset' })
}

async function withRosterHttp<T>(
  db: ReturnType<typeof makeDb>,
  run: (client: ReturnType<typeof createRosterImportClient>) => Promise<T>,
): Promise<T> {
  const server = await startRosterApi({ db, apiToken: TOKEN })
  try {
    return await run(createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN }))
  } finally {
    await server.close()
  }
}

function boundaryRequest(
  idempotencyKey: string,
  payload: RosterImportRequest['payload'],
): RosterImportRequest {
  return {
    idempotencyKey,
    sourceKind: 'alias_evidence',
    sourceIdentity: 'tests/roster-write-boundaries',
    payload,
  }
}

function seedPlatformRelation(
  db: ReturnType<typeof makeDb>,
  input: {
    queryKey: string
    usccRaw: string
    nameRaw: string
    queriedAt?: string
    interface?: 'business_list' | 'apply_list'
    rdjb?: string
    enterpriseId?: number | null
  },
) {
  const seeded = submitNativePlatformQuery(db, {
    interface: input.interface ?? 'business_list', queryKey: input.queryKey,
    rdjb: input.rdjb ?? '3', queriedAt: input.queriedAt ?? '2026-10-17T01:00:00.000Z',
    status: 'success', rawResponse: 'Explicit synthetic platform source',
    relations: [{ sequenceNo: 1, relationKey: `SQ-${input.queryKey}`,
      enterpriseId: input.enterpriseId ?? null, usccRaw: input.usccRaw,
      nameRaw: input.nameRaw, matchBasis: 'uscc', verificationStatus: 'confirmed' }],
  })
  return seeded.relationIds[0]!

}

// ---------------------------------------------------------------------------
// 1. 请求校验 + 预检不写业务数据
// ---------------------------------------------------------------------------

describe('请求校验', () => {
  it('缺幂等键 / 来源类别 / 来源身份 / payload 分别报错', () => {
    const base = { idempotencyKey: 'k', sourceKind: 'announcement', sourceIdentity: 'p', payload: {} }
    expect(validateImportRequest(null).ok).toBe(false)
    expect(validateImportRequest({ ...base, idempotencyKey: '' })).toMatchObject({ ok: false, status: 400 })
    expect(validateImportRequest({ ...base, sourceKind: 'nope' }).ok).toBe(false)
    expect(validateImportRequest({ ...base, sourceIdentity: '  ' }).ok).toBe(false)
    expect(validateImportRequest({ ...base, payload: undefined }).ok).toBe(false)
    expect(validateImportRequest(base).ok).toBe(true)
  })
})

describe('预检：只算影响，不写业务数据', () => {
  it('落一条 status=preflight 的批次，行数一行不变', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)
    const result = preflightRosterImport(db, announcementRequest())

    expect(result.status).toBe('preflight')
    expect(result.preflight.add).toBeGreaterThan(0)
    // 业务数据一行未写。
    expect(rosterRowCounts(db)).toEqual(before)
    // 批次行落了，且状态是 preflight。
    const batch = db.select().from(schema.importBatch).all().find((b) => b.id === result.batchId)!
    expect(batch.status).toBe('preflight')
    expect(batch.preflightResult).toMatchObject({ add: result.preflight.add })
  })

  it('同一幂等键重复预检：同一批次，不新增批次行', () => {
    const db = makeDb()
    const a = preflightRosterImport(db, announcementRequest())
    const b = preflightRosterImport(db, announcementRequest())
    expect(b.batchId).toBe(a.batchId)
    expect(db.select().from(schema.importBatch).all()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 2. 提交：覆盖七张新表 + 完整性
// ---------------------------------------------------------------------------

describe('提交：一次写入企业/事件/出处/别名/平台证据/快照/差异', () => {
  const request: RosterImportRequest = {
    idempotencyKey: 'all-in-one#sha256:def',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2026/1/全量.pdf',
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '全量表', docNumber: '甬经信中小〔2026〕1号' },
        records: [
          {
            enterprise: { name: '甲企业有限公司', uscc: '913302017133602847' },
            titleCode: 'specialized_sme',
            events: [
              {
                eventType: 'award',
                year: 2021,
                batchSeq: 1,
                evidence: [{ sourceFile: 'jxj/announcement/2021/1/145号.pdf', attachment: '附件', listNo: 74, page: 74 }],
              },
              { eventType: 'review', year: 2021, batchSeq: 2, decidedYear: 2024, reviewOutcome: 'failed' },
            ],
          },
          // ★ 未匹配任何平台导出的公布名单条目 —— 仍必须入库（完整性）。
          { enterprise: { name: '仅公布未匹配企业' }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 1 }] },
        ],
      },
      aliases: [
        {
          enterpriseName: '甲企业有限公司',
          name: '甲企业旧名有限公司',
          sourceKind: 'platform_business',
          sourceRelationRef: {
            interface: 'business_list',
            queryKey: '913302017133602847',
            rdjb: '3',
            queriedAt: '2026-10-16T03:00:00.000Z',
            sequenceNo: 2,
          },
          verificationStatus: 'confirmed',
        },
        { enterpriseName: '甲企业有限公司', name: '疑似同名待核有限公司', sourceKind: 'platform_apply', verificationStatus: 'pending' },
      ],
      platformQueries: [
        { rawResponse: 'Explicit synthetic original response',
          interface: 'business_list',
          queryKey: '913302017133602847',
          rdjb: '3',
          queriedAt: '2026-10-16T03:00:00.000Z',
          status: 'success',
          relations: [
            { sequenceNo: 1, relationKey: 'SQ1', usccRaw: '913302017133602847', nameRaw: '甲企业有限公司', matchBasis: 'uscc', verificationStatus: 'confirmed' },
            { sequenceNo: 2, relationKey: 'SQ2', usccRaw: '913302017133602847', nameRaw: '甲企业旧名有限公司', aliasNameRaw: '甲企业旧名有限公司', matchBasis: 'alias', verificationStatus: 'confirmed' },
            // 未知 sblx 取值：原样入库 + 标待核（不因未知取值崩溃）。
            { sequenceNo: 3, relationKey: 'SQ3', usccRaw: '913302017133602847', nameRaw: '甲企业有限公司', declareKind: '复核确认' },
          ],
        },
        { rawResponse: 'Explicit synthetic original response', interface: 'business_list', queryKey: '913302017133602847', rdjb: '1', queriedAt: '2026-10-16T03:01:00.000Z', status: 'no_record' },
      ],
      exportSnapshot: {
        titleCode: 'specialized_sme',
        year: 2026,
        collectedOn: '2026-10-16',
        originalFilename: '专精特新中小企业导出Excel.xlsx',
        sha256: 'f'.repeat(64),
        rows: [
          { sourceRowNo: 1, usccRaw: '913302017133602847', nameRaw: '甲企业有限公司' },
          { sourceRowNo: 2, usccRaw: '91330211000000000X', nameRaw: '平台有的企业' },
        ],
      },
      differences: [
        {
          enterpriseName: '甲企业有限公司',
          titleCode: 'specialized_sme',
          direction: 'missing_in_miit',
          status: 'confirmed_reason',
          reasonCode: 'moved_out',
          measureCode: 'mark_moved_out',
          verificationStatus: 'confirmed',
          recordedAt: '2026-10-16T04:00:00.000Z',
        },
      ],
    },
  }

  it('整批 committed，七张表都落到，且逐项结果带真实 id', () => {
    const db = makeDb()
    const result = commitRosterImport(db, request)

    expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(result.error).toBeNull()
    expect(result.summary.written).toBeGreaterThan(0)
    expect(result.summary.failed).toBe(0)

    const counts = rosterRowCounts(db)
    expect(counts.source_document).toBe(1)
    expect(counts.enterprise).toBe(2) // 甲企业 + 仅公布未匹配企业
    expect(counts.record).toBe(2) // 两条 record（未匹配平台导出的那条**也在**）
    expect(counts.record_event).toBe(3) // award + review + 仅公布那条的 award
    expect(counts.record_evidence).toBe(1) // 附件 序号74 第74页
    expect(counts.enterprise_alias).toBe(2)
    expect(counts.platform_query).toBe(2)
    expect(counts.platform_relation).toBe(3) // 三条关联逐条保留，不按企业去重
    expect(counts.platform_export_batch).toBe(1)
    expect(counts.platform_export_row).toBe(2)
    expect(counts.difference_reason).toBe(1)

    // 完整性：未匹配平台导出的公布条目入库（不是被导出对照过滤掉）。
    const unmatched = db.select().from(schema.enterprise).all().find((e) => e.name === '仅公布未匹配企业')!
    expect(db.select().from(schema.record).all().filter((r) => r.enterpriseId === unmatched.id)).toHaveLength(1)

    // 出处保留页码（RL-10 的跳转依据）。
    expect(db.select().from(schema.recordEvidence).all()[0]!.page).toBe(74)

    // 未知 sblx 取值：原样入库 + 标待核。
    const unknown = nativeRelationRows(db).find((r) => r.relationKey === 'SQ3')!
    expect(unknown.declareKind).toBe('复核确认')
    expect(unknown.verificationStatus).toBe('pending')
    // 四态可区分：rdjb=1 那次是 no_record，不是 failed。
    const empty = nativeQueryRows(db).find((q) => q.rdjb === '1')!
    expect(empty.status).toBe('no_record')

    // 错误 → `failed` 的区分在别的用例里（本批没有不合法项）。
    expect(result.items.every((item) => item.ok)).toBe(true)
    expect(result.items.some((item) => item.kind === 'record_event' && item.ref.startsWith('record:'))).toBe(true)
  })

  it('往返一致性：用 import_batch.item_results / summary 查回写入结果', () => {
    const db = makeDb()
    commitRosterImport(db, request)
    const outcome = readImportBatchOutcome(db, request.idempotencyKey)!
    expect(outcome.status).toBe('committed')
    expect(outcome.summary!.written).toBeGreaterThan(0)
    expect(outcome.items!.some((i) => i.kind === 'platform_relation' || i.kind === 'alias')).toBe(true)
    expect(outcome.preflight!.add).toBeGreaterThan(0)
  })

  it('★ 幂等重放：同一键再提交，不再写企业/事件，返回既有摘要', () => {
    const db = makeDb()
    const first = commitRosterImport(db, request)
    const afterFirst = rosterRowCounts(db)

    const replay = commitRosterImport(db, request)
    expect(replay.batchId).toBe(first.batchId)
    expect(replay.status).toBe('committed')
    expect(replay.summary).toEqual(first.summary)
    // 一行都没多出来。
    expect(rosterRowCounts(db)).toEqual(afterFirst)
    expect(db.select().from(schema.importBatch).all()).toHaveLength(1)
  })

  it('★ 同内容换幂等键重放：`written` 反映**真实新增行数**(0)，不是「计划项数」', () => {
    const db = makeDb()
    const first = commitRosterImport(db, request)
    // 首跑确实写了东西（否则这条用例证明不了什么）。
    expect(first.summary.written).toBeGreaterThan(0)
    const afterFirst = rosterRowCounts(db)

    // 换一个幂等键 ⇒ 走的是**真正执行**的那条路（不是命中 `committed` 批次直接返回既有摘要），
    // 内容一模一样 ⇒ 每个计划项都只命中既有行，**一行都没写**。
    // RL-11 验收：「应用后可查询**已写入数量**」——此刻真实新增就是 0。
    const replay = commitRosterImport(db, { ...request, idempotencyKey: 'replay/same-content#sha256:abc' })
    expect(replay.batchId).not.toBe(first.batchId)
    expect(replay.status).toBe('committed')
    expect(replay.error).toBeNull()
    expect(replay.summary.written).toBe(0)
    // 业务数据与行数一行都没动。
    expect(rosterRowCounts(db)).toEqual(afterFirst)
    // 逐项明细同样如实：快照项不再把「批次里已有的行」算成本次新增。
    const snapshotItem = replay.items.find((i) => i.kind === 'export_batch')!
    expect(snapshotItem.detail!.rows).toEqual([])
    expect(snapshotItem.detail!.rowsWritten).toBe(0)
  })
})

describe('出处重放记账不进入调用方逐项结果', () => {
  it('空事件经真实 HTTP 返回结构化错误且不写业务行', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const malformed = announcementRequest({ idempotencyKey: 'synthetic/null-event#sha256:stable' })
    malformed.payload.announcement!.records[0]!.events = [null as never]
    const before = rosterRowCounts(db)

    try {
      const result = await client.commit(malformed)

      expect(result.status).toBe('failed')
      expect(result.items).toContainEqual(
        expect.objectContaining({
          kind: 'record_event',
          ok: false,
          error: expect.objectContaining({ code: 'event_type_unknown' }),
        }),
      )
      expect(rosterRowCounts(db)).toEqual(before)
      expect(db.select().from(schema.enterprise).all()).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('已有匹配记录时空事件仍经真实 HTTP 返回结构化错误且批次失败', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const enterpriseId = seedEnterprise(db, {
      name: '合成计划企业有限公司',
      uscc: '91330211255994457P',
    })
    const recordId = seedRecord(db, enterpriseId, 'specialized_sme', 'jxj')
    seedEvent(db, recordId, 'award', 2026, 1)
    const before = rosterRowCounts(db)
    const malformed = evidencePlanRequest('synthetic/null-event-existing#sha256:stable', 'synthetic/new.pdf')
    malformed.payload.announcement!.records[0]!.events = [null as never]

    try {
      const result = await client.commit(malformed)

      expect(result.status).toBe('failed')
      expect(result.items).toContainEqual(
        expect.objectContaining({
          kind: 'record_event',
          ok: false,
          error: expect.objectContaining({ code: 'event_type_unknown' }),
        }),
      )
      expect(db.select().from(schema.importBatch).all().find((batch) => batch.id === result.batchId)?.status).toBe('failed')
      expect(rosterRowCounts(db)).toEqual(before)
      expect(db.select().from(schema.recordEvidence).all()).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('已有匹配事件遇到 evidence:[null] 时返回结构化出处错误且不写入', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const enterpriseId = seedEnterprise(db, { name: '合成空出处企业有限公司', uscc: '91330211255994457P' })
    const recordId = seedRecord(db, enterpriseId, 'specialized_sme', 'jxj')
    seedEvent(db, recordId, 'award', 2026, 1)
    const before = rosterRowCounts(db)
    const malformed = evidencePlanRequest('synthetic/null-evidence-existing#sha256:stable', 'synthetic/new.pdf')
    malformed.payload.announcement!.records[0]!.events![0]!.evidence = [null as never]

    try {
      const result = await client.commit(malformed)
      expect(result.status).toBe('failed')
      expect(result.items).toContainEqual(
        expect.objectContaining({
          kind: 'record_evidence',
          ok: false,
          error: expect.objectContaining({ code: 'source_file_required', field: 'evidence.sourceFile' }),
        }),
      )
      expect(db.select().from(schema.importBatch).all().find((batch) => batch.id === result.batchId)?.status).toBe('failed')
      expect(rosterRowCounts(db)).toEqual(before)
      expect(db.select().from(schema.recordEvidence).all()).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('同批重复新事件合并遇到 evidence:[null] 时保留结构化出处错误且不写入', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const enterpriseId = seedEnterprise(db, { name: '合成重复新事件空出处企业', uscc: '91330211255994457P' })
    seedRecord(db, enterpriseId, 'specialized_sme', 'jxj')
    const before = rosterRowCounts(db)
    const malformed = evidencePlanRequest('synthetic/null-evidence-duplicate-new#sha256:stable', 'synthetic/new.pdf')
    malformed.payload.announcement!.records[0]!.events = [
      { eventType: 'award', year: 2026, batchSeq: 1, evidence: [null as never] },
      { eventType: 'award', year: 2026, batchSeq: 1, evidence: [{ sourceFile: 'synthetic/valid.pdf', attachment: '附件2', listNo: 2, page: 8 }] },
    ]

    try {
      const result = await client.commit(malformed)
      expect(result.status).toBe('failed')
      expect(result.items).toContainEqual(
        expect.objectContaining({
          kind: 'record_evidence',
          ok: false,
          error: expect.objectContaining({ code: 'source_file_required', field: 'evidence.sourceFile' }),
        }),
      )
      expect(db.select().from(schema.importBatch).all().find((batch) => batch.id === result.batchId)?.status).toBe('failed')
      expect(rosterRowCounts(db)).toEqual(before)
      expect(db.select().from(schema.recordEvent).all()).toHaveLength(0)
      expect(db.select().from(schema.recordEvidence).all()).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('commit、重试、replay 与批次读回隐藏内部目标快照，同时保留可重放记账', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const expectPublicItems = (items: Array<{ detail?: Record<string, unknown> }>) => {
      for (const item of items) {
        expect(item.detail).not.toHaveProperty('evidenceRepointTargets')
        expect(item.detail).not.toHaveProperty('evidenceRepointPlanFingerprint')
      }
    }

    try {
      const base = evidencePlanRequest('synthetic/evidence-plan-base', 'jxj/announcement/2026/计划-A.pdf')
      const first = await client.commit(base)
      expect(first.status).toBe('committed')
      expectPublicItems(first.items)

      const repoint = evidencePlanRequest('synthetic/evidence-plan-repoint', 'jxj/announcement/2026/计划-B.pdf')
      const committed = await client.commit(repoint)
      expect(committed.status).toBe('committed')
      expect(committed.summary.evidenceRepointed).toBe(1)
      expect(committed.items.reduce((n, item) => n + Number(item.detail?.evidenceRepointed ?? 0), 0)).toBe(1)
      expectPublicItems(committed.items)

      const committedLedger = db.select().from(schema.importBatch).all().find((batch) => batch.idempotencyKey === repoint.idempotencyKey)!
      const storedCommitItems = committedLedger.itemResults as Array<{ detail?: Record<string, unknown> }>
      expect(storedCommitItems[0]?.detail?.evidenceRepointTargets).toHaveLength(1)
      expect(storedCommitItems[0]?.detail?.evidenceRepointPlanFingerprint).toMatch(/^[0-9a-f]{64}$/)

      // 幂等读回和 outcome 查询都投影成同一份调用方结果。
      const retried = await client.commit(repoint)
      expectPublicItems(retried.items)
      expectPublicItems(readImportBatchOutcome(db, repoint.idempotencyKey)!.items!)

      // 同一批次的显式 replay 仍能按载荷计划更新出处，但响应不泄漏计划快照。
      const replayRequest = evidencePlanRequest(repoint.idempotencyKey, 'jxj/announcement/2026/计划-C.pdf')
      const replay = await client.replay(replayRequest)
      expect(replay.status).toBe('replayed')
      expect(replay.evidenceRepointed).toBe(1)
      expectPublicItems(replay.items)
      expect(db.select().from(schema.recordEvidence).all().map((row) => ({ sourceFile: row.sourceFile, page: row.page }))).toEqual([
        { sourceFile: 'jxj/announcement/2026/计划-C.pdf', page: 7 },
      ])

      const replayLedger = db.select().from(schema.importBatch).all().find((batch) => batch.idempotencyKey === `${repoint.idempotencyKey}#repoint`)!
      const storedReplayItems = replayLedger.itemResults as Array<{ detail?: Record<string, unknown> }>
      expect(storedReplayItems[0]?.detail?.evidenceRepointTargets).toHaveLength(1)
      expectPublicItems(readImportBatchOutcome(db, `${repoint.idempotencyKey}#repoint`)!.items!)
    } finally {
      await server.close()
    }
  })

  it('replay 指纹包含公告默认来源，来源改变时重新解析目标记录', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const jxjBase = evidencePlanRequest('synthetic/default-source-jxj', 'synthetic/default-source-A.pdf')
    const miitBase = evidencePlanRequest('synthetic/default-source-miit', 'synthetic/default-source-A.pdf', 'miit')
    const target = evidencePlanRequest(
      'synthetic/default-source-repoint#sha256:stable',
      'synthetic/default-source-B.pdf',
    )

    try {
      expect((await client.commit(jxjBase)).status).toBe('committed')
      expect((await client.commit(miitBase)).status).toBe('committed')
      const committed = await client.commit(target)
      expect(committed.summary.evidenceRepointed).toBe(1)

      const changedDefault = evidencePlanRequest(target.idempotencyKey, 'synthetic/default-source-B.pdf', 'miit')
      const replayed = await client.replay(changedDefault)

      expect(replayed.status).toBe('replayed')
      expect(replayed.evidenceRepointed).toBe(1)
      const enterprise = db.select().from(schema.enterprise).all().find((row) => row.name === '合成计划企业有限公司')!
      const evidenceBySource = Object.fromEntries(
        db
          .select()
          .from(schema.record)
          .all()
          .filter((record) => record.enterpriseId === enterprise.id)
          .map((record) => {
            const event = db.select().from(schema.recordEvent).all().find((row) => row.recordId === record.id)!
            const evidence = db.select().from(schema.recordEvidence).all().find((row) => row.recordEventId === event.id)!
            return [record.source, { sourceFile: evidence.sourceFile, page: evidence.page }]
          }),
      )
      expect(evidenceBySource).toEqual({
        jxj: { sourceFile: 'synthetic/default-source-B.pdf', page: 7 },
        miit: { sourceFile: 'synthetic/default-source-B.pdf', page: 7 },
      })
    } finally {
      await server.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 逐项错误 + 单批事务（绝不部分提交）
// ---------------------------------------------------------------------------

describe('逐项错误与单批事务', () => {
  const brokenRequest: RosterImportRequest = {
    idempotencyKey: 'broken#sha256:xyz',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2026/1/坏行.pdf',
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '坏行表' },
        records: [
          { enterprise: { name: '好企业', uscc: '91330211000000012K' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026 }] },
          // ★ 称号不在字典内 —— 逐项报错，不静默丢行；整批不落库。
          { enterprise: { name: '坏企业' }, titleCode: 'not_a_title', events: [{ eventType: 'award', year: 2026 }] },
        ],
      },
      differences: [
        // ★ `recordedAt` 是必填（时态化排序键）—— 这里故意给空串，触发 `recorded_at_required`。
        { enterpriseName: '好企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', recordedAt: '' },
      ],
    },
  }

  it('任一项不合法 ⇒ 整批 failed，业务数据一行不落，错误逐项可读', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)
    const result = commitRosterImport(db, brokenRequest)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('未写入任何数据')
    expect(rosterRowCounts(db)).toEqual(before)

    const bad = result.items.find((i) => !i.ok)!
    expect(bad).toMatchObject({ ok: false, kind: 'record' })
    expect(bad.error!.code).toBe('title_unknown')
    expect(bad.error!.field).toBe('titleCode')
    expect(bad.error!.message).toContain('not_a_title')
    expect(result.items.some((i) => i.error?.code === 'recorded_at_required')).toBe(true)
    expect(result.summary).toMatchObject({ written: 0, failed: 2 })

    const batch = db.select().from(schema.importBatch).all().find((b) => b.id === result.batchId)!
    expect(batch.status).toBe('failed')
    expect(batch.error).toBeTruthy()
  })

  it('★ 失败恢复：修好载荷后以同一键重试，本批转为 committed', () => {
    const db = makeDb()
    const first = commitRosterImport(db, brokenRequest)
    expect(first.status).toBe('failed')

    const fixed: RosterImportRequest = {
      ...brokenRequest,
      payload: {
        announcement: {
          sourceDocument: { source: 'jxj', title: '坏行表' },
          records: [
            { enterprise: { name: '好企业', uscc: '91330211000000012K' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026 }] },
          ],
        },
        differences: [
          { enterpriseName: '好企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'no_record', recordedAt: '2026-10-16T05:00:00.000Z' },
        ],
      },
    }
    const retry = commitRosterImport(db, fixed)
    expect(retry.batchId).toBe(first.batchId)
    expect(retry.status).toBe('committed')
    expect(retry.summary.written).toBeGreaterThan(0)
    expect(rosterRowCounts(db).record).toBe(1)
    expect(rosterRowCounts(db).difference_reason).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. 归并与回填（契约 §5.2 / 父代理裁决 #4：血缘可查回）
// ---------------------------------------------------------------------------

describe('归并与回填：血缘在 item_results 中可查询', () => {
  /** 造「回归案例」的合并前状态：375（无统代）vs 7289（统代 91330211255994457P）。 */
  function seedMergeCase(db: ReturnType<typeof makeDb>) {
    const canonical = seedEnterprise(db, { name: '宁波上航测绘股份有限公司', uscc: '91330211255994457P' })
    const duplicate = seedEnterprise(db, { name: '宁波上航测绘有限公司' })
    const dupRecord = seedRecord(db, duplicate, 'specialized_sme', 'jxj')
    const dupEvent = seedEvent(db, dupRecord, 'award', 2022, 2)
    const evidenceId = db
      .insert(schema.recordEvidence)
      .values({
        recordEventId: dupEvent,
        sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf',
        attachment: '附件',
        listNo: 74,
        page: 74,
      })
      .returning({ id: schema.recordEvidence.id })
      .get().id
    seedRecord(db, canonical, 'specialized_sme', 'miit')
    seedRecord(db, canonical, 'little_giant', 'miit')
    return { canonical, duplicate, dupRecord, dupEvent, evidenceId }
  }

  const mergeRequest = (
    fromEnterpriseId: number,
    key = 'merge/375->7289#sha256:m1',
    intoUscc = '91330211255994457P',
  ): RosterImportRequest => ({
    idempotencyKey: key,
    sourceKind: 'alias_evidence',
    sourceIdentity: `miit/relations/${intoUscc}`,
    payload: {
      merges: [
        {
          fromEnterpriseId,
          intoUscc,
          aliasName: '宁波上航测绘有限公司',
          sourceKind: 'platform_business',
          sourceRefId: 6,
          evidenceQueryId: null,
          note: 'businessList rdjb=3 的 qymc 差异行',
        },
      ],
    },
  })

  it('直接 UPDATE uscc_norm 会撞唯一键 —— 所以归并走 MERGE', () => {
    const db = makeDb()
    const { duplicate } = seedMergeCase(db)
    expect(() =>
      db
        .update(schema.enterprise)
        .set({ usccNorm: '91330211255994457P' })
        .where(eq(schema.enterprise.id, duplicate))
        .run(),
    ).toThrow()
  })

  it('★ 归并后：一行收齐全部称号/事件/出处；按现名与曾用名搜索命中同一企业', () => {
    const db = makeDb()
    const { canonical, duplicate, dupRecord, dupEvent, evidenceId } = seedMergeCase(db)

    const result = commitRosterImport(db, mergeRequest(duplicate))
    expect(result.status, JSON.stringify(result)).toBe('committed')

    // 原企业保留身份归并映射；称号、事件和出处完整转入规范企业。
    expect(db.select().from(schema.enterpriseMerge).all()).toEqual(expect.arrayContaining([expect.objectContaining({fromEnterpriseId:duplicate,intoEnterpriseId:canonical})]))
    const titles = db.select().from(schema.record).all().filter((r) => r.enterpriseId === canonical).map((r) => `${r.titleCode}/${r.source}`).sort()
    expect(titles).toEqual(['little_giant/miit', 'specialized_sme/jxj', 'specialized_sme/miit'])
    const kept = db.select().from(schema.recordEvent).all().find((e) => e.id === dupEvent)!
    expect(kept.recordId).toBe(dupRecord) // 无同坐标冲突 ⇒ 记录本身改指规范行
    expect(kept.year).toBe(2022)
    expect(db.select().from(schema.recordEvidence).all().find((e) => e.id === evidenceId)!.page).toBe(74)

    // 按现名与曾用名搜索都命中同一企业；旧名不丢。
    expect(searchEnterpriseIdsByName(db, '宁波上航测绘股份有限公司')).toEqual([canonical])
    expect(searchEnterpriseIdsByName(db, '宁波上航测绘有限公司')).toEqual([canonical])
    const alias = db.select().from(schema.enterpriseAlias).all().find((a) => a.enterpriseId === canonical && a.name === '宁波上航测绘有限公司')!
    expect(alias.verificationStatus).toBe('confirmed')

    // ★ 父代理裁决 #4：血缘在 import_batch.item_results 中可查回。
    const lineage = readMergeLineage(db, mergeRequest(duplicate).idempotencyKey, duplicate)!
    expect(lineage.fromEnterpriseId).toBe(duplicate)
    expect(lineage.fromEnterpriseName).toBe('宁波上航测绘有限公司')
    expect(lineage.intoEnterpriseId).toBe(canonical)
    expect(lineage.intoUscc).toBe('91330211255994457P')
    expect(lineage.aliasId).toBe(alias.id)
    expect(lineage.recordsMoved).toContain(dupRecord)
    expect(lineage.eventsMoved).toContain(dupEvent)
    expect(lineage.evidenceMoved).toContain(evidenceId)
    expect(lineage.recordsFolded).toEqual([])

    // 同一份血缘也在提交响应的 item.detail 里（供调用方就地取）。
    const item = result.items.find((i) => i.kind === 'merge')!
    expect(item.ok).toBe(true)
    expect((item.detail!.lineage as { fromEnterpriseId: number }).fromEnterpriseId).toBe(duplicate)
  })

  it('★ 同 (企业,称号,来源) 冲突时：事件折到规范行那条记录，数量不减、一条不折叠', () => {
    const db = makeDb()
    const canonical = seedEnterprise(db, { name: '同名冲突甲', uscc: '91330206732109570E' })
    const canonicalRecord = seedRecord(db, canonical, 'innovative_sme', 'jxj')
    seedEvent(db, canonicalRecord, 'award', 2019, 2)
    const duplicate = seedEnterprise(db, { name: '同名冲突乙' })
    const dupRecord = seedRecord(db, duplicate, 'innovative_sme', 'jxj')
    const dupEvent = seedEvent(db, dupRecord, 'award', 2021, 1)

    const request = mergeRequest(duplicate, 'merge/conflict#sha256:m2', '91330206732109570E')
    const result = commitRosterImport(db, request)
    expect(result.status, JSON.stringify(result)).toBe('committed')

    const merged = db.select().from(schema.record).all().filter((r) => r.enterpriseId === canonical && r.titleCode === 'innovative_sme')
    expect(merged).toHaveLength(1)
    const events = db.select().from(schema.recordEvent).all().filter((e) => e.recordId === merged[0]!.id)
    expect(events.map((e) => e.year).sort()).toEqual([2019, 2021])

    const lineage = readMergeLineage(db, 'merge/conflict#sha256:m2', duplicate)!
    expect(lineage.recordsFolded).toEqual([{
      fromRecordId: dupRecord,
      intoRecordId: canonicalRecord,
      // seedRecord 的插入值及 schema 默认值，独立于实际 lineage。
      fromRecordSnapshot: {
        id: dupRecord,
        enterpriseId: duplicate,
        titleCode: 'innovative_sme',
        source: 'jxj',
        nameRaw: null,
        usccRaw: null,
        district: null,
        qualityFlags: [],
      },
      eventIds: [dupEvent],
    }])
    expect(lineage.eventsMoved).toHaveLength(1)

    // 同一个合成 fold 的四个公开面：旧血缘逐字段保留，仅增加私有账本引用。
    // 独立空库中此次 merge 建立第一条 alias；预期不复制实际公开/私有结果。
    const publicItems = [{
      ok: true,
      kind: 'merge',
      ref: `merge:${duplicate}->${canonical}`,
      detail: {
        rowsWritten: 1,
        lineage: {
          fromEnterpriseId: duplicate,
          fromEnterpriseName: '同名冲突乙',
          intoEnterpriseId: canonical,
          intoUscc: '91330206732109570E',
          canonicalName: '同名冲突甲',
          rename: null,
          aliasId: 1,
          evidenceQueryId: null,
          childRowsMoved: { aliases: 0, differences: 0, relations: 0, records: 1 },
          recordsMoved: [],
          recordsFolded: [{ fromRecordId: dupRecord, intoRecordId: canonicalRecord }],
          eventsMoved: [dupEvent],
          evidenceMoved: [],
          snapshotRef: { source: 'private_batch', batchId: result.batchId, itemIndex: 0 },
        },
      },
    }]
    expect(result.items, 'first commit').toEqual(publicItems)
    const beforeRetry = rosterRowCounts(db)
    const retry = commitRosterImport(db, request)
    expect(retry.status).toBe('committed')
    expect(retry.items, 'same-key retry').toEqual(publicItems)
    expect(rosterRowCounts(db)).toEqual(beforeRetry)
    const outcome = readImportBatchOutcome(db, request.idempotencyKey)!
    expect(outcome.status).toBe('committed')
    expect(outcome.items, 'outcome').toEqual(publicItems)
    const receipts = db.select().from(schema.importReceipt).where(eq(schema.importReceipt.batchId, result.batchId)).all()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.status).toBe('committed')
    expect(receipts[0]!.itemResults, 'receipt').toEqual(publicItems)
    for (const output of [result, retry, outcome, receipts[0]]) {
      expect(JSON.stringify(output)).not.toContain('fromRecordSnapshot')
      expect(JSON.stringify(output)).not.toContain('eventIds')
    }
  })

  it('目标 / 来源缺失逐项报错，且整批不落库', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)
    const result = commitRosterImport(db, mergeRequest(999999, 'merge/missing#sha256:m3'))
    expect(result.status).toBe('failed')
    expect(result.items[0]!.error!.code).toBe('merge_source_not_found')
    expect(rosterRowCounts(db)).toEqual(before)
  })
})

describe('API 写入边界：归并选择器与差异冲突', () => {
  const TARGET_USCC = '91330211255994457P'

  it('按名定位到多家企业时拒绝归并，不选择首条同名行', async () => {
    const db = makeDb()
    const duplicateName = '宁波同名归并边界企业有限公司'
    const first = seedEnterprise(db, { name: duplicateName })
    const second = seedEnterprise(db, { name: duplicateName })
    seedEnterprise(db, { name: '宁波统代规范行有限公司', uscc: TARGET_USCC })
    const before = rosterRowCounts(db)
    const request = boundaryRequest('write-boundary/merge-ambiguous', {
      merges: [{ fromEnterpriseName: duplicateName, intoUscc: TARGET_USCC, sourceKind: 'manual' }],
    })

    const result = await withRosterHttp(db, (client) => client.commit(request))

    expect(result.status).toBe('failed')
    expect(result.summary.written).toBe(0)
    expect(result.items.find((item) => item.kind === 'merge')!.error!.code).toBe('enterprise_ambiguous')
    expect(enterpriseExists(db, first)).toBe(true)
    expect(enterpriseExists(db, second)).toBe(true)
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it('归并同时给出的 ID 与名称冲突时拒绝，不按 ID 静默删除另一主体', async () => {
    const db = makeDb()
    const fromId = seedEnterprise(db, { name: '宁波归并ID主体有限公司' })
    seedEnterprise(db, { name: '宁波归并名称主体有限公司' })
    seedEnterprise(db, { name: '宁波归并规范行有限公司', uscc: TARGET_USCC })
    const before = rosterRowCounts(db)
    const request = boundaryRequest('write-boundary/merge-selector-conflict', {
      merges: [{
        fromEnterpriseId: fromId,
        fromEnterpriseName: '宁波归并名称主体有限公司',
        intoUscc: TARGET_USCC,
        sourceKind: 'manual',
      }],
    })

    const result = await withRosterHttp(db, (client) => client.commit(request))

    expect(result.status).toBe('failed')
    expect(result.items.find((item) => item.kind === 'merge')!.error!.code).toBe('enterprise_selector_conflict')
    expect(enterpriseExists(db, fromId)).toBe(true)
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it.each([
    { label: 'omitted sourceRefId', source: {}, expectedCode: 'alias_source_evidence_required' },
    { label: 'unknown sourceRefId', source: { sourceRefId: 999999 }, expectedCode: 'alias_source_evidence_mismatch' },
  ])('confirmed platform alias rejects $label', async ({ label, source, expectedCode }) => {
    const db = makeDb()
    const enterpriseId = seedEnterprise(db, { name: '宁波平台别名目标有限公司', uscc: TARGET_USCC })
    const request = boundaryRequest(`write-boundary/alias-${label}`, {
      aliases: [{
        uscc: TARGET_USCC,
        name: '宁波未经平台支持的曾用名有限公司',
        sourceKind: 'platform_business',
        verificationStatus: 'confirmed',
        ...source,
      }],
    })

    const result = await withRosterHttp(db, (client) => client.commit(request))

    expect(result.status).toBe('failed')
    expect(result.items.find((item) => item.kind === 'alias')!.error!.code).toBe(expectedCode)
    expect(db.select().from(schema.enterpriseAlias).all()).toHaveLength(0)
    expect(searchEnterpriseIdsByName(db, '宁波未经平台支持的曾用名有限公司')).toEqual([])
    expect(enterpriseExists(db, enterpriseId)).toBe(true)
  })

  it('裸关系 ID 指向其他统代时拒绝 confirmed 平台别名', async () => {
    const db = makeDb()
    const enterpriseId = seedEnterprise(db, { name: '宁波平台别名目标有限公司', uscc: TARGET_USCC })
    const relationId = seedPlatformRelation(db, {
      queryKey: '91330206793007818K',
      usccRaw: '91330206793007818K',
      nameRaw: '宁波待核旧名有限公司',
    })
    const request = boundaryRequest('write-boundary/alias-wrong-uscc-id', {
      aliases: [{
        uscc: TARGET_USCC,
        name: '宁波待核旧名有限公司',
        sourceKind: 'platform_business',
        sourceRefId: relationId,
        verificationStatus: 'confirmed',
      }],
    })

    const result = await withRosterHttp(db, (client) => client.commit(request))

    expect(result.status).toBe('failed')
    expect(result.items.find((item) => item.kind === 'alias')!.error!.code).toBe('alias_source_evidence_mismatch')
    expect(db.select().from(schema.enterpriseAlias).all()).toHaveLength(0)
    expect(enterpriseExists(db, enterpriseId)).toBe(true)
  })

  it('裸关系 ID 已归属另一企业时拒绝 confirmed 平台别名', async () => {
    const db = makeDb()
    const enterpriseId = seedEnterprise(db, { name: '宁波平台别名目标有限公司', uscc: TARGET_USCC })
    const otherEnterpriseId = seedEnterprise(db, { name: '宁波关系归属企业有限公司', uscc: '91330206793007818K' })
    const relationId = seedPlatformRelation(db, {
      queryKey: TARGET_USCC,
      usccRaw: TARGET_USCC,
      nameRaw: '宁波关系归属冲突旧名有限公司',
      enterpriseId: otherEnterpriseId,
    })
    const request = boundaryRequest('write-boundary/alias-wrong-owner-id', {
      aliases: [{
        uscc: TARGET_USCC,
        name: '宁波关系归属冲突旧名有限公司',
        sourceKind: 'platform_business',
        sourceRefId: relationId,
        verificationStatus: 'confirmed',
      }],
    })

    const result = await withRosterHttp(db, (client) => client.commit(request))

    expect(result.status).toBe('failed')
    expect(result.items.find((item) => item.kind === 'alias')!.error!.code).toBe('alias_source_evidence_mismatch')
    expect(db.select().from(schema.enterpriseAlias).all()).toHaveLength(0)
    expect(enterpriseExists(db, enterpriseId)).toBe(true)
    expect(enterpriseExists(db, otherEnterpriseId)).toBe(true)
  })

  it('批内自然键关系的 qymc 不等于别名时拒绝 confirmed 平台别名', async () => {
    const db = makeDb()
    const enterpriseId = seedEnterprise(db, { name: '宁波平台别名目标有限公司', uscc: TARGET_USCC })
    const request = boundaryRequest('write-boundary/alias-wrong-qymc-ref', {
      platformQueries: [{ rawResponse: 'Explicit synthetic original response',
        interface: 'business_list',
        queryKey: TARGET_USCC,
        rdjb: '3',
        queriedAt: '2026-10-17T02:00:00.000Z',
        status: 'success',
        relations: [{
          sequenceNo: 1,
          relationKey: 'SQ-wrong-qymc',
          usccRaw: TARGET_USCC,
          nameRaw: '宁波平台实际返回名称有限公司',
          matchBasis: 'uscc',
          verificationStatus: 'confirmed',
        }],
      }],
      aliases: [{
        uscc: TARGET_USCC,
        name: '宁波未经返回的曾用名有限公司',
        sourceKind: 'platform_business',
        verificationStatus: 'confirmed',
        sourceRelationRef: {
          interface: 'business_list',
          queryKey: TARGET_USCC,
          rdjb: '3',
          queriedAt: '2026-10-17T02:00:00.000Z',
          sequenceNo: 1,
        },
      }],
    })

    const result = await withRosterHttp(db, (client) => client.commit(request))

    expect(result.status).toBe('failed')
    expect(result.items.find((item) => item.kind === 'alias')!.error!.code).toBe('alias_source_evidence_mismatch')
    expect(nativeQueryRows(db)).toHaveLength(0)
    expect(nativeRelationRows(db)).toHaveLength(0)
    expect(db.select().from(schema.enterpriseAlias).all()).toHaveLength(0)
    expect(enterpriseExists(db, enterpriseId)).toBe(true)
  })

  it('同統代且 qymc 逐字匹配的批内关系可确认平台别名', async () => {
    const db = makeDb()
    const enterpriseId = seedEnterprise(db, { name: '宁波平台别名目标有限公司', uscc: TARGET_USCC })
    const aliasName = '宁波平台已返回的历史名称有限公司'
    const request = boundaryRequest('write-boundary/alias-valid-qymc-ref', {
      platformQueries: [{ rawResponse: 'Explicit synthetic original response',
        interface: 'business_list',
        queryKey: TARGET_USCC,
        rdjb: '3',
        queriedAt: '2026-10-17T03:00:00.000Z',
        status: 'success',
        relations: [{
          sequenceNo: 1,
          relationKey: 'SQ-valid-qymc',
          usccRaw: TARGET_USCC,
          nameRaw: aliasName,
          matchBasis: 'uscc',
          verificationStatus: 'confirmed',
        }],
      }],
      aliases: [{
        uscc: TARGET_USCC,
        name: aliasName,
        sourceKind: 'platform_business',
        verificationStatus: 'confirmed',
        sourceRelationRef: {
          interface: 'business_list',
          queryKey: TARGET_USCC,
          rdjb: '3',
          queriedAt: '2026-10-17T03:00:00.000Z',
          sequenceNo: 1,
        },
      }],
    })

    const result = await withRosterHttp(db, (client) => client.commit(request))

    expect(result.status, JSON.stringify(result)).toBe('committed')
    const relation = nativeRelationRows(db)[0]!
    expect(db.select().from(schema.enterpriseAlias).all()).toMatchObject([{
      enterpriseId,
      name: aliasName,
      sourceKind: 'platform_business',
      sourceRefId: relation.id,
      verificationStatus: 'confirmed',
    }])
  })

  it('pending 平台别名仍不可搜索，announcement/manual confirmed 别名可无平台关系', async () => {
    const db = makeDb()
    const enterpriseId = seedEnterprise(db, { name: '宁波本地来源别名目标有限公司', uscc: TARGET_USCC })
    const pendingName = '宁波待核平台名称有限公司'
    const announcementName = '宁波公告来源历史名称有限公司'
    const manualName = '宁波人工登记历史名称有限公司'
    const request = boundaryRequest('write-boundary/alias-pending-and-local', {
      aliases: [
        { uscc: TARGET_USCC, name: pendingName, sourceKind: 'platform_business', verificationStatus: 'pending' },
        { uscc: TARGET_USCC, name: announcementName, sourceKind: 'announcement', verificationStatus: 'confirmed' },
        { uscc: TARGET_USCC, name: manualName, sourceKind: 'manual', verificationStatus: 'confirmed' },
      ],
    })

    const result = await withRosterHttp(db, (client) => client.commit(request))

    expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(searchEnterpriseIdsByName(db, pendingName)).toEqual([])
    expect(searchEnterpriseIdsByName(db, announcementName)).toEqual([enterpriseId])
    expect(searchEnterpriseIdsByName(db, manualName)).toEqual([enterpriseId])
    expect(db.select().from(schema.enterpriseAlias).all().map((alias) => alias.verificationStatus)).toEqual([
      'pending', 'confirmed', 'confirmed',
    ])
  })

  it('归并时同唯一键但内容不同的差异行预检拒绝，提交整批不写', async () => {
    const db = makeDb()
    const name = '宁波差异冲突归并企业有限公司'
    const from = seedEnterprise(db, { name })
    const into = seedEnterprise(db, { name, uscc: TARGET_USCC })
    const sourceEvidenceId = submitNativePlatformQuery(db, { ...{ rawResponse: 'Explicit synthetic original response',
      interface: 'business_list', queryKey: TARGET_USCC, rdjb: '3',
      queriedAt: '2026-10-17T04:00:00.000Z', status: 'success',
    }, rawResponse: 'Explicit synthetic platform source' }).queryId
    const targetEvidenceId = submitNativePlatformQuery(db, { ...{ rawResponse: 'Explicit synthetic original response',
      interface: 'business_list', queryKey: TARGET_USCC, rdjb: '3',
      queriedAt: '2026-10-17T04:01:00.000Z', status: 'success',
    }, rawResponse: 'Explicit synthetic platform source' }).queryId
    const recordedAt = '2026-10-17T04:02:00.000Z'
    const sourceDifferenceId = db.insert(schema.differenceReason).values({
      enterpriseId: from,
      titleCode: 'specialized_sme',
      direction: 'missing_in_miit',
      status: 'confirmed_reason',
      reasonCode: 'renamed',
      reasonNote: '来源行记录了更名',
      measureCode: 'update_current_name',
      evidenceCollectionId: db.select().from(schema.platformLegacyQueryAlias).where(eq(schema.platformLegacyQueryAlias.oldId,sourceEvidenceId)).get()!.collectionId,
      verificationStatus: 'confirmed',
      recordedAt,
    }).returning({ id: schema.differenceReason.id }).get().id
    const targetDifferenceId = db.insert(schema.differenceReason).values({
      enterpriseId: into,
      titleCode: 'specialized_sme',
      direction: 'missing_in_miit',
      status: 'needs_review',
      reasonCode: null,
      measureCode: 'manual_review',
      evidenceCollectionId: db.select().from(schema.platformLegacyQueryAlias).where(eq(schema.platformLegacyQueryAlias.oldId,targetEvidenceId)).get()!.collectionId,
      verificationStatus: 'pending',
      recordedAt,
    }).returning({ id: schema.differenceReason.id }).get().id
    const beforeEnterprises = db.select().from(schema.enterprise).all()
    const beforeDifferences = db.select(differencePublicColumns(db)).from(schema.differenceReason).all()
    const request = boundaryRequest('write-boundary/merge-difference-conflict', {
      merges: [{ fromEnterpriseId: from, intoUscc: TARGET_USCC, sourceKind: 'manual' }],
    })

    const result = await withRosterHttp(db, async (client) => {
      const preflight = await client.preflight(request)
      expect(preflight.preflight.conflicts.find((item) => item.kind === 'merge')!.error!.code)
        .toBe('merge_difference_conflict')
      return client.commit(request)
    })

    expect(result.status).toBe('failed')
    expect(result.summary.written).toBe(0)
    expect(enterpriseExists(db, from)).toBe(true)
    expect(db.select().from(schema.enterprise).all()).toEqual(beforeEnterprises)
    expect(db.select(differencePublicColumns(db)).from(schema.differenceReason).all()).toEqual(beforeDifferences)
    expect(db.select(differencePublicColumns(db)).from(schema.differenceReason).all().map((row) => row.id)).toEqual([
      sourceDifferenceId, targetDifferenceId,
    ])
  })

  it('归并时同唯一键且内容等价的差异行仍按原规则保留一条', async () => {
    const db = makeDb()
    const name = '宁波差异等价归并企业有限公司'
    const from = seedEnterprise(db, { name })
    const into = seedEnterprise(db, { name, uscc: TARGET_USCC })
    const evidenceQueryId = submitNativePlatformQuery(db, { ...{ rawResponse: 'Explicit synthetic original response',
      interface: 'business_list', queryKey: TARGET_USCC, rdjb: '3',
      queriedAt: '2026-10-17T05:00:00.000Z', status: 'success',
    }, rawResponse: 'Explicit synthetic platform source' }).queryId
    const recordedAt = '2026-10-17T05:01:00.000Z'
    const difference = {
      titleCode: 'specialized_sme' as const,
      direction: 'missing_in_miit' as const,
      status: 'confirmed_reason' as const,
      reasonCode: 'platform_stale' as const,
      reasonNote: '平台快照仍未同步',
      measureCode: 'mark_platform_snapshot' as const,
      evidenceQueryId,
      verificationStatus: 'confirmed' as const,
      recordedAt,
    }
    const {evidenceQueryId:publicQueryId,...nativeDifference}=difference
    const evidenceCollectionId=db.select().from(schema.platformLegacyQueryAlias).where(eq(schema.platformLegacyQueryAlias.oldId,publicQueryId)).get()!.collectionId
    db.insert(schema.differenceReason).values({enterpriseId:from,...nativeDifference,evidenceCollectionId}).run()
    db.insert(schema.differenceReason).values({enterpriseId:into,...nativeDifference,evidenceCollectionId}).run()
    const request = boundaryRequest('write-boundary/merge-difference-equivalent', {
      merges: [{ fromEnterpriseId: from, intoUscc: TARGET_USCC, sourceKind: 'manual' }],
    })

    const result = await withRosterHttp(db, (client) => client.commit(request))

    expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(db.select().from(schema.enterpriseMerge).all()).toEqual(expect.arrayContaining([expect.objectContaining({fromEnterpriseId:from,intoEnterpriseId:into})]))
    const kept = db.select(differencePublicColumns(db)).from(schema.differenceReason).all().filter((row) => row.enterpriseId === into)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject(difference)
  })
})

// ---------------------------------------------------------------------------
// 5. 真实 HTTP 契约（真端口 + 真客户端）
// ---------------------------------------------------------------------------

describe('真实 HTTP：鉴权', () => {
  it('未配 token ⇒ 写入整体关闭（401），即便带了 token', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: '' })
    try {
      const response = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(announcementRequest()),
      })
      expect(response.status).toBe(401)
      expect((await response.json()) as { reason: string }).toMatchObject({ reason: 'no-token-configured' })
    } finally {
      await server.close()
    }
  })

  it('未带 token / token 错误 ⇒ 401，且**不写任何数据**', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const missing = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(announcementRequest()),
      })
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toContain('Bearer')

      const wrong = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-token': 'nope' },
        body: JSON.stringify(announcementRequest()),
      })
      expect(wrong.status).toBe(401)
      expect(rosterRowCounts(db).enterprise).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('请求体不合法 ⇒ 400；路径不对 ⇒ 404', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const bad = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ idempotencyKey: 'k' }),
      })
      expect(bad.status).toBe(400)
      const notFound = await fetch(`${server.baseUrl}/api/other`)
      expect(notFound.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('★ 方法不对 ⇒ 405 由**核心自己**给出(夹具不替它拦成 404)', async () => {
    // 夹具按**路径**分发、不看方法,方法守卫留给 `handleRosterImportRequest`
    // (`tests/helpers/http-fixture.ts` 的路由规则)。若夹具改成按方法分发,这条会变 404
    // —— 那等于把核心的方法守卫从真 HTTP 面上悄悄摘掉。
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const got = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(got.status).toBe(405)
      expect(rosterRowCounts(db).enterprise).toBe(0)
    } finally {
      await server.close()
    }
  })
})

describe('真实 HTTP：预检 → 提交 → 重放 → 失败恢复 → 完整性', () => {
  it.each([
    ['USCC 后名称', false],
    ['名称后 USCC', true],
  ] as const)('唯一既有企业的统代与名称写法合并重复新事件出处且顺序无关（%s）', async (_order, reverse) => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成写法归组企业有限公司'
    const uscc = '91330211255994457P'
    const enterpriseId = seedEnterprise(db, { name, uscc })
    const recordId = seedRecord(db, enterpriseId, 'specialized_sme', 'jxj')
    const shared = { sourceFile: 'synthetic/group/shared.pdf', attachment: '附件1', listNo: 1, page: 7 }
    const withUscc = {
      enterprise: { name, uscc },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 4, evidence: [shared, { sourceFile: 'synthetic/group/uscc.pdf', attachment: '附件1', listNo: 2, page: 8 }] }],
    }
    const withoutUscc = {
      enterprise: { name },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 4, evidence: [shared, { sourceFile: 'synthetic/group/name.pdf', attachment: '附件2', listNo: 3, page: 9 }] }],
    }
    const request = announcementRequest({ idempotencyKey: `synthetic/group/${reverse ? 'name-first' : 'uscc-first'}` })
    request.payload.announcement!.records = reverse ? [withoutUscc, withUscc] : [withUscc, withoutUscc]

    try {
      const result = await client.commit(request)
      expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(db.select().from(schema.record).all()).toHaveLength(1)
      expect(db.select().from(schema.recordEvent).all()).toHaveLength(1)
      expect(db.select().from(schema.recordEvidence).all().map(({ sourceFile, attachment, listNo, page }) => ({ sourceFile, attachment, listNo, page })).sort((a, b) => a.sourceFile.localeCompare(b.sourceFile))).toEqual([
        { sourceFile: 'synthetic/group/name.pdf', attachment: '附件2', listNo: 3, page: 9 },
        shared,
        { sourceFile: 'synthetic/group/uscc.pdf', attachment: '附件1', listNo: 2, page: 8 },
      ])
      expect(db.select().from(schema.recordEvent).all()[0]?.recordId).toBe(recordId)
    } finally {
      await server.close()
    }
  })

  it('同名但不同 USCC 的既有企业各自写入事件和出处，不跨企业合并', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成同名不同统代企业'
    const enterpriseA = seedEnterprise(db, { name, uscc: '91330211255994457P' })
    const enterpriseB = seedEnterprise(db, { name, uscc: '91330201753252106U' })
    const recordA = seedRecord(db, enterpriseA, 'specialized_sme', 'jxj')
    const recordB = seedRecord(db, enterpriseB, 'specialized_sme', 'jxj')
    const request = announcementRequest({ idempotencyKey: 'synthetic/group/distinct-uscc' })
    request.payload.announcement!.records = [
      { enterprise: { name, uscc: '91330211255994457P' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 4, evidence: [{ sourceFile: 'synthetic/group/a.pdf', attachment: '附件1', listNo: 1, page: 7 }] }] },
      { enterprise: { name, uscc: '91330201753252106U' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 4, evidence: [{ sourceFile: 'synthetic/group/b.pdf', attachment: '附件1', listNo: 1, page: 7 }] }] },
    ]

    try {
      const result = await client.commit(request)
      expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(db.select().from(schema.recordEvent).all().map((event) => event.recordId).sort()).toEqual([recordA, recordB].sort())
      expect(db.select().from(schema.recordEvidence).all().map((row) => [row.recordEventId, row.sourceFile]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
        [db.select().from(schema.recordEvent).all().find((event) => event.recordId === recordA)!.id, 'synthetic/group/a.pdf'],
        [db.select().from(schema.recordEvent).all().find((event) => event.recordId === recordB)!.id, 'synthetic/group/b.pdf'],
      ])
    } finally {
      await server.close()
    }
  })

  it('重复事件落到有歧义的同名企业时返回冲突且不写入', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成歧义同名企业'
    const enterpriseId = seedEnterprise(db, { name, uscc: '91330211255994457P' })
    seedEnterprise(db, { name, uscc: '91330201753252106U' })
    seedRecord(db, enterpriseId, 'specialized_sme', 'jxj')
    const before = rosterRowCounts(db)
    const request = announcementRequest({ idempotencyKey: 'synthetic/group/ambiguous-name' })
    request.payload.announcement!.records = [
      { enterprise: { name, uscc: '91330211255994457P' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 4, evidence: [{ sourceFile: 'synthetic/group/known.pdf', attachment: '附件1', listNo: 1, page: 7 }] }] },
      { enterprise: { name }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 4, evidence: [{ sourceFile: 'synthetic/group/ambiguous.pdf', attachment: '附件2', listNo: 2, page: 8 }] }] },
    ]

    try {
      const result = await client.commit(request)
      expect(result.status).toBe('failed')
      expect(result.items.some((item) => item.error?.code === 'enterprise_ambiguous')).toBe(true)
      expect(rosterRowCounts(db)).toEqual(before)
    } finally {
      await server.close()
    }
  })

  it.each([
    ['USCC 第二家在前', false],
    ['name-only 在前', true],
  ] as const)('明确指向第二家 USCC 的记录与歧义 name-only 记录顺序无关地整批失败（%s）', async (_order, nameOnlyFirst) => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成歧义顺序企业'
    seedEnterprise(db, { name, uscc: '91330211255994457P' })
    seedEnterprise(db, { name, uscc: '91330201753252106U' })
    const before = rosterRowCounts(db)
    const explicitUscc = {
      enterprise: { name, uscc: '91330201753252106U' },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 5, evidence: [{ sourceFile: 'synthetic/ambiguous/explicit.pdf', attachment: '附件1', listNo: 1, page: 7 }] }],
    }
    const nameOnly = {
      enterprise: { name },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 5, evidence: [{ sourceFile: 'synthetic/ambiguous/name-only.pdf', attachment: '附件1', listNo: 2, page: 8 }] }],
    }
    const request = announcementRequest({ idempotencyKey: `synthetic/ambiguous-order/${nameOnlyFirst ? 'name-first' : 'uscc-first'}` })
    request.payload.announcement!.records = nameOnlyFirst ? [nameOnly, explicitUscc] : [explicitUscc, nameOnly]

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight.conflicts).toContainEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'enterprise_ambiguous' }),
        }),
      )
      expect(rosterRowCounts(db)).toEqual(before)

      const result = await client.commit(request)
      expect(result.status).toBe('failed')
      expect(result.items).toContainEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'enterprise_ambiguous' }),
        }),
      )
      expect(db.select().from(schema.importBatch).all().find((batch) => batch.id === result.batchId)?.status).toBe('failed')
      expect(rosterRowCounts(db)).toEqual(before)
    } finally {
      await server.close()
    }
  })

  it('单条 name-only 记录命中多家同名企业时预检与提交均结构化拒绝', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成单条歧义企业'
    seedEnterprise(db, { name, uscc: '91330211255994457P' })
    seedEnterprise(db, { name, uscc: '91330201753252106U' })
    const before = rosterRowCounts(db)
    const request = announcementRequest({ idempotencyKey: 'synthetic/ambiguous/single-name-only' })
    request.payload.announcement!.records = [
      { enterprise: { name }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 6, evidence: [{ sourceFile: 'synthetic/ambiguous/single.pdf', attachment: '附件1', listNo: 1, page: 9 }] }] },
    ]

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight.conflicts).toContainEqual(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'enterprise_ambiguous' }) }),
      )
      expect(rosterRowCounts(db)).toEqual(before)

      const result = await client.commit(request)
      expect(result.status).toBe('failed')
      expect(result.items).toContainEqual(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'enterprise_ambiguous' }) }),
      )
      expect(db.select().from(schema.importBatch).all().find((batch) => batch.id === result.batchId)?.status).toBe('failed')
      expect(rosterRowCounts(db)).toEqual(before)
    } finally {
      await server.close()
    }
  })

  it('唯一名称写法仍可写入既有企业', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成唯一名称导入企业'
    const enterpriseId = seedEnterprise(db, { name, uscc: '91330211255994457P' })
    const recordId = seedRecord(db, enterpriseId, 'specialized_sme', 'jxj')
    const request = announcementRequest({ idempotencyKey: 'synthetic/identity/unique-name' })
    request.payload.announcement!.records = [
      { enterprise: { name }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 7, evidence: [{ sourceFile: 'synthetic/identity/unique-name.pdf', attachment: '附件1', listNo: 1, page: 10 }] }] },
    ]

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight.conflicts).toEqual([])
      const result = await client.commit(request)
      expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(db.select().from(schema.recordEvent).all().map((event) => event.recordId)).toEqual([recordId])
      expect(db.select().from(schema.recordEvidence).all().map((evidence) => evidence.sourceFile)).toEqual(['synthetic/identity/unique-name.pdf'])
    } finally {
      await server.close()
    }
  })

  it('存在同名企业时明确 USCC 仍可写入对应既有企业', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成明确统代导入企业'
    seedEnterprise(db, { name, uscc: '91330211255994457P' })
    const targetId = seedEnterprise(db, { name, uscc: '91330201753252106U' })
    const recordId = seedRecord(db, targetId, 'specialized_sme', 'jxj')
    const request = announcementRequest({ idempotencyKey: 'synthetic/identity/explicit-uscc' })
    request.payload.announcement!.records = [
      { enterprise: { name, uscc: '91330201753252106U' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 8, evidence: [{ sourceFile: 'synthetic/identity/explicit-uscc.pdf', attachment: '附件1', listNo: 1, page: 11 }] }] },
    ]

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight.conflicts).toEqual([])
      const result = await client.commit(request)
      expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(db.select().from(schema.recordEvent).all().map((event) => event.recordId)).toEqual([recordId])
      expect(db.select().from(schema.recordEvidence).all().map((evidence) => evidence.sourceFile)).toEqual(['synthetic/identity/explicit-uscc.pdf'])
    } finally {
      await server.close()
    }
  })

  it.each([
    ['USCC 在前', false],
    ['name-only 在前', true],
  ] as const)('空库同名混合 USCC/name-only 记录顺序无关地写成一个企业事件和两条出处（%s）', async (_order, nameOnlyFirst) => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成空库批次归组企业'
    const uscc = '91330201753252106U'
    const explicit = {
      enterprise: { name, uscc },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 9, evidence: [{ sourceFile: 'synthetic/batch-identity/explicit.pdf', attachment: '附件1', listNo: 1, page: 12 }] }],
    }
    const nameOnly = {
      enterprise: { name },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 9, evidence: [{ sourceFile: 'synthetic/batch-identity/name-only.pdf', attachment: '附件1', listNo: 2, page: 13 }] }],
    }
    const request = announcementRequest({ idempotencyKey: `synthetic/batch-identity/${nameOnlyFirst ? 'name-first' : 'uscc-first'}` })
    request.payload.announcement!.records = nameOnlyFirst ? [nameOnly, explicit] : [explicit, nameOnly]

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight).toMatchObject({ add: 1, conflicts: [] })
      expect(rosterRowCounts(db)).toMatchObject({ enterprise: 0, record: 0, record_event: 0, record_evidence: 0 })

      const result = await client.commit(request)
      expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(result.summary.failed).toBe(0)
      expect(rosterRowCounts(db)).toMatchObject({ enterprise: 1, record: 1, record_event: 1, record_evidence: 2 })

      const [enterprise] = db.select().from(schema.enterprise).all()
      expect(enterprise).toMatchObject({ name, usccNorm: uscc })
      const [record] = db.select().from(schema.record).all()
      expect(record).toMatchObject({ enterpriseId: enterprise!.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: uscc })
      const [event] = db.select().from(schema.recordEvent).all()
      expect(event).toMatchObject({ recordId: record!.id, eventType: 'award', year: 2026, batchSeq: 9 })
      expect(db.select().from(schema.recordEvidence).all().map(({ sourceFile, attachment, listNo, page }) => ({ sourceFile, attachment, listNo, page })).sort((a, b) => a.sourceFile.localeCompare(b.sourceFile))).toEqual([
        { sourceFile: 'synthetic/batch-identity/explicit.pdf', attachment: '附件1', listNo: 1, page: 12 },
        { sourceFile: 'synthetic/batch-identity/name-only.pdf', attachment: '附件1', listNo: 2, page: 13 },
      ])
    } finally {
      await server.close()
    }
  })

  it.each([
    ['name-only 在前', true],
    ['name-only 在后', false],
  ] as const)('批内同名多 USCC 时 name-only 返回 enterprise_ambiguous 且整批不写（%s）', async (_order, nameOnlyFirst) => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成批内多统代歧义企业'
    const explicitA = {
      enterprise: { name, uscc: '91330211255994457P' },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 10, evidence: [{ sourceFile: 'synthetic/batch-identity/a.pdf', attachment: '附件1', listNo: 1, page: 14 }] }],
    }
    const explicitB = {
      enterprise: { name, uscc: '91330201753252106U' },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 10, evidence: [{ sourceFile: 'synthetic/batch-identity/b.pdf', attachment: '附件1', listNo: 1, page: 14 }] }],
    }
    const nameOnly = {
      enterprise: { name },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 10, evidence: [{ sourceFile: 'synthetic/batch-identity/name-only-ambiguous.pdf', attachment: '附件2', listNo: 2, page: 15 }] }],
    }
    const request = announcementRequest({ idempotencyKey: `synthetic/batch-identity/ambiguous/${nameOnlyFirst ? 'name-first' : 'name-last'}` })
    request.payload.announcement!.records = nameOnlyFirst ? [nameOnly, explicitA, explicitB] : [explicitA, explicitB, nameOnly]
    const before = rosterRowCounts(db)

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight.conflicts).toContainEqual(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'enterprise_ambiguous' }) }),
      )
      expect(rosterRowCounts(db)).toEqual(before)

      const result = await client.commit(request)
      expect(result.status).toBe('failed')
      expect(result.items).toContainEqual(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'enterprise_ambiguous' }) }),
      )
      expect(db.select().from(schema.importBatch).all().find((batch) => batch.id === result.batchId)?.status).toBe('failed')
      expect(rosterRowCounts(db)).toEqual(before)
    } finally {
      await server.close()
    }
  })

  it.each([
    ['name-only 在前', true],
    ['显式 USCC B 在前', false],
  ] as const)('既有 USCC A 与批内 USCC B 是不同候选时 name-only 顺序无关地整批失败（%s）', async (_order, nameOnlyFirst) => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成既有与批内统代混合候选企业'
    const enterpriseA = seedEnterprise(db, { name, uscc: '91330211255994457P' })
    const existingRecord = seedRecord(db, enterpriseA, 'specialized_sme', 'jxj')
    const existingEvent = seedEvent(db, existingRecord, 'award', 2022, 1)
    db.insert(schema.recordEvidence)
      .values({ recordEventId: existingEvent, sourceFile: 'synthetic/identity-existing/a.pdf', attachment: '附件1', listNo: 1, page: 1 })
      .run()
    const before = rosterRowCounts(db)
    const explicitUsccB = {
      enterprise: { name, uscc: '91330201753252106U' },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 12, evidence: [{ sourceFile: 'synthetic/mixed-candidates/explicit-b.pdf', attachment: '附件1', listNo: 1, page: 17 }] }],
    }
    const nameOnly = {
      enterprise: { name },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award' as const, year: 2026, batchSeq: 12, evidence: [{ sourceFile: 'synthetic/mixed-candidates/name-only.pdf', attachment: '附件1', listNo: 2, page: 18 }] }],
    }
    const request = announcementRequest({ idempotencyKey: `synthetic/mixed-candidates/${nameOnlyFirst ? 'name-first' : 'uscc-first'}` })
    request.payload.announcement!.records = nameOnlyFirst ? [nameOnly, explicitUsccB] : [explicitUsccB, nameOnly]

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight.conflicts).toContainEqual(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'enterprise_ambiguous' }) }),
      )
      expect(rosterRowCounts(db)).toEqual(before)

      const result = await client.commit(request)
      expect(result.status).toBe('failed')
      expect(result.items).toContainEqual(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'enterprise_ambiguous' }) }),
      )
      expect(db.select().from(schema.importBatch).all().find((batch) => batch.id === result.batchId)?.status).toBe('failed')
      expect(rosterRowCounts(db)).toEqual(before)
    } finally {
      await server.close()
    }
  })

  it.each([
    ['length', '91330211255994457'],
    ['charset', '9133021125599445IP'],
    ['checksum', '91330211255994457Q'],
  ] as const)('公告中的非空无效 USCC（%s）先报 uscc_format_invalid,不污染 name-only 身份候选', (kind, uscc) => {
    const db = makeDb()
    const name = `合成无效统代${kind}企业`
    const request = announcementRequest({ idempotencyKey: `synthetic/invalid-uscc/${kind}` })
    request.payload.announcement!.records = [
      {
        enterprise: { name, uscc },
        titleCode: 'specialized_sme',
        events: [{ eventType: 'award', year: 2026, batchSeq: 1 }],
      },
      {
        enterprise: { name },
        titleCode: 'innovative_sme',
        events: [{ eventType: 'award', year: 2026, batchSeq: 2 }],
      },
    ]
    const before = rosterRowCounts(db)

    const preflight = preflightRosterImport(db, request)
    expect(preflight.preflight.conflicts.map((item) => item.error?.code)).toEqual(['uscc_format_invalid'])
    expect(rosterRowCounts(db)).toEqual(before)

    const result = commitRosterImport(db, request)
    expect(result.status).toBe('failed')
    expect(result.items.map((item) => item.error?.code)).toEqual(['uscc_format_invalid'])
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it('有效小写 USCC 按验证器允许的空白 / 不可见字符归一后仍作为唯一身份', () => {
    const db = makeDb()
    const name = '合成有效统代归一企业'
    const rawUscc = ' 9133021125\u200B5994457p '
    const request = announcementRequest({ idempotencyKey: 'synthetic/valid-uscc-normalized' })
    request.payload.announcement!.records = [
      {
        enterprise: { name, uscc: rawUscc },
        titleCode: 'specialized_sme',
        events: [{ eventType: 'award', year: 2026, batchSeq: 1 }],
      },
      {
        enterprise: { name },
        titleCode: 'innovative_sme',
        events: [{ eventType: 'award', year: 2026, batchSeq: 2 }],
      },
    ]

    expect(preflightRosterImport(db, request).preflight.conflicts).toEqual([])
    const result = commitRosterImport(db, request)
    expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(db.select().from(schema.enterprise).all()).toMatchObject([{ name, usccNorm: '91330211255994457P' }])
    expect(db.select().from(schema.enterprise).all()).toHaveLength(1)
    expect(db.select().from(schema.record).all().map((record) => record.usccRaw)).toEqual([
      '91330211255994457P',
      '91330211255994457P',
    ])
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', ' \t\u200B\u3000 '],
  ] as const)('公告 USCC %s 视为缺失身份,仍允许按名称写入', (kind, value) => {
    const db = makeDb()
    const request = announcementRequest({ idempotencyKey: `synthetic/missing-uscc/${kind}` })
    const enterprise = request.payload.announcement!.records[0]!.enterprise
    if (value === undefined) delete enterprise.uscc
    else enterprise.uscc = value

    const result = commitRosterImport(db, request)
    expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(db.select().from(schema.enterprise).all()).toHaveLength(1)
    expect(db.select().from(schema.enterprise).all()[0]?.usccNorm).toBeNull()
    expect(db.select().from(schema.record).all()[0]?.usccRaw).toBeNull()
  })

  it('历史无效企业 USCC 不作为有效代码证据写进 name-only 记录', () => {
    const db = makeDb()
    const name = '合成历史无效统代企业'
    const legacyId = seedEnterprise(db, { name, uscc: '91330211255994457Q' })
    const request = announcementRequest({ idempotencyKey: 'synthetic/legacy-invalid-uscc' })
    request.payload.announcement!.records = [
      {
        enterprise: { name },
        titleCode: 'specialized_sme',
        events: [{ eventType: 'award', year: 2026, batchSeq: 1 }],
      },
    ]

    const result = commitRosterImport(db, request)
    expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(db.select().from(schema.enterprise).all()).toHaveLength(1)
    expect(db.select().from(schema.enterprise).all()[0]).toMatchObject({ id: legacyId, usccNorm: '91330211255994457Q' })
    expect(db.select().from(schema.record).all()[0]?.usccRaw).toBeNull()
  })

  it('空库中仅一个 name-only 记录仍可按名称新建企业', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const name = '合成空库单名称企业'
    const request = announcementRequest({ idempotencyKey: 'synthetic/batch-identity/single-name-only' })
    request.payload.announcement!.records = [
      { enterprise: { name }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 11, evidence: [{ sourceFile: 'synthetic/batch-identity/single-name-only.pdf', attachment: '附件1', listNo: 1, page: 16 }] }] },
    ]

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight).toMatchObject({ add: 1, conflicts: [] })
      const result = await client.commit(request)
      expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(rosterRowCounts(db)).toMatchObject({ enterprise: 1, record: 1, record_event: 1, record_evidence: 1 })
      expect(db.select().from(schema.enterprise).all()[0]).toMatchObject({ name, usccNorm: null })
      expect(db.select().from(schema.record).all()[0]?.usccRaw).toBeNull()
      expect(db.select().from(schema.recordEvidence).all().map((row) => row.sourceFile)).toEqual(['synthetic/batch-identity/single-name-only.pdf'])
    } finally {
      await server.close()
    }
  })

  it('客户端走完整个回放序列，结果与直接调核心逻辑一致', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const request = announcementRequest({ idempotencyKey: 'http/replay#sha256:abc' })

    try {
      // 1. 预检：只算影响，不写业务数据。
      const preflight = await client.preflight(request)
      expect(preflight.status).toBe('preflight')
      expect(preflight.preflight.add).toBeGreaterThan(0)
      expect(rosterRowCounts(db).enterprise).toBe(0)

      // 2. 提交。
      const committed = await client.commit(request)
      expect(committed.status).toBe('committed')
      expect(committed.summary.failed).toBe(0)
      const after = rosterRowCounts(db)
      expect(after.enterprise).toBe(1)
      expect(after.record).toBe(1)
      expect(after.record_event).toBe(1)
      expect(after.record_evidence).toBe(1)

      // 3. 重放同一来源：同一批次、同一摘要、零新增。
      const replay = await client.commit(request)
      expect(replay.batchId).toBe(committed.batchId)
      expect(replay.summary).toEqual(committed.summary)
      expect(rosterRowCounts(db)).toEqual(after)

      // 4. 失败恢复：坏载荷 → failed（一行不写）；修好后以同一键重试 → committed。
      const broken = announcementRequest({ idempotencyKey: 'http/recover#sha256:abc' })
      ;(broken.payload.announcement!.records[0] as { titleCode: string }).titleCode = 'nope'
      const failed = await client.commit(broken)
      expect(failed.status).toBe('failed')
      expect(failed.items.some((i) => i.error?.code === 'title_unknown')).toBe(true)
      expect(rosterRowCounts(db)).toEqual(after)

      const fixed = announcementRequest({ idempotencyKey: 'http/recover#sha256:abc' })
      fixed.payload.announcement!.records[0]!.events = [{ eventType: 'award', year: 2026, batchSeq: 1 }]
      const recovered = await client.commit(fixed)
      expect(recovered.status).toBe('committed')
      expect(recovered.batchId).toBe(failed.batchId)
      // 同一 record 上：复核(replay 批) + 认定(recover 批)—— 事件一条不丢。
      expect(rosterRowCounts(db).record_event).toBe(2)

      // 5. 完整性：未匹配平台导出的公布条目也在（走同一批的第二条记录）。
      const complete = announcementRequest({ idempotencyKey: 'http/complete#sha256:abc' })
      complete.payload.announcement!.records.push({
        enterprise: { name: '未匹配平台导出的企业' },
        titleCode: 'innovative_sme',
        events: [{ eventType: 'award', year: 2026, batchSeq: 1 }],
      })
      complete.payload.platformQueries = [
        { rawResponse: 'Explicit synthetic original response',
          interface: 'business_list',
          queryKey: '9133021100000000ZZ',
          rdjb: '3',
          queriedAt: '2026-10-16T06:00:00.000Z',
          status: 'success',
          relations: [{ sequenceNo: 1, usccRaw: '9133021100000000ZZ', nameRaw: '平台有的另一家', matchBasis: 'none' }],
        },
      ]
      const done = await client.commit(complete)
      expect(done.status).toBe('committed')
      const names = db.select().from(schema.enterprise).all().map((e) => e.name)
      expect(names).toContain('未匹配平台导出的企业')
      // 平台关系归属不到企业时留空待核（不模糊推断）。
      const unbound = nativeRelationRows(db).find((r) => r.usccRaw === '9133021100000000ZZ')!
      expect(unbound.enterpriseId).toBeNull()
      expect(unbound.verificationStatus).toBe('pending')
    } finally {
      await server.close()
    }
  })

  it('公告事件出处保留 PDF 正整数页码,并允许非 PDF 的缺省 / null 页码', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const request = announcementRequest({ idempotencyKey: 'http/stable-evidence-pages#sha256:abc' })
    request.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/notice.pdf', attachment: '附件', listNo: 1, page: 7 },
      { sourceFile: 'synthetic/pending.pdf', attachment: '附件', listNo: 2, page: null },
      { sourceFile: 'synthetic/unset.pdf', attachment: '附件', listNo: 3 },
      { sourceFile: 'synthetic/notice.docx', attachment: '正文', listNo: 4, page: null },
      { sourceFile: 'synthetic/export.xlsx', attachment: 'Sheet1', listNo: 5 },
    ]

    try {
      const committed = await client.commit(request)
      expect(committed.status).toBe('committed')

      const enterprise = db
        .select()
        .from(schema.enterprise)
        .where(eq(schema.enterprise.name, '宁波上航测绘股份有限公司'))
        .get()!
      const evidence = getRosterEnterpriseDetail(db, enterprise.id)!.evidence
      const pageBySource = Object.fromEntries(evidence.map((entry) => [entry.sourceFile, entry.page]))
      expect(pageBySource).toEqual({
        'synthetic/notice.pdf': 7,
        'synthetic/pending.pdf': null,
        'synthetic/unset.pdf': null,
        'synthetic/notice.docx': null,
        'synthetic/export.xlsx': null,
      })
    } finally {
      await server.close()
    }
  })

  it('统一导入按源 PDF 实际页数预检并拒绝越界或未知页码且不写部分数据', async () => {
    const cases = [
      { name: 'page 24', page: 24, sourceState: 'readable', expectedCode: 'page_invalid' },
      { name: 'page 999', page: 999, sourceState: 'readable', expectedCode: 'page_invalid' },
      { name: 'missing source', page: 8, sourceState: 'missing', expectedCode: 'page_count_unknown' },
      { name: 'unreadable source', page: 8, sourceState: 'unreadable', expectedCode: 'page_count_unknown' },
    ] as const

    for (const entry of cases) {
      const db = makeDb()
      const filesDir = mkdtempSync(join(tmpdir(), 'spztx-import-page-count-'))
      dirs.push(filesDir)
      const sourceFile = `synthetic/page-count/${entry.name.replaceAll(' ', '-')}.pdf`
      const sourcePath = join(filesDir, sourceFile)
      if (entry.sourceState !== 'missing') {
        mkdirSync(join(sourcePath, '..'), { recursive: true })
        writeFileSync(sourcePath, entry.sourceState === 'readable' ? minimalPdf({ pages: 23 }) : 'not a PDF')
      }
      const server = await startRosterApi({ db, apiToken: TOKEN, filesDir })
      const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
      const request = announcementRequest({
        idempotencyKey: `http/import-page-count/${entry.name}`,
        sourceIdentity: sourceFile,
      })
      request.payload.announcement!.records[0]!.events![0]!.evidence = [
        { sourceFile, attachment: '附件1', listNo: 1, page: entry.page },
      ]
      request.payload.announcement!.records.push({
        enterprise: { name: `页码验证失败时不得部分写入-${entry.name}` },
        titleCode: 'specialized_sme',
        events: [{ eventType: 'award', year: 2026, batchSeq: 2 }],
      })
      const before = rosterRowCounts(db)

      try {
        const preflight = await client.preflight(request)
        expect(preflight.preflight.conflicts, entry.name).toContainEqual(
          expect.objectContaining({ ok: false, error: expect.objectContaining({ code: entry.expectedCode }) }),
        )
        expect(rosterRowCounts(db), entry.name).toEqual(before)

        const commit = await client.commit(request)
        expect(commit.status, entry.name).toBe('failed')
        expect(commit.items, entry.name).toContainEqual(
          expect.objectContaining({ ok: false, error: expect.objectContaining({ code: entry.expectedCode }) }),
        )
        expect(rosterRowCounts(db), entry.name).toEqual(before)
      } finally {
        await server.close()
      }
    }
  })

  it('统一导入接受第 23 页这一实际 PDF 边界并持久化页码', async () => {
    const db = makeDb()
    const filesDir = mkdtempSync(join(tmpdir(), 'spztx-import-page-count-boundary-'))
    dirs.push(filesDir)
    const sourceFile = 'synthetic/page-count/boundary-23.pdf'
    const sourcePath = join(filesDir, sourceFile)
    mkdirSync(join(sourcePath, '..'), { recursive: true })
    writeFileSync(sourcePath, minimalPdf({ pages: 23 }))
    const server = await startRosterApi({ db, apiToken: TOKEN, filesDir })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const request = announcementRequest({
      idempotencyKey: 'http/import-page-count/boundary-23',
      sourceIdentity: sourceFile,
    })
    request.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile, attachment: '附件1', listNo: 1, page: 23 },
    ]

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight.conflicts).toEqual([])
      const result = await client.commit(request)
      expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(db.select().from(schema.recordEvidence).all().map((row) => row.page)).toEqual([23])
    } finally {
      await server.close()
    }
  })

  it.each([
    ['0', 0],
    ['negative', -1],
    ['fractional', 2.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['numeric string', '3'],
  ] as const)('公告 PDF 出处页码为 %s 时,以 page_invalid 拒绝整批且不写业务行', (label, page) => {
    const db = makeDb()
    const request = announcementRequest({ idempotencyKey: `http/invalid-announcement-page/${label}` })
    const record = request.payload.announcement!.records[0]!
    record.events![0]!.evidence![0]!.page = page as number
    // 即使批内另一条是完全有效的记录,非法页码也必须挡在计划/事务之前。
    request.payload.announcement!.records.push({
      enterprise: { name: '页码无效时不得部分写入的第二家企业' },
      titleCode: 'specialized_sme',
      events: [{ eventType: 'award', year: 2026, batchSeq: 2 }],
    })
    const before = rosterRowCounts(db)

    const preflight = preflightRosterImport(db, request)
    expect(preflight.preflight.conflicts).toContainEqual(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'page_invalid' }) }),
    )
    expect(rosterRowCounts(db)).toEqual(before)

    const result = commitRosterImport(db, request)
    expect(result.status).toBe('failed')
    expect(result.items).toContainEqual(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'page_invalid' }) }),
    )
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it('公告 Word / Excel 出处只要提供非 null page 就以 not_page_capable 拒绝整批', () => {
    const db = makeDb()
    const request = announcementRequest({ idempotencyKey: 'http/non-pdf-announcement-page' })
    request.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/notice.pdf', attachment: '附件', listNo: 1, page: 7 },
      { sourceFile: 'synthetic/notice.docx', attachment: '正文', listNo: 2, page: 1 },
      { sourceFile: 'synthetic/export.xlsx', attachment: 'Sheet1', listNo: 3, page: 1 },
    ]
    const before = rosterRowCounts(db)

    const result = commitRosterImport(db, request)
    expect(result.status).toBe('failed')
    expect(result.items.filter((item) => item.error?.code === 'not_page_capable')).toHaveLength(2)
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it('出处指针显式重放会清空 DOCX 旧页码并保留 PDF 实际页码', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    for (const path of [
      'synthetic/legacy/notice.docx',
      'synthetic/legacy/first-write.docx',
      'synthetic/legacy/notice.pdf',
      'synthetic/library/notice.docx',
      'synthetic/library/first-write.docx',
      'synthetic/library/notice.pdf',
    ]) seedStoredFileHash(db, path, SAME_SOURCE_SHA)
    const original = announcementRequest({
      idempotencyKey: 'synthetic/legacy/notice#sha256:stable-content',
      sourceIdentity: 'synthetic/legacy/notice',
      sourceSha256: 'stable-content',
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/legacy/notice.docx', attachment: '正文', listNo: 1, page: null },
      { sourceFile: 'synthetic/legacy/first-write.docx', attachment: '名单', listNo: 3, page: null },
      { sourceFile: 'synthetic/legacy/notice.pdf', attachment: '附件', listNo: 2, page: 7 },
    ]

    try {
      await client.commit(original)
      const seeded = db.select().from(schema.recordEvidence).all()
      const docx = seeded.find((row) => row.sourceFile.endsWith('notice.docx'))!
      const firstWriteDocx = seeded.find((row) => row.sourceFile.endsWith('first-write.docx'))!
      expect(firstWriteDocx.page).toBeNull()
      // 合成一条历史坏数据：新导入已会清空 DOCX 页码，但旧行可能带着不可靠值。
      db.update(schema.recordEvidence).set({ page: 12 }).where(eq(schema.recordEvidence.id, docx.id)).run()

      const relinked = announcementRequest({
        idempotencyKey: 'synthetic/library/notice#sha256:stable-content',
        sourceIdentity: 'synthetic/library/notice',
        sourceSha256: 'stable-content',
      })
      relinked.payload.announcement!.records[0]!.events![0]!.evidence = [
        { sourceFile: 'synthetic/library/notice.docx', attachment: '正文', listNo: 1, page: null },
        { sourceFile: 'synthetic/library/first-write.docx', attachment: '名单', listNo: 3, page: null },
        { sourceFile: 'synthetic/library/notice.pdf', attachment: '附件', listNo: 2, page: 7 },
      ]

      const result = await client.replay(relinked)
      expect(result.status).toBe('replayed')
      expect(result.evidenceRepointed).toBe(3)
      const evidence = db.select().from(schema.recordEvidence).all()
      expect(evidence).toHaveLength(3)
      expect(Object.fromEntries(evidence.map((row) => [row.sourceFile, row.page]))).toEqual({
        'synthetic/library/notice.docx': null,
        'synthetic/library/first-write.docx': null,
        'synthetic/library/notice.pdf': 7,
      })
    } finally {
      await server.close()
    }
  })

  it('重复事件提交共用非 PDF 页码清空与 PDF 页码保留规则', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    for (const path of [
      'synthetic/legacy/duplicate.docx',
      'synthetic/legacy/duplicate-first-write.docx',
      'synthetic/legacy/duplicate.pdf',
      'synthetic/library/duplicate.docx',
      'synthetic/library/duplicate-first-write.docx',
      'synthetic/library/duplicate.pdf',
    ]) seedStoredFileHash(db, path, SAME_SOURCE_SHA)
    const original = announcementRequest({
      idempotencyKey: 'synthetic/legacy/duplicate#sha256:stable-content',
      sourceIdentity: 'synthetic/legacy/duplicate',
      sourceSha256: 'stable-content',
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/legacy/duplicate.docx', attachment: '正文', listNo: 1, page: null },
      { sourceFile: 'synthetic/legacy/duplicate-first-write.docx', attachment: '名单', listNo: 3, page: null },
      { sourceFile: 'synthetic/legacy/duplicate.pdf', attachment: '附件', listNo: 2, page: 7 },
    ]

    try {
      await client.commit(original)
      const seeded = db.select().from(schema.recordEvidence).all()
      const docx = seeded.find((row) => row.sourceFile.endsWith('/duplicate.docx'))!
      const firstWriteDocx = seeded.find((row) => row.sourceFile.endsWith('duplicate-first-write.docx'))!
      expect(firstWriteDocx.page).toBeNull()
      db.update(schema.recordEvidence).set({ page: 12 }).where(eq(schema.recordEvidence.id, docx.id)).run()

      const duplicate = announcementRequest({
        idempotencyKey: 'synthetic/library/duplicate#sha256:stable-content',
        sourceIdentity: 'synthetic/library/duplicate',
        sourceSha256: 'stable-content',
      })
      duplicate.payload.announcement!.records[0]!.events![0]!.evidence = [
        { sourceFile: 'synthetic/library/duplicate.docx', attachment: '正文', listNo: 1, page: null },
        { sourceFile: 'synthetic/library/duplicate-first-write.docx', attachment: '名单', listNo: 3, page: null },
        { sourceFile: 'synthetic/library/duplicate.pdf', attachment: '附件', listNo: 2, page: 7 },
      ]

      const result = await client.commit(duplicate)
      expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(result.summary.evidenceRepointed).toBe(3)
      const evidence = db.select().from(schema.recordEvidence).all()
      expect(evidence).toHaveLength(3)
      expect(Object.fromEntries(evidence.map((row) => [row.sourceFile, row.page]))).toEqual({
        'synthetic/library/duplicate.docx': null,
        'synthetic/library/duplicate-first-write.docx': null,
        'synthetic/library/duplicate.pdf': 7,
      })
    } finally {
      await server.close()
    }
  })

  it('旧路径和目标路径有相同 SHA 时预检、commit 与 replay 才能收敛', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const oldPath = 'synthetic/hash-match/old.pdf'
    const targetPath = 'synthetic/hash-match/new.pdf'
    seedStoredFileHash(db, oldPath, SAME_SOURCE_SHA)
    seedStoredFileHash(db, targetPath, SAME_SOURCE_SHA)
    const original = announcementRequest({
      idempotencyKey: 'synthetic/hash-match/old#sha256:same',
      sourceIdentity: oldPath,
      sourceSha256: SAME_SOURCE_SHA,
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: oldPath, attachment: '附件', listNo: 8, page: 7 },
    ]

    try {
      expect((await client.commit(original)).status).toBe('committed')
      const target = announcementRequest({
        idempotencyKey: 'synthetic/hash-match/new#sha256:same',
        sourceIdentity: targetPath,
        sourceSha256: SAME_SOURCE_SHA,
      })
      target.payload.announcement!.records[0]!.events![0]!.evidence = [
        { sourceFile: targetPath, attachment: '附件', listNo: 8, page: 7 },
      ]

      expect((await client.preflight(target)).preflight.evidenceRepoints).toBe(1)
      expect((await client.commit(target)).summary.evidenceRepointed).toBe(1)
      const evidence = db.select().from(schema.recordEvidence).all()[0]!
      expect(evidence).toMatchObject({ sourceFile: targetPath, page: 7 })

      // 将行复原为计划期旧路径，独立验证显式 replay 仍按两端 SHA 核对。
      db.update(schema.recordEvidence).set({ sourceFile: oldPath }).where(eq(schema.recordEvidence.id, evidence.id)).run()
      const replayed = await client.replay(target)
      expect(replayed.status).toBe('replayed')
      expect(replayed.evidenceRepointed).toBe(1)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([{ sourceFile: targetPath, page: 7 }])
    } finally {
      await server.close()
    }
  })

  it.each([
    ['SHA 不同', 'b'.repeat(64), 'c'.repeat(64), true, true, 'evidence_content_hash_mismatch', false],
    ['目标 SHA 未知', 'd'.repeat(64), 'e'.repeat(64), true, false, 'evidence_content_hash_unknown', false],
    ['旧 SHA 未知且请求 hash 只绑定逻辑来源', 'f'.repeat(64), 'f'.repeat(64), false, true, 'evidence_content_hash_unknown', true],
  ] as const)('旧/目标内容不能证明相同则保留旧出处并返回冲突（%s）', async (_case, oldSha, targetSha, registerOld, registerTarget, errorCode, oldSourceIsLogical) => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const oldPath = `synthetic/hash-conflict/${_case}/old.pdf`
    const targetPath = `synthetic/hash-conflict/${_case}/new.pdf`
    if (registerOld) seedStoredFileHash(db, oldPath, oldSha)
    if (registerTarget) seedStoredFileHash(db, targetPath, targetSha)
    const original = announcementRequest({
      idempotencyKey: `synthetic/hash-conflict/${_case}/old`,
      sourceIdentity: oldSourceIsLogical ? `synthetic/hash-conflict/${_case}/logical-old-source` : oldPath,
      sourceSha256: oldSha,
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: oldPath, attachment: '附件', listNo: 8, page: 7 },
    ]

    try {
      expect((await client.commit(original)).status).toBe('committed')
      const baseline = rosterRowCounts(db)
      const target = announcementRequest({
        idempotencyKey: `synthetic/hash-conflict/${_case}/target`,
        sourceIdentity: registerTarget ? targetPath : `synthetic/hash-conflict/${_case}/logical-source`,
        sourceSha256: targetSha,
      })
      target.payload.announcement!.records[0]!.events![0]!.evidence = [
        { sourceFile: targetPath, attachment: '附件', listNo: 8, page: 7 },
      ]

      const preflight = await client.preflight(target)
      expect(preflight.preflight.evidenceRepoints).toBe(0)
      const committed = await client.commit(target)
      expect(committed.status).toBe('failed')
      expect(committed.items.some((item) => item.error?.code === errorCode)).toBe(true)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([{ sourceFile: oldPath, page: 7 }])
      expect(rosterRowCounts(db)).toEqual(baseline)

      const replayed = await client.replay(target)
      expect(replayed.status).toBe('failed')
      expect(replayed.items.some((item) => item.error?.code === errorCode)).toBe(true)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([{ sourceFile: oldPath, page: 7 }])
      expect(rosterRowCounts(db)).toEqual(baseline)
    } finally {
      await server.close()
    }
  })

  it.each([
    ['B 后 A', ['synthetic/source-b.pdf', 'synthetic/source-a.pdf']],
    ['A 后 B', ['synthetic/source-a.pdf', 'synthetic/source-b.pdf']],
  ] as const)('重复坐标的既有出处按计划只改一次，commit 与 replay 不反向切换（%s）', async (_order, sources) => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    for (const path of ['synthetic/source-a.pdf', 'synthetic/source-b.pdf']) seedStoredFileHash(db, path, SAME_SOURCE_SHA)
    const original = announcementRequest({
      idempotencyKey: 'synthetic/source-a-existing#sha256:stable-content',
      sourceIdentity: 'synthetic/source-a-existing',
      sourceSha256: 'stable-content',
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/source-a.pdf', attachment: '附件', listNo: 7, page: 7 },
    ]

    try {
      await client.commit(original)
      const target = announcementRequest({
        idempotencyKey: 'synthetic/source-b-existing#sha256:stable-content',
        sourceIdentity: 'synthetic/source-b-existing',
        sourceSha256: 'stable-content',
      })
      const event = target.payload.announcement!.records[0]!.events![0]!
      target.payload.announcement!.records[0]!.events = sources.map((sourceFile) => ({
        ...event,
        evidence: [{ sourceFile, attachment: '附件', listNo: 7, page: 7 }],
      }))

      const preflight = await client.preflight(target)
      expect(preflight.preflight.evidenceRepoints).toBe(1)

      const committed = await client.commit(target)
      expect(committed.summary.evidenceRepointed).toBe(1)
      let evidence = db.select().from(schema.recordEvidence).all()
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ sourceFile: 'synthetic/source-b.pdf', page: 7 })

      // 用确定的初态独立核对显式 replay，同时保留提交批次的计划快照。
      db.update(schema.recordEvidence)
        .set({ sourceFile: 'synthetic/source-a.pdf' })
        .where(eq(schema.recordEvidence.id, evidence[0]!.id))
        .run()
      const replayed = await client.replay(target)
      expect(replayed.evidenceRepointed).toBe(1)
      evidence = db.select().from(schema.recordEvidence).all()
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ sourceFile: 'synthetic/source-b.pdf', page: 7 })

      // 同一语义输入换序重放也复用计划快照，不会把旧来源 A 重新写回。
      target.payload.announcement!.records[0]!.events!.reverse()
      const retried = await client.replay(target)
      expect(retried.evidenceRepointed).toBe(0)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([
        { sourceFile: 'synthetic/source-b.pdf', page: 7 },
      ])
    } finally {
      await server.close()
    }
  })

  it.each([
    ['A 后 B', ['synthetic/new-event-a.pdf', 'synthetic/new-event-a.pdf', 'synthetic/new-event-b.pdf']],
    ['B 后 A', ['synthetic/new-event-b.pdf', 'synthetic/new-event-a.pdf', 'synthetic/new-event-a.pdf']],
  ] as const)('同载荷中新事件的重复坐标合并不同来源且去重，顺序无关（%s）', async (_order, sources) => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const enterpriseId = seedEnterprise(db, {
      name: '新事件重复坐标企业',
      uscc: '91330206793007818K',
    })
    const recordId = seedRecord(db, enterpriseId, 'specialized_sme', 'jxj')
    const request = announcementRequest({
      idempotencyKey: `synthetic/new-event-${_order}#sha256:stable-content`,
      sourceIdentity: 'synthetic/new-event-duplicates',
      sourceSha256: 'stable-content',
    })
    const record = request.payload.announcement!.records[0]!
    record.enterprise = { name: '新事件重复坐标企业', uscc: '91330206793007818K' }
    const event = record.events![0]!
    record.events = sources.map((sourceFile) => ({
      ...event,
      evidence: [{ sourceFile, attachment: '附件', listNo: 9, page: 7 }],
    }))

    try {
      const preflight = await client.preflight(request)
      expect(preflight.preflight.evidenceRepoints).toBe(0)

      const committed = await client.commit(request)
      expect(committed.status).toBe('committed')
      expect(db.select().from(schema.record).all().filter((row) => row.enterpriseId === enterpriseId)).toHaveLength(1)
      const events = db.select().from(schema.recordEvent).all().filter((row) => row.recordId === recordId)
      expect(events).toHaveLength(1)
      const evidence = db.select().from(schema.recordEvidence).all().filter((row) => row.recordEventId === events[0]!.id)
      expect(evidence).toHaveLength(2)
      expect(evidence.map(({ sourceFile, page }) => ({ sourceFile, page })).sort((a, b) =>
        a.sourceFile < b.sourceFile ? -1 : a.sourceFile > b.sourceFile ? 1 : 0,
      )).toEqual([
        { sourceFile: 'synthetic/new-event-a.pdf', page: 7 },
        { sourceFile: 'synthetic/new-event-b.pdf', page: 7 },
      ])

      // 同键 commit 与显式 replay 都保持新事件里的完整来源集合。
      const retried = await client.commit(request)
      expect(retried.status).toBe('committed')
      const replayed = await client.replay(request)
      expect(replayed.evidenceRepointed).toBe(0)
      expect(db.select().from(schema.recordEvent).all().filter((row) => row.recordId === recordId)).toHaveLength(1)
      expect(db.select().from(schema.recordEvidence).all().filter((row) => row.recordEventId === events[0]!.id)).toHaveLength(2)
    } finally {
      await server.close()
    }
  })

  it.each([
    ['A 后 B', ['synthetic/repeated-record-a.pdf', 'synthetic/repeated-record-b.pdf']],
    ['B 后 A', ['synthetic/repeated-record-b.pdf', 'synthetic/repeated-record-a.pdf']],
  ] as const)('跨重复 records 项的新事件出处也按整份载荷合并（%s）', async (_order, sources) => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const enterpriseId = seedEnterprise(db, { name: '跨记录新事件企业', uscc: '913302110000000098' })
    const recordId = seedRecord(db, enterpriseId, 'specialized_sme', 'jxj')
    const request = announcementRequest({
      idempotencyKey: `synthetic/repeated-record-${_order}#sha256:stable-content`,
      sourceIdentity: 'synthetic/repeated-record-events',
      sourceSha256: 'stable-content',
    })
    const record = request.payload.announcement!.records[0]!
    record.enterprise = { name: '跨记录新事件企业', uscc: '913302110000000098' }
    const event = record.events![0]!
    request.payload.announcement!.records = sources.map((sourceFile) => ({
      ...record,
      events: [{ ...event, evidence: [{ sourceFile, attachment: '附件', listNo: 10, page: 7 }] }],
    }))

    try {
      expect((await client.preflight(request)).preflight.evidenceRepoints).toBe(0)
      expect((await client.commit(request)).status).toBe('committed')
      expect(db.select().from(schema.record).all().filter((row) => row.enterpriseId === enterpriseId)).toHaveLength(1)
      const events = db.select().from(schema.recordEvent).all().filter((row) => row.recordId === recordId)
      expect(events).toHaveLength(1)
      const evidence = db.select().from(schema.recordEvidence).all().filter((row) => row.recordEventId === events[0]!.id)
      expect(evidence.map(({ sourceFile, page }) => ({ sourceFile, page })).sort((a, b) =>
        a.sourceFile < b.sourceFile ? -1 : a.sourceFile > b.sourceFile ? 1 : 0,
      )).toEqual([
        { sourceFile: 'synthetic/repeated-record-a.pdf', page: 7 },
        { sourceFile: 'synthetic/repeated-record-b.pdf', page: 7 },
      ])
      expect((await client.commit(request)).status).toBe('committed')
      expect(db.select().from(schema.recordEvidence).all().filter((row) => row.recordEventId === events[0]!.id)).toHaveLength(2)
      expect((await client.replay(request)).evidenceRepointed).toBe(0)
      expect(db.select().from(schema.recordEvidence).all().filter((row) => row.recordEventId === events[0]!.id)).toHaveLength(2)
    } finally {
      await server.close()
    }
  })

  it('同路径 no-op 不占用后续目标：预检、commit、replay 同计一行', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    for (const path of ['synthetic/source-a.docx', 'synthetic/source-b.docx']) seedStoredFileHash(db, path, SAME_SOURCE_SHA)
    const original = announcementRequest({
      idempotencyKey: 'synthetic/source-a#sha256:stable-content',
      sourceIdentity: 'synthetic/source-a',
      sourceSha256: 'stable-content',
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/source-a.docx', attachment: '正文', listNo: 1, page: null },
    ]

    try {
      await client.commit(original)
      const target = announcementRequest({
        idempotencyKey: 'synthetic/source-b#sha256:stable-content',
        sourceIdentity: 'synthetic/source-b',
        sourceSha256: 'stable-content',
      })
      const event = target.payload.announcement!.records[0]!.events![0]!
      target.payload.announcement!.records[0]!.events = [
        {
          ...event,
          evidence: [{ sourceFile: 'synthetic/source-a.docx', attachment: '正文', listNo: 1, page: null }],
        },
        {
          ...event,
          evidence: [{ sourceFile: 'synthetic/source-b.docx', attachment: '正文', listNo: 1, page: null }],
        },
      ]

      const preflight = await client.preflight(target)
      expect(preflight.preflight.evidenceRepoints).toBe(1)

      const committed = await client.commit(target)
      expect(committed.summary.evidenceRepointed).toBe(1)
      let evidence = db.select().from(schema.recordEvidence).all()
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ sourceFile: 'synthetic/source-b.docx', page: null })

      // 独立复核显式 replay：把测试行恢复到已知初态后，重放同一份载荷仍计划并执行一行。
      db.update(schema.recordEvidence)
        .set({ sourceFile: 'synthetic/source-a.docx' })
        .where(eq(schema.recordEvidence.id, evidence[0]!.id))
        .run()
      const replayed = await client.replay(target)
      expect(replayed.evidenceRepointed).toBe(1)
      evidence = db.select().from(schema.recordEvidence).all()
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ sourceFile: 'synthetic/source-b.docx', page: null })
    } finally {
      await server.close()
    }
  })

  it('同一出处有多个不同目标路径时按歧义跳过：预检、commit、replay 均不改行', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    for (const path of [
      'synthetic/source-a-conflict.docx',
      'synthetic/source-b-conflict.docx',
      'synthetic/source-c-conflict.docx',
    ]) seedStoredFileHash(db, path, SAME_SOURCE_SHA)
    const original = announcementRequest({
      idempotencyKey: 'synthetic/source-a-conflict#sha256:stable-content',
      sourceIdentity: 'synthetic/source-a-conflict',
      sourceSha256: 'stable-content',
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/source-a-conflict.docx', attachment: '正文', listNo: 1, page: null },
    ]

    try {
      await client.commit(original)
      const target = announcementRequest({
        idempotencyKey: 'synthetic/conflicting-targets#sha256:stable-content',
        sourceIdentity: 'synthetic/conflicting-targets',
        sourceSha256: 'stable-content',
      })
      const event = target.payload.announcement!.records[0]!.events![0]!
      target.payload.announcement!.records[0]!.events = [
        {
          ...event,
          evidence: [{ sourceFile: 'synthetic/source-b-conflict.docx', attachment: '正文', listNo: 1, page: null }],
        },
        {
          ...event,
          evidence: [{ sourceFile: 'synthetic/source-c-conflict.docx', attachment: '正文', listNo: 1, page: null }],
        },
      ]

      const preflight = await client.preflight(target)
      expect(preflight.preflight.evidenceRepoints).toBe(0)
      const committed = await client.commit(target)
      expect(committed.summary.evidenceRepointed).toBe(0)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([
        { sourceFile: 'synthetic/source-a-conflict.docx', page: null },
      ])

      const replayed = await client.replay(target)
      expect(replayed.evidenceRepointed).toBe(0)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([
        { sourceFile: 'synthetic/source-a-conflict.docx', page: null },
      ])
    } finally {
      await server.close()
    }
  })

  it('跨重复记录的不同目标路径也按歧义跳过：计划和两种写入不改行', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    for (const path of [
      'synthetic/source-a-record-conflict.docx',
      'synthetic/source-b-record-conflict.docx',
      'synthetic/source-c-record-conflict.docx',
    ]) seedStoredFileHash(db, path, SAME_SOURCE_SHA)
    const original = announcementRequest({
      idempotencyKey: 'synthetic/source-a-record-conflict#sha256:stable-content',
      sourceIdentity: 'synthetic/source-a-record-conflict',
      sourceSha256: 'stable-content',
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/source-a-record-conflict.docx', attachment: '正文', listNo: 1, page: null },
    ]

    try {
      await client.commit(original)
      const target = announcementRequest({
        idempotencyKey: 'synthetic/conflicting-record-targets#sha256:stable-content',
        sourceIdentity: 'synthetic/conflicting-record-targets',
        sourceSha256: 'stable-content',
      })
      const record = target.payload.announcement!.records[0]!
      const event = record.events![0]!
      const evidence = (sourceFile: string) => [
        { sourceFile, attachment: '正文', listNo: 1, page: 12 },
      ]
      target.payload.announcement!.records = [
        { ...record, events: [{ ...event, evidence: evidence('synthetic/source-b-record-conflict.docx') }] },
        { ...record, events: [{ ...event, evidence: evidence('synthetic/source-c-record-conflict.docx') }] },
      ]

      expect((await client.preflight(target)).preflight.evidenceRepoints).toBe(0)
      expect((await client.commit(target)).summary.evidenceRepointed).toBe(0)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([
        { sourceFile: 'synthetic/source-a-record-conflict.docx', page: null },
      ])

      const replayed = await client.replay(target)
      expect(replayed.evidenceRepointed).toBe(0)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([
        { sourceFile: 'synthetic/source-a-record-conflict.docx', page: null },
      ])
    } finally {
      await server.close()
    }
  })

  it('PDF 出处仍按实际页号精确匹配', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const original = announcementRequest({
      idempotencyKey: 'synthetic/pdf-page-seven#sha256:stable-content',
      sourceIdentity: 'synthetic/pdf-page-seven',
      sourceSha256: 'stable-content',
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/source-a.pdf', attachment: '正文', listNo: 1, page: 7 },
    ]

    try {
      await client.commit(original)
      const target = announcementRequest({
        idempotencyKey: 'synthetic/pdf-page-eight#sha256:stable-content',
        sourceIdentity: 'synthetic/pdf-page-eight',
        sourceSha256: 'stable-content',
      })
      target.payload.announcement!.records[0]!.events![0]!.evidence = [
        { sourceFile: 'synthetic/source-b.pdf', attachment: '正文', listNo: 1, page: 8 },
      ]

      expect((await client.preflight(target)).preflight.evidenceRepoints).toBe(0)
      expect((await client.commit(target)).summary.evidenceRepointed).toBe(0)
      expect((await client.replay(target)).evidenceRepointed).toBe(0)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([
        { sourceFile: 'synthetic/source-a.pdf', attachment: '正文', listNo: 1, page: 7 },
      ])
    } finally {
      await server.close()
    }
  })

  it('非 PDF 页码归一后出处坐标不唯一时不误收敛', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const original = announcementRequest({
      idempotencyKey: 'synthetic/legacy/ambiguous#sha256:stable-content',
      sourceIdentity: 'synthetic/legacy/ambiguous',
      sourceSha256: 'stable-content',
    })
    original.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/legacy/ambiguous-a.docx', attachment: '正文', listNo: 1, page: null },
      { sourceFile: 'synthetic/legacy/ambiguous-b.docx', attachment: '正文', listNo: 1, page: null },
    ]

    try {
      await client.commit(original)
      const seeded = db.select().from(schema.recordEvidence).all()
      expect(seeded.map((row) => row.page)).toEqual([null, null])
      for (const row of seeded) {
        db.update(schema.recordEvidence)
          .set({ page: row.sourceFile.endsWith('ambiguous-a.docx') ? 12 : 13 })
          .where(eq(schema.recordEvidence.id, row.id))
          .run()
      }

      const relinked = announcementRequest({
        idempotencyKey: 'synthetic/library/ambiguous#sha256:stable-content',
        sourceIdentity: 'synthetic/library/ambiguous',
        sourceSha256: 'stable-content',
      })
      relinked.payload.announcement!.records[0]!.events![0]!.evidence = [
        { sourceFile: 'synthetic/library/ambiguous.docx', attachment: '正文', listNo: 1, page: null },
      ]

      const result = await client.replay(relinked)
      expect(result.status).toBe('replayed')
      expect(result.evidenceRepointed).toBe(0)
      expect(db.select().from(schema.recordEvidence).all()).toMatchObject([
        { sourceFile: 'synthetic/legacy/ambiguous-a.docx', page: 12 },
        { sourceFile: 'synthetic/legacy/ambiguous-b.docx', page: 13 },
      ])
    } finally {
      await server.close()
    }
  })

  it('客户端把非 2xx 翻成 RosterImportApiError（带状态码与文案）', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const client = createRosterImportClient({ baseUrl: server.baseUrl, token: 'wrong' })
      await expect(client.commit(announcementRequest())).rejects.toBeInstanceOf(RosterImportApiError)
      await expect(client.commit(announcementRequest())).rejects.toMatchObject({ status: 401 })
    } finally {
      await server.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. MCP 面
// ---------------------------------------------------------------------------

describe('MCP 面：tool 注册与写入名单', () => {
  it('save_roster_batch 在写入名单里；所有名录只读 tool 都不在', () => {
    expect([...MCP_WRITE_TOOLS]).toContain('save_roster_batch')
    for (const name of [
      'preflight_roster_batch',
      'list_enterprises',
      'list_differences',
      'query_records',
      'get_enterprise_detail',
    ]) {
      expect([...MCP_WRITE_TOOLS]).not.toContain(name)
    }
  })


})

// ---------------------------------------------------------------------------
// 7. 平台导出快照写入（对齐 RL-05 的读侧与版本口径）
// ---------------------------------------------------------------------------

describe('导出快照写入', () => {
  function snapshotRequest(over: {
    key: string
    sha: string
    year?: number
    collectedOn?: string
    rows?: Array<{ sourceRowNo: number; nameRaw: string }>
  }): RosterImportRequest {
    return {
      idempotencyKey: over.key,
      sourceKind: 'platform_export',
      sourceIdentity: 'miit/export/专精特新中小企业导出Excel.xlsx',
      payload: {
        exportSnapshot: {
          titleCode: 'specialized_sme',
          // ★ 年度与采集日**由调用方给出**；解析器/写入口都不从文件名或内容推断。
          year: over.year ?? 2026,
          collectedOn: over.collectedOn ?? '2026-10-16',
          originalFilename: '专精特新中小企业导出Excel.xlsx',
          sha256: over.sha,
          rows: (over.rows ?? [
            { sourceRowNo: 3, nameRaw: '甲企业' },
            { sourceRowNo: 4, nameRaw: '乙企业' },
          ]).map((row) => ({
            sourceRowNo: row.sourceRowNo,
            usccRaw: null,
            nameRaw: row.nameRaw,
            rawFields: { '1': row.nameRaw, '18': '' },
          })),
        },
      },
    }
  }

  it('年度 / 采集日原样落库（不推断），行与 importBatchId 指回本批', () => {
    const db = makeDb()
    const result = commitRosterImport(db, snapshotRequest({ key: 'exp/first#sha:1', sha: '1'.repeat(64), year: 2019, collectedOn: '2019-06-30' }))
    expect(result.status, JSON.stringify(result)).toBe('committed')
    const batch = db.select().from(schema.platformExportBatch).all()[0]!
    expect(batch.year).toBe(2019)
    expect(batch.collectedOn).toBe('2019-06-30')
    expect(batch.rowCount).toBe(2)
    expect(batch.replacedBatchId).toBeNull() // 首版
    expect(batch.importBatchId).toBe(result.batchId)
    expect(db.select().from(schema.platformExportRow).all().filter((r) => r.batchId === batch.id)).toHaveLength(2)
  })

  it('★ 版本替换：新批的 replacedBatchId 指向上一个版本的 id；同 sha 重放不新建批', () => {
    const db = makeDb()
    const v1 = commitRosterImport(db, snapshotRequest({ key: 'exp/v1#sha:1', sha: '1'.repeat(64) }))
    const first = db.select().from(schema.platformExportBatch).all().find((b) => b.importBatchId === v1.batchId)!

    // 同内容重放：命中唯一键 (title, year, sha256) ⇒ 不新建批、不重落行。
    const replay = commitRosterImport(db, snapshotRequest({ key: 'exp/v1#sha:1', sha: '1'.repeat(64) }))
    expect(replay.batchId).toBe(v1.batchId)
    expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(1)

    // 换内容 ⇒ 新版本；新批记下「它替换了 v1」。
    const v2 = commitRosterImport(db, snapshotRequest({ key: 'exp/v2#sha:2', sha: '2'.repeat(64) }))
    const second = db.select().from(schema.platformExportBatch).all().find((b) => b.importBatchId === v2.batchId)!
    expect(second.id).not.toBe(first.id)
    expect(second.replacedBatchId).toBe(first.id)
    // 两版并存：旧快照不因替换而消失。
    expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(2)
    expect(db.select().from(schema.platformExportRow).all().filter((r) => r.batchId === first.id)).toHaveLength(2)
  })

  it('同批内源行号唯一：重复行号逐项报错，整批不落库', () => {
    const db = makeDb()
    const result = commitRosterImport(
      db,
      snapshotRequest({ key: 'exp/dup#sha:3', sha: '3'.repeat(64), rows: [{ sourceRowNo: 3, nameRaw: '甲' }, { sourceRowNo: 3, nameRaw: '乙' }] }),
    )
    expect(result.status).toBe('failed')
    expect(result.items[0]!.error!.code).toBe('source_row_no_duplicate')
    expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 8. 大载荷（MB 级导出快照）真实 HTTP 提交
// ---------------------------------------------------------------------------

describe('大载荷：MB 级导出快照经真实 HTTP 提交', () => {
  it('6273 行 × 数十列的载荷能完整收到并落库（实测字节数）', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    try {
      // 实测最大一张导出表 6273 行；rawFields 键 = 1-based 列号字符串、只留非空值。
      const rows = Array.from({ length: 6273 }, (_, i) => {
        const rawFields: Record<string, string> = {}
        for (let col = 1; col <= 30; col += 1) rawFields[String(col)] = `第${i + 1}行的第${col}列取值`
        return {
          sourceRowNo: i + 3,
          usccRaw: `91330211${String(i).padStart(10, '0')}`,
          nameRaw: `第${i + 1}家企业有限公司`,
          province: '浙江省',
          city: '宁波市',
          district: '鄞州区',
          regStatus: '推荐',
          rawFields,
        }
      })
      const body = {
        idempotencyKey: 'exp/large#sha:big',
        sourceKind: 'platform_export' as const,
        sourceIdentity: 'miit/export/专精特新中小企业导出Excel.xlsx',
        payload: {
          exportSnapshot: {
            titleCode: 'specialized_sme',
            year: 2026,
            collectedOn: '2026-10-16',
            originalFilename: '专精特新中小企业导出Excel.xlsx',
            sha256: 'a'.repeat(64),
            rows,
          },
        },
      }
      const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
      // 实测体量：这份载荷是本仓测试里最大的一类（真件 6273 行）。
      expect(bytes).toBeGreaterThan(3_000_000)

      const result = await client.commit(body)
      expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(result.items[0]!.ok).toBe(true)

      const batch = db.select().from(schema.platformExportBatch).all()[0]!
      expect(batch.rowCount).toBe(6273)
      const stored = db.select().from(schema.platformExportRow).all()
      expect(stored).toHaveLength(6273)
      // 整行原始字段完整保留（30 个非空列）。
      expect(Object.keys(stored[0]!.rawFields as Record<string, string>)).toHaveLength(30)
      // 行号从 3 起（两行表头之后），与解析器口径一致。
      expect(Math.min(...stored.map((r) => r.sourceRowNo))).toBe(3)
    } finally {
      await server.close()
    }
  }, 120_000)
})


// ---------------------------------------------------------------------------
// 9b. 批内自然键引用（别名 / 差异 / 归并的证据指针指向本批新建的查询 / 关系）
// ---------------------------------------------------------------------------

describe('批内自然键引用：一批写完「查询 → 关系 → 别名 / 差异 / 归并」', () => {
  /**
   * 一个 payload 同时含 `platformQueries`（含多条 relations）、`aliases`（自然键指本批关系）、
   * `differences`（自然键指本批查询与关系）、`announcement`（企业 + 事件）与 `merges`。
   * 关键：关系/查询的 id 由本批事务内生成，客户端**事前不可能知道** —— 自然键必须在**同一批内**解析。
   */
  const oneBatch = (): RosterImportRequest => ({
    idempotencyKey: 'one-batch/evidence#sha256:x1',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2026/1/一批到底.pdf',
    payload: {
      platformQueries: [
        { rawResponse: 'Explicit synthetic original response',
          interface: 'business_list',
          queryKey: '91330211255994457P',
          rdjb: '3',
          queriedAt: '2026-10-16T03:00:00.000Z',
          status: 'success',
          relations: [
            { sequenceNo: 1, relationKey: 'SQ-1', usccRaw: '91330211255994457P', nameRaw: '宁波上航测绘股份有限公司', matchBasis: 'uscc', verificationStatus: 'confirmed' },
            { sequenceNo: 2, relationKey: 'SQ-2', usccRaw: '91330211255994457P', nameRaw: '宁波上航测绘有限公司', matchBasis: 'alias', verificationStatus: 'confirmed' },
          ],
        },
        { rawResponse: 'Explicit synthetic original response', interface: 'apply_list', queryKey: '91330211255994457P', queriedAt: '2026-10-16T03:01:00.000Z', status: 'no_record' },
      ],
      announcement: {
        sourceDocument: { source: 'jxj', title: '一批到底' },
        records: [
          {
            enterprise: { name: '宁波上航测绘股份有限公司', uscc: '91330211255994457P' },
            titleCode: 'specialized_sme',
            events: [{ eventType: 'award', year: 2022, batchSeq: 2, evidence: [{ sourceFile: 'jxj/announcement/2022/145号.pdf', listNo: 74, page: 74 }] }],
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
          // ★ 指向**本批新建**的关系行（第 2 条）；带 queriedAt 精确匹配。
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
          // ★ 省略 queriedAt ⇒ 靠 (interface, queryKey, rdjb) 唯一命中本批那次查询。
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
  })

  it('★ 一次 commit 完成；证据指针落的是**本批新建行**的真实 id（不是 0 哨兵、不是猜的）', () => {
    const db = makeDb()
    const result = commitRosterImport(db, oneBatch())

    expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(result.error).toBeNull()
    expect(result.summary.failed).toBe(0)
    expect(result.items.every((item) => item.ok)).toBe(true)
    // **只有一个批次** —— 不需要「先写查询、读回 id、再写别名」的两批绕行。
    expect(db.select().from(schema.importBatch).all()).toHaveLength(1)

    const relations = nativeRelationRows(db)
    const rel1 = relations.find((r) => r.relationKey === 'SQ-1')!
    const rel2 = relations.find((r) => r.relationKey === 'SQ-2')!
    const query = nativeQueryRows(db).find((q) => q.interface === 'business_list' && q.rdjb === '3')!

    // 别名：source_ref_id = 本批新建的第 2 条关系的真实 id。
    const canonical = db.select().from(schema.enterprise).all().find((e) => e.usccNorm === '91330211255994457P')!
    const aliases = db.select().from(schema.enterpriseAlias).all().filter((a) => a.enterpriseId === canonical.id && a.name === '宁波上航测绘有限公司')
    expect(aliases).toHaveLength(1)
    expect(aliases[0]!.sourceRefId).toBe(rel2.id)
    expect(aliases[0]!.sourceRefId).not.toBe(0)
    expect(aliases[0]!.verificationStatus).toBe('confirmed')

    // 差异：evidence_query_id / evidence_relation_id 都指向本批新建的行。
    const difference = db.select(differencePublicColumns(db)).from(schema.differenceReason).all()[0]!
    expect(difference.evidenceQueryId).toBe(query.id)
    expect(difference.evidenceRelationId).toBe(rel1.id)

    // 归并：曾用名的来源关系解析成同一条真实关系；血缘里的查询证据也是真实 id。
    const mergeItem = result.items.find((item) => item.kind === 'merge')!
    const lineage = mergeItem.detail!.lineage as { aliasId: number; evidenceQueryId: number | null; fromEnterpriseId: number }
    expect(lineage.aliasId).toBe(aliases[0]!.id)
    expect(lineage.evidenceQueryId).toBe(query.id)

    // 归并保留原身份映射；称号、事件和出处完整归入规范企业。
    expect(db.select().from(schema.enterpriseMerge).all()).toEqual(expect.arrayContaining([expect.objectContaining({fromEnterpriseId:lineage.fromEnterpriseId,intoEnterpriseId:canonical.id})]))
    expect(db.select().from(schema.record).all().filter((r) => r.enterpriseId === canonical.id).map((r) => r.titleCode).sort()).toEqual(['innovative_sme', 'specialized_sme'])
    expect(db.select().from(schema.recordEvidence).all()[0]!.page).toBe(74)

    // 血缘可从批次行查回（父代理裁决 #4）。
    const replayedLineage = readMergeLineage(db, 'one-batch/evidence#sha256:x1', lineage.fromEnterpriseId)!
    expect(replayedLineage.evidenceQueryId).toBe(query.id)
  })

  it('★ 自然键解析不到 ⇒ 整批 failed，业务数据一行不落，逐项报错', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)

    // (a) 关系序号不存在
    const missingSeq = oneBatch()
    missingSeq.idempotencyKey = 'one-batch/missing-seq#sha256:x2'
    ;(missingSeq.payload.aliases![0] as { sourceRelationRef: { sequenceNo: number } }).sourceRelationRef.sequenceNo = 99
    const a = commitRosterImport(db, missingSeq)
    expect(a.status).toBe('failed')
    expect(a.items.find((item) => !item.ok)!.error!.code).toBe('relation_ref_not_found')
    expect(rosterRowCounts(db)).toEqual(before)

    // (b) 查询键根本不存在
    const missingQuery = oneBatch()
    missingQuery.idempotencyKey = 'one-batch/missing-query#sha256:x3'
    ;(missingQuery.payload.differences![0] as { evidenceQueryRef: { queryKey: string } }).evidenceQueryRef.queryKey = '91330211000000000Z'
    const b = commitRosterImport(db, missingQuery)
    expect(b.status).toBe('failed')
    expect(b.items.some((item) => item.error?.code === 'query_ref_not_found')).toBe(true)
    expect(rosterRowCounts(db)).toEqual(before)

    // (c) 关系引用缺 sequenceNo
    const noSeq = oneBatch()
    noSeq.idempotencyKey = 'one-batch/no-seq#sha256:x4'
    delete (noSeq.payload.differences![0] as { evidenceRelationRef?: unknown }).evidenceRelationRef
    ;(noSeq.payload.differences![0] as unknown as { evidenceRelationRef: Record<string, unknown> }).evidenceRelationRef = { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3' }
    const c = commitRosterImport(db, noSeq)
    expect(c.status).toBe('failed')
    expect(c.items.some((item) => item.error?.code === 'ref_sequence_no_required')).toBe(true)
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it('裸 id 与自然键同时给 ⇒ 逐项报错（不静默取一个）', () => {
    const db = makeDb()
    const request = oneBatch()
    request.idempotencyKey = 'one-batch/conflict#sha256:x5'
    ;(request.payload.aliases![0] as { sourceRefId?: number }).sourceRefId = 7
    const result = commitRosterImport(db, request)
    expect(result.status).toBe('failed')
    expect(result.items.find((i) => !i.ok)!.error!.code).toBe('source_ref_conflict')
    expect(rosterRowCounts(db).enterprise).toBe(0)

    const request2 = oneBatch()
    request2.idempotencyKey = 'one-batch/conflict2#sha256:x6'
    ;(request2.payload.differences![0] as { evidenceRelationId?: number }).evidenceRelationId = 3
    const result2 = commitRosterImport(db, request2)
    expect(result2.status).toBe('failed')
    expect(result2.items.some((i) => i.error?.code === 'evidence_ref_conflict')).toBe(true)
  })

  it('★ 自然键不含时点时要求唯一：同 (interface, queryKey, rdjb) 两次查询 ⇒ 逐项报错', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)
    const request = oneBatch()
    request.idempotencyKey = 'one-batch/ambiguous#sha256:x7'
    // 再插一次同 (interface, queryKey, rdjb) 但不同 queriedAt 的查询（含同样的序号 2）。
    request.payload.platformQueries!.push({ rawResponse: 'Explicit synthetic original response',
      interface: 'business_list',
      queryKey: '91330211255994457P',
      rdjb: '3',
      queriedAt: '2026-10-17T03:00:00.000Z',
      status: 'success',
      relations: [{ sequenceNo: 2, relationKey: 'SQ-2b', usccRaw: '91330211255994457P', nameRaw: '宁波上航测绘有限公司' }],
    })
    const result = commitRosterImport(db, request)
    expect(result.status).toBe('failed')
    // 别名那次引用带了 queriedAt ⇒ 不歧义；差异/归并省略了 queriedAt ⇒ 歧义。
    expect(result.items.some((i) => i.error?.code === 'relation_ref_ambiguous' || i.error?.code === 'query_ref_ambiguous')).toBe(true)
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it('兼容：显式裸 id 继续可用（指向支持该统代与 qymc 的**已存在**行）', () => {
    const db = makeDb()
    const canonical = seedEnterprise(db, { name: '宁波显式企业有限公司', uscc: '9133021100000000E1' })
    const relationId = seedPlatformRelation(db, {
      queryKey: '9133021100000000E1',
      usccRaw: '9133021100000000E1',
      nameRaw: '宁波显式旧名有限公司',
    })
    const result = commitRosterImport(db, {
      idempotencyKey: 'literal-id#sha256:x8',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'miit/relations/literal',
      payload: {
        aliases: [
          {
            uscc: '9133021100000000E1',
            name: '宁波显式旧名有限公司',
            sourceKind: 'platform_business',
            sourceRefId: relationId,
            verificationStatus: 'confirmed',
          },
          // 不给来源 ⇒ 契约 §1.2 的 0 哨兵（「无具体来源行引用」）。
          { uscc: '9133021100000000E1', name: '宁波无来源旧名', sourceKind: 'manual', verificationStatus: 'confirmed' },
        ],
      },
    })
    expect(result.status, JSON.stringify(result)).toBe('committed')
    const rows = db.select().from(schema.enterpriseAlias).all().filter((a) => a.enterpriseId === canonical)
    expect(rows.find((a) => a.name === '宁波显式旧名有限公司')!.sourceRefId).toBe(relationId)
    expect(rows.find((a) => a.name === '宁波无来源旧名')!.sourceRefId).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 10. 读面（list_enterprises / list_differences）
// ---------------------------------------------------------------------------

describe('读面：list_enterprises / list_differences', () => {
  it('企业总表去重、按现名与已确认曾用名都能搜到、未确认别名不命中', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    try {
      await client.commit({
        idempotencyKey: 'read/enterprises#sha256:r1',
        sourceKind: 'announcement',
        sourceIdentity: 'jxj/announcement/2026/1/读面.pdf',
        payload: {
          announcement: {
            sourceDocument: { source: 'jxj', title: '读面' },
            records: [
              { enterprise: { name: '宁波读面企业有限公司', uscc: '913302110000000098', district: '鄞州区' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021, batchSeq: 1 }] },
              { enterprise: { name: '宁波仅平台企业' }, titleCode: 'innovative_sme', events: [] },
            ],
          },
          aliases: [
            {
              enterpriseName: '宁波读面企业有限公司',
              name: '宁波读面旧名',
              sourceKind: 'platform_business',
              verificationStatus: 'confirmed',
              sourceRelationRef: {
                interface: 'business_list',
                queryKey: '913302110000000098',
                rdjb: '3',
                queriedAt: '2026-10-17T06:00:00.000Z',
                sequenceNo: 1,
              },
            },
            { enterpriseName: '宁波读面企业有限公司', name: '宁波读面未核别名', sourceKind: 'platform_apply', verificationStatus: 'pending' },
          ],
          platformQueries: [{ rawResponse: 'Explicit synthetic original response',
            interface: 'business_list',
            queryKey: '913302110000000098',
            rdjb: '3',
            queriedAt: '2026-10-17T06:00:00.000Z',
            status: 'success',
            relations: [{
              sequenceNo: 1,
              relationKey: 'SQ-read-alias',
              usccRaw: '913302110000000098',
              nameRaw: '宁波读面旧名',
              matchBasis: 'uscc',
              verificationStatus: 'confirmed',
            }],
          }],
        },
      })

      const all = listEnterprises(db, {})
      expect(all.counts.total).toBe(2)
      const target = all.rows.find((r) => r.name === '宁波读面企业有限公司')!
      expect(target.uscc).toBe('913302110000000098')
      expect(target.district).toBe('鄞州区')
      expect(target.rosterState).toBe('current')
      expect(target.titles).toEqual(['specialized_sme'])
      expect(target.aliasNames).toEqual(['宁波读面旧名'])

      // 只有平台侧记录且没有导出快照 ⇒ 无法证明已移除，按完整读模型保留为 current。
      expect(all.rows.find((r) => r.name === '宁波仅平台企业')!.rosterState).toBe('current')

      expect(listEnterprises(db, { q: '宁波读面旧名' }).rows.map((r) => r.name)).toEqual(['宁波读面企业有限公司'])
      expect(listEnterprises(db, { q: '宁波读面未核别名' }).rows).toEqual([])
      expect(listEnterprises(db, { district: '鄞州区' }).counts.total).toBe(1)
      expect(listEnterprises(db, { title: 'innovative_sme' }).rows.map((r) => r.name)).toEqual(['宁波仅平台企业'])
    } finally {
      await server.close()
    }
  })

  it('差异取「当前解释」（recordedAt 最新），原因与措施成对', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    try {
      await client.commit({
        idempotencyKey: 'read/differences#sha256:r2',
        sourceKind: 'alias_evidence',
        sourceIdentity: 'miit/relations/r2',
        payload: {
          platformQueries: [
            { rawResponse: 'Explicit synthetic original response', interface: 'apply_list', queryKey: '91330206793007818K', queriedAt: '2026-10-16T07:00:00.000Z', status: 'success' },
          ],
          announcement: {
            sourceDocument: { source: 'jxj', title: '读面差异' },
            records: [{ enterprise: { name: '宁波差异企业', uscc: '91330206793007818K' }, titleCode: 'specialized_sme', events: [] }],
          },
          differences: [
            { enterpriseName: '宁波差异企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'no_record', recordedAt: '2026-10-15T08:00:00.000Z' },
            { enterpriseName: '宁波差异企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'moved_out', measureCode: 'mark_moved_out', verificationStatus: 'confirmed', recordedAt: '2026-10-16T08:00:00.000Z' },
          ],
        },
      })

      const differences = listDifferences(db, { title: 'specialized_sme' })
      expect(differences.rows).toHaveLength(1)
      const row = differences.rows[0]!
      expect(row.status).toBe('confirmed_reason')
      expect(row.reasonCode).toBe('moved_out')
      expect(row.measureCode).toBe('mark_moved_out')
      expect(row.recordedAt).toBe('2026-10-16T08:00:00.000Z')
      expect(differences.counts.specialized_sme!.missing_in_miit).toBe(1)
      // 旧解释仍在库里（时态化不丢）。
      expect(db.select(differencePublicColumns(db)).from(schema.differenceReason).all()).toHaveLength(2)
    } finally {
      await server.close()
    }
  })
})


describe('用户明确裁决的待审核', () => {
  it('HTTP预检提交重放后MCP读回待审核，保留历史和旧解释且可独立筛选', async () => {
    const db = makeDb()
    const request = announcementRequest({ idempotencyKey: 'synthetic/pending-review/history' })
    const history = request.payload.announcement!.records[0]!
    history.events = [{ eventType: 'award', year: 2023, batchSeq: 2, evidence: history.events![0]!.evidence }]
    await withRosterHttp(db, client => client.commit(request))
    const name = request.payload.announcement!.records[0]!.enterprise.name
    const uscc = request.payload.announcement!.records[0]!.enterprise.uscc
    const old = boundaryRequest('synthetic/pending-review/old', { differences: [{ enterpriseName: name, uscc, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', reasonCode: null, measureCode: 'manual_review', verificationStatus: 'pending', recordedAt: '2026-10-17T00:00:00.000Z' }] })
    await withRosterHttp(db, client => client.commit(old))
    const events = db.select().from(schema.recordEvent).all()
    const current = boundaryRequest('synthetic/pending-review/confirmed', { differences: [{ ...old.payload.differences![0]!, status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', verificationStatus: 'confirmed', reasonNote: '用户确认：同称号历史终审通过，最新更新待审核，当前导出缺失；原三接口引用保留。', recordedAt: '2026-10-18T00:00:00.000Z' }] })
    await withRosterHttp(db, async client => {
      const preflight = await client.preflight(current)
      expect(preflight.preflight.conflicts).toEqual([])
      expect(db.select(differencePublicColumns(db)).from(schema.differenceReason).all()).toHaveLength(1)
      expect((await client.commit(current)).status).toBe('committed')
      expect((await client.commit(current)).status).toBe('committed')
    })
    expect(db.select().from(schema.recordEvent).all()).toEqual(events)
    expect(db.select(differencePublicColumns(db)).from(schema.differenceReason).all()).toHaveLength(2)
    const readback = listDifferences(db, { status: 'confirmed_reason' })
    expect(readback.rows).toHaveLength(1)
    expect(readback.rows[0]).toMatchObject({ status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', verificationStatus: 'confirmed' })
    expect(listDifferences(db, { status: 'needs_review' }).rows).toHaveLength(0)
  })

  it.each([
    { status: 'needs_review', verificationStatus: 'confirmed', measureCode: 'follow_review' },
    { status: 'confirmed_reason', verificationStatus: 'pending', measureCode: 'follow_review' },
    { status: 'confirmed_reason', verificationStatus: 'confirmed', measureCode: 'manual_review' },
  ] as const)('拒绝不完整待审核裁决 $status/$verificationStatus/$measureCode', async patch => {
    const db = makeDb()
    seedEnterprise(db, { name: '合成待审核校验企业' })
    const request = boundaryRequest('synthetic/pending-review/invalid', { differences: [{ enterpriseName: '合成待审核校验企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', reasonCode: 'pending_review', recordedAt: '2026-10-18T00:00:00.000Z', ...patch }] })
    const result = await withRosterHttp(db, client => client.commit(request))
    expect(result.status).toBe('failed')
    expect(db.select(differencePublicColumns(db)).from(schema.differenceReason).all()).toEqual([])
  })
})
