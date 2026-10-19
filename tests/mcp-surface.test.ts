import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_WRITE_TOOLS,
  readMcpToken,
  resolveMcpAuth,
  tokenMatches,
  unauthorizedMessage,
  writeToolCallIn,
} from '../server/utils/mcp-auth'
import {
  __resetFileStoreReady,
  ensureFileStoreReady,
  findFileIdByRelPath,
  pageImagesForAgent,
  resolveFileRef,
  setFileCategoryForAgent,
} from '../server/utils/mcp-files'
import { applyParseResult, normalizeParseParts } from '../server/utils/parse-result'
import { getStoredFile, listStoredFiles } from '../server/utils/stored-files'

/**
 * 票 18 —— 把 app 的能力暴露成 **MCP**。
 *
 * 这里测的是**能被测的那一层**:鉴权判据、文件引用解析、解析结果写回、懒回填。
 * tool 文件本身只是「声明 + 转发」(每个能力一个文件,模块的要求),一行业务判断都没有;
 * 它们的端到端验收(`tools/list` 的实际输出、401 的状态码、`/files` 页读回)走**真实服务**,
 * 证据写在票里。
 *
 * 真实形状的种子(192号 = 认定 2024/2 附件1 + 复核 2021/2 附件2,389/67 行)沿用
 * `tests/file-parts.test.ts` 的口径 —— 断言里的数字就是台账里的数字。
 */

// ---------------------------------------------------------------------------
// 1. 鉴权判据(纯函数)
// ---------------------------------------------------------------------------

describe('mcp-auth 鉴权判据', () => {
  it('写入 tool 名单就是这几个 —— 新增写入口必须同时改这里', () => {
    // 这条断言是**防走神**用的:名单是「哪些调用会被要求鉴权」的唯一来源,
    // 悄悄加一个写入 tool 而不改它,就是开了一条绕过鉴权的写路。
    // 票 18 的三个 + RL-11 的名录统一写入(`save_roster_batch`)。
    expect([...MCP_WRITE_TOOLS]).toEqual([
      'maintain_enterprise_alias',
      'save_ocr_result',
      'set_file_category',
      'update_file',
      'remove_file',
      'restore_file',
      'save_parse_result',
      'save_roster_batch',
      'submit_platform_batch',
      'retry_platform_batch',
      'preflight_record_correspondences',
      'save_record_correspondences',
      'preflight_event_corrections',
      'commit_event_corrections',
      'get_record_correspondence_batch',
      'preflight_comparison_scope_proofs',
      'commit_comparison_scope_proofs',
      'get_comparison_scope_proof_batch',
      'patch_enterprise_profile',
    ])
  })

  it('RL-11:名录写入 tool 是写入、只读预检不是', () => {
    const call = (name: string) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    })
    expect(writeToolCallIn(call('save_roster_batch'))).toBe('save_roster_batch')
    expect(writeToolCallIn(call('preflight_comparison_scope_proofs'))).toBe('preflight_comparison_scope_proofs')
    expect(writeToolCallIn(call('commit_comparison_scope_proofs'))).toBe('commit_comparison_scope_proofs')
    expect(writeToolCallIn(call('get_comparison_scope_proof_batch'))).toBe('get_comparison_scope_proof_batch')
    // 只读预检按契约 §9 归为读 tool —— 不在此列(但仍不改业务数据)。
    expect(writeToolCallIn(call('preflight_roster_batch'))).toBeNull()
    expect(writeToolCallIn(call('list_enterprises'))).toBeNull()
    expect(writeToolCallIn(call('list_differences'))).toBeNull()
  })

  it('readMcpToken 认 Bearer / 裸 token / X-MCP-Token,取不到给 null', () => {
    expect(readMcpToken({ authorization: 'Bearer abc123' })).toBe('abc123')
    expect(readMcpToken({ authorization: 'bearer abc123' })).toBe('abc123') // 大小写不敏感
    expect(readMcpToken({ authorization: 'abc123' })).toBe('abc123') // 裸 token(调试客户端常这么发)
    expect(readMcpToken({ 'x-mcp-token': 'abc123' })).toBe('abc123')
    expect(readMcpToken({ authorization: 'Bearer abc123', 'x-mcp-token': 'zzz' })).toBe('abc123')
    // 取不到:没有头 / 空串 / 只有 Bearer 前缀。
    expect(readMcpToken(undefined)).toBeNull()
    expect(readMcpToken({})).toBeNull()
    expect(readMcpToken({ authorization: '' })).toBeNull()
    expect(readMcpToken({ authorization: '   ' })).toBeNull()
    expect(readMcpToken({ authorization: 'Bearer' })).toBeNull()
    expect(readMcpToken({ authorization: 'Bearer   ' })).toBeNull()
  })

  it('tokenMatches:相等才算匹配;空串一律不匹配', () => {
    expect(tokenMatches('s3cret', 's3cret')).toBe(true)
    expect(tokenMatches('s3cret', 'other')).toBe(false)
    // 「配了个空串」不该等于「人人可写」。
    expect(tokenMatches('', '')).toBe(false)
    expect(tokenMatches(null, 's3cret')).toBe(false)
    expect(tokenMatches('s3cret', null)).toBe(false)
    expect(tokenMatches('s3cret', '')).toBe(false)
  })

  it('resolveMcpAuth 把「没配 / 没带 / 带错 / 带对」分得开', () => {
    expect(resolveMcpAuth({ given: null, configured: '' })).toEqual({
      writeAuthorized: false,
      reason: 'no-token-configured',
    })
    expect(resolveMcpAuth({ given: null, configured: undefined })).toEqual({
      writeAuthorized: false,
      reason: 'no-token-configured',
    })
    expect(resolveMcpAuth({ given: null, configured: 's3cret' })).toEqual({
      writeAuthorized: false,
      reason: 'token-missing',
    })
    expect(resolveMcpAuth({ given: 'wrong', configured: 's3cret' })).toEqual({
      writeAuthorized: false,
      reason: 'token-invalid',
    })
    expect(resolveMcpAuth({ given: 's3cret', configured: 's3cret' })).toEqual({
      writeAuthorized: true,
      reason: 'authorized',
    })
    // 服务端没配时,即便请求带了 token 也不放行(写入整体关闭)。
    expect(resolveMcpAuth({ given: 'anything', configured: '' }).writeAuthorized).toBe(false)
  })

  it('writeToolCallIn 只认写入 tool 的 tools/call', () => {
    const call = (name: string) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    })
    expect(writeToolCallIn(call('set_file_category'))).toBe('set_file_category')
    expect(writeToolCallIn(call('save_parse_result'))).toBe('save_parse_result')
    // 只读 tool 不算。
    expect(writeToolCallIn(call('list_files'))).toBeNull()
    expect(writeToolCallIn(call('list_page_images'))).toBeNull()
    // 不是 tools/call 不算。
    expect(writeToolCallIn({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBeNull()
    // 批量数组也认(报文格式允许,漏掉就等于漏一条路)。
    expect(writeToolCallIn([call('list_files'), call('save_ocr_result')])).toBe('save_ocr_result')
    expect(writeToolCallIn([call('list_files')])).toBeNull()
    // 读不出来的当「不是写入」—— 交给 tool 自己的守卫兜底,不误判只读请求。
    expect(writeToolCallIn(null)).toBeNull()
    expect(writeToolCallIn('not json')).toBeNull()
    expect(writeToolCallIn({ method: 'tools/call' })).toBeNull()
    expect(writeToolCallIn({ method: 'tools/call', params: { name: 42 } })).toBeNull()
  })

  it('拒绝文案说清是哪一种没带', () => {
    expect(unauthorizedMessage('set_file_category', 'no-token-configured')).toContain('NUXT_MCP_TOKEN')
    expect(unauthorizedMessage('set_file_category', 'token-missing')).toContain('未带 token')
    expect(unauthorizedMessage('set_file_category', 'token-invalid')).toContain('不匹配')
  })
})

// ---------------------------------------------------------------------------
// 2. 文件引用解析(纯函数 + Db)
// ---------------------------------------------------------------------------

const REL_PDF = 'jxj/announcement/2024/2/甬经信中小〔2024〕192号关于公布2024年第二批认定及2021年第二批到期复核通过宁波市“专精特新”中小企业名单的通知.pdf'
const REL_XLSX = 'miit/export/创新型中小企业导出Excel.xlsx'
const REL_REMOVED = 'jxj/announcement/2023/1/已移出的文件.pdf'

let dir: string
let db: ReturnType<(typeof import('../db'))['useDb']>
let schema: typeof import('../db')['schema']

function seedFile(
  relPath: string,
  over: Partial<{ year: number; batch: number; removedAt: string; categoryState: string }> = {},
): number {
  const segments = relPath.split('/')
  const miit = relPath.startsWith('miit')
  return db
    .insert(schema.storedFile)
    .values({
      relPath,
      filename: segments[segments.length - 1]!,
      ext: miit ? 'xlsx' : 'pdf',
      bytes: 1,
      sha256: 'b'.repeat(64),
      source: miit ? 'miit' : 'jxj',
      kind: miit ? 'export' : 'announcement',
      year: over.year ?? null,
      batch: over.batch ?? null,
      categoryState: (over.categoryState as 'set' | 'inferred' | 'unset') ?? 'set',
      removedAt: over.removedAt ?? null,
    })
    .returning({ id: schema.storedFile.id })
    .get().id
}

let seq = 0
function seedEvidence(o: {
  relPath: string
  titleCode: string
  eventKind: 'award' | 'review' | 'maintain' | 'nurture'
  year: number | null
  batch: number | null
  attachment: string | null
  rows: number
}) {
  seq += 1
  const enterpriseId = db
    .insert(schema.enterprise)
    .values({ name: `企业${seq}`, nameNorm: `企业${seq}` })
    .returning({ id: schema.enterprise.id })
    .get().id
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId, titleCode: o.titleCode, source: 'jxj' })
    .returning({ id: schema.record.id })
    .get().id
  const eventId = db
    .insert(schema.recordEvent)
    .values({ recordId, eventType: o.eventKind, year: o.year, batchSeq: o.batch })
    .returning({ id: schema.recordEvent.id })
    .get().id
  db.insert(schema.recordEvidence)
    .values(
      Array.from({ length: o.rows }, () => ({
        recordEventId: eventId,
        sourceFile: o.relPath,
        attachment: o.attachment,
      })),
    )
    .run()
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-mcp-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  const mod = await import('../db')
  schema = mod.schema
  db = mod.useDb()

  // 三个基线文件:192号(PDF,公布 2024/2)、工信部导出(非 PDF)、一份已移出库的。
  seedFile(REL_PDF, { year: 2024, batch: 2 })
  seedFile(REL_XLSX)
  seedFile(REL_REMOVED, { year: 2023, batch: 1, removedAt: '2026-10-14T00:00:00.000Z' })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveFileRef 指一个文件', () => {
  it('id 与 relPath 恰给其一:混给或都不给都是错', () => {
    const both = resolveFileRef(db, { fileId: 1, relPath: REL_PDF })
    expect(both.ok).toBe(false)
    expect(both.ok === false && both.message).toContain('只能给一个')

    const neither = resolveFileRef(db, {})
    expect(neither.ok).toBe(false)
    expect(neither.ok === false && neither.message).toContain('必须给')
  })

  it('按 id / 按 relPath 都能取到同一个文件', () => {
    const byPath = resolveFileRef(db, { relPath: REL_PDF })
    expect(byPath.ok).toBe(true)
    if (!byPath.ok) return
    const byId = resolveFileRef(db, { fileId: byPath.row.id })
    expect(byId.ok).toBe(true)
    if (!byId.ok) return
    expect(byId.row.relPath).toBe(REL_PDF)
    expect(byId.row.id).toBe(byPath.row.id)
  })

  it('不存在的文件给中文原因,不是抛异常', () => {
    const byId = resolveFileRef(db, { fileId: 999999 })
    expect(byId.ok).toBe(false)
    expect(byId.ok === false && byId.message).toContain('文件不存在')
    const byPath = resolveFileRef(db, { relPath: 'jxj/announcement/2024/1/没有这个.pdf' })
    expect(byPath.ok).toBe(false)
    expect(byPath.ok === false && byPath.message).toContain('文件不存在')
  })

  it('非法 id 被挡在查库之前', () => {
    for (const bad of [0, -1, 1.5]) {
      const r = resolveFileRef(db, { fileId: bad })
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.message).toContain('正整数')
    }
  })

  it('已移出库的文件:读认(allowRemoved),写不认(默认)', () => {
    expect(resolveFileRef(db, { relPath: REL_REMOVED }).ok).toBe(false)
    const read = resolveFileRef(db, { relPath: REL_REMOVED }, { allowRemoved: true })
    expect(read.ok).toBe(true)
    expect(read.ok === true && read.row.removedAt).not.toBeNull()
  })

  it('findFileIdByRelPath 取不到给 null(不猜)', () => {
    expect(findFileIdByRelPath(db, REL_PDF)).toBeTypeOf('number')
    expect(findFileIdByRelPath(db, 'nope/nope.txt')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. 解析结果写回(save_parse_result 的落点)
// ---------------------------------------------------------------------------

describe('save_parse_result 的写入逻辑', () => {
  it('normalizeParseParts:附件名归一 + 排序', () => {
    const r = normalizeParseParts([
      {
        titleCode: 'specialized_sme',
        eventKind: 'review',
        year: 2021,
        batch: 2,
        attachment: '附 件 2',
        rowCount: 67,
      },
      {
        titleCode: 'specialized_sme',
        eventKind: 'award',
        year: 2024,
        batch: 2,
        attachment: '附 件 1',
        rowCount: 389,
      },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 归一:两种写法都收成「附件N」。
    expect(r.parts.map((p) => p.attachment)).toEqual(['附件1', '附件2'])
    // 排序:认定在前、复核在后(compareParts 的口径)。
    expect(r.parts.map((p) => p.eventKind)).toEqual(['award', 'review'])
    expect(r.parts.map((p) => p.rowCount)).toEqual([389, 67])
  })

  it('normalizeParseParts:同坐标给两遍报错(不自动合并)', () => {
    const part = {
      titleCode: 'specialized_sme',
      eventKind: 'award' as const,
      year: 2024,
      batch: 2,
      attachment: '附件1',
    }
    const r = normalizeParseParts([part, { ...part, attachment: '附 件 1', rowCount: 5 }])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('重复')
  })

  it('normalizeParseParts:称号 / 事件 / 年份 / 批次 / 行数都在白名单内', () => {
    const bad = [
      { titleCode: '不存在', eventKind: 'award' },
      { titleCode: 'specialized_sme', eventKind: '不存在' },
      { titleCode: 'specialized_sme', eventKind: 'award', year: 1234 },
      { titleCode: 'specialized_sme', eventKind: 'award', batch: 0 },
      { titleCode: 'specialized_sme', eventKind: 'award', rowCount: -1 },
    ]
    for (const p of bad) {
      const r = normalizeParseParts([p as never])
      expect(r.ok).toBe(false)
    }
    // 合法:年份/批次可空(导出表无附件、部分维护批次无年份)。
    const ok = normalizeParseParts([
      { titleCode: 'innovative_sme', eventKind: 'maintain', year: null, batch: null, attachment: null },
    ])
    expect(ok.ok).toBe(true)
  })

  it('applyParseResult 全量替换段,并置 parse_state=parsed', () => {
    const fileId = seedFile('jxj/announcement/2026/1/写解析结果.pdf', { year: 2026, batch: 1 })
    const r = applyParseResult(db, fileId, {
      parts: [
        { titleCode: 'specialized_sme', eventKind: 'award', year: 2026, batch: 1, attachment: '附件1', rowCount: 10 },
        { titleCode: 'specialized_sme', eventKind: 'review', year: 2023, batch: 1, attachment: '附件2', rowCount: 3 },
      ],
    })
    expect(r.ok).toBe(true)
    expect(getStoredFile(db, fileId)?.parseState).toBe('parsed')
    expect(getStoredFile(db, fileId)?.parts).toHaveLength(2)

    // 再写一次(只留一段):**全量替换**,旧的两段都不该剩。
    const again = applyParseResult(db, fileId, {
      parts: [
        { titleCode: 'specialized_sme', eventKind: 'award', year: 2026, batch: 1, attachment: '附件1', rowCount: 10 },
      ],
    })
    expect(again.ok).toBe(true)
    expect(getStoredFile(db, fileId)?.parts).toHaveLength(1)

    // 空数组 = 这份文件没有段(不是「不改」)。
    const cleared = applyParseResult(db, fileId, { parts: [] })
    expect(cleared.ok).toBe(true)
    expect(getStoredFile(db, fileId)?.parts).toHaveLength(0)
  })

  it('applyParseResult 可以只改 parse_state', () => {
    const fileId = seedFile('jxj/announcement/2026/1/只改状态.pdf', { year: 2026, batch: 1 })
    const r = applyParseResult(db, fileId, { parseState: 'failed' })
    expect(r.ok).toBe(true)
    expect(getStoredFile(db, fileId)?.parseState).toBe('failed')
  })

  it('既没给 parts 也没给 parseState、或状态不在白名单 → 报错', () => {
    const fileId = seedFile('jxj/announcement/2026/1/坏参数.pdf', { year: 2026, batch: 1 })
    const empty = applyParseResult(db, fileId, {})
    expect(empty.ok).toBe(false)
    expect(empty.ok === false && empty.message).toContain('至少给')
    const bad = applyParseResult(db, fileId, { parseState: 'whatever' })
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.message).toContain('白名单')
  })

  it('★ 边界:写解析结果**不碰** record / enterprise / record_evidence', () => {
    // 票 18 的硬约束:MCP 只碰文件元数据 / 解析结果 / OCR 结果;
    // 身份归并与回填只能走 pipeline(见 data-integrity 的安全阀)。
    const fileId = seedFile('jxj/announcement/2026/1/边界.pdf', { year: 2026, batch: 1 })
    const before = {
      record: db.select().from(schema.record).all().length,
      enterprise: db.select().from(schema.enterprise).all().length,
      evidence: db.select().from(schema.recordEvidence).all().length,
      event: db.select().from(schema.recordEvent).all().length,
    }
    const r = applyParseResult(db, fileId, {
      parts: [
        { titleCode: 'little_giant', eventKind: 'award', year: 2026, batch: 1, attachment: '附件1', rowCount: 7 },
      ],
    })
    expect(r.ok).toBe(true)
    expect({
      record: db.select().from(schema.record).all().length,
      enterprise: db.select().from(schema.enterprise).all().length,
      evidence: db.select().from(schema.recordEvidence).all().length,
      event: db.select().from(schema.recordEvent).all().length,
    }).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// 4. set_file_category 的写入逻辑(票 12 的代理通路)
// ---------------------------------------------------------------------------

describe('set_file_category 的写入逻辑', () => {
  it('写回分类,并把 categoryState 从 unset 升为 set', () => {
    const relPath = 'jxj/announcement/2026/2/待分类.pdf'
    const id = seedFile(relPath, { categoryState: 'unset' })
    const r = setFileCategoryForAgent(db, { fileId: id }, { source: 'jxj', kind: 'announcement', year: 2026, batch: 2 })
    expect(r.ok).toBe(true)
    expect(r.ok === true && r.row.year).toBe(2026)
    expect(r.ok === true && r.row.batch).toBe(2)
    expect(r.ok === true && r.row.categoryState).toBe('set')
  })

  it('null 是「清空」,不是「不改」', () => {
    const id = seedFile('jxj/announcement/2026/2/清空.pdf', { year: 2026, batch: 2 })
    const r = setFileCategoryForAgent(db, { fileId: id }, { year: null })
    expect(r.ok).toBe(true)
    expect(r.ok === true && r.row.year).toBeNull()
    // 分类由全到缺 → 退回 unset。
    expect(r.ok === true && r.row.categoryState).toBe('unset')
  })

  it('磁盘事实字段被拒(不能借「改元数据」改路径)', () => {
    const id = seedFile('jxj/announcement/2026/2/磁盘事实.pdf', { year: 2026, batch: 2 })
    for (const key of ['relPath', 'bytes', 'sha256', 'filename']) {
      const r = setFileCategoryForAgent(db, { fileId: id }, { [key]: 'x' })
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.message).toContain('不可修改的字段')
    }
    // 一个字段都不给也是错。
    const none = setFileCategoryForAgent(db, { fileId: id }, {})
    expect(none.ok).toBe(false)
    expect(none.ok === false && none.message).toContain('至少给一个')
  })

  it('已移出库的文件不接受写入', () => {
    const r = setFileCategoryForAgent(db, { relPath: REL_REMOVED }, { year: 2020 })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('已移出库')
  })

  it('改完之后 list_files 的查询层立刻能看到(端到端的库内半边)', () => {
    const id = seedFile('jxj/announcement/2026/2/查得到.pdf', { categoryState: 'unset' })
    setFileCategoryForAgent(db, { fileId: id }, { source: 'jxj', kind: 'announcement', year: 2026, batch: 2 })
    const { rows } = listStoredFiles(db, { q: '查得到' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.year).toBe(2026)
    expect(rows[0]!.categoryState).toBe('set')
  })
})

// ---------------------------------------------------------------------------
// 5. 懒回填与页图(list_files / list_page_images 的落点)
// ---------------------------------------------------------------------------

describe('ensureFileStoreReady 懒回填', () => {
  it('扫文件库补文件行,并按 evidence 补段;重跑不再回填(幂等)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spztx-mcp-files-'))
    // 造一份**真实形状**的文件库:192号(两段)。
    mkdirSync(join(root, 'jxj/announcement/2024/2'), { recursive: true })
    writeFileSync(join(root, REL_PDF), 'not really a pdf, 只需要它在盘上')
    mkdirSync(join(root, 'miit/export'), { recursive: true })
    writeFileSync(join(root, REL_XLSX), 'xlsx placeholder')

    const other = mkdtempSync(join(tmpdir(), 'spztx-mcp-db-'))
    process.env.NUXT_DB_PATH = join(other, 'mcp.db')
    const mod = await import('../db')
    const fresh = mod.useDb()
    const f = mod.schema

    // 192号:认定 2024/2(附件1,389 行)+ 复核 2021/2(附件2,67 行)。
    const e1 = fresh
      .insert(f.enterprise)
      .values({ name: '宁波某企业', nameNorm: '宁波某企业' })
      .returning({ id: f.enterprise.id })
      .get().id
    const rec = fresh
      .insert(f.record)
      .values({ enterpriseId: e1, titleCode: 'specialized_sme', source: 'jxj' })
      .returning({ id: f.record.id })
      .get().id
    const ev1 = fresh
      .insert(f.recordEvent)
      .values({ recordId: rec, eventType: 'award', year: 2024, batchSeq: 2 })
      .returning({ id: f.recordEvent.id })
      .get().id
    const ev2 = fresh
      .insert(f.recordEvent)
      .values({ recordId: rec, eventType: 'review', year: 2021, batchSeq: 2 })
      .returning({ id: f.recordEvent.id })
      .get().id
    fresh
      .insert(f.recordEvidence)
      .values([
        ...Array.from({ length: 389 }, () => ({
          recordEventId: ev1,
          sourceFile: REL_PDF,
          attachment: '附 件 1',
        })),
        ...Array.from({ length: 67 }, () => ({
          recordEventId: ev2,
          sourceFile: REL_PDF,
          attachment: '附件2',
        })),
      ])
      .run()

    __resetFileStoreReady()
    const first = await ensureFileStoreReady(fresh, root)
    expect(first).not.toBeNull()
    // 盘上两个文件 → 两行(README.md 不在这个临时库里)。
    expect(first!.inserted).toBe(2)
    expect(first!.parts.parts).toBe(2)

    // 重跑:不再回填。
    expect(await ensureFileStoreReady(fresh, root)).toBeNull()

    // ★ 验收口径:192号 的段 = 2 段,行数 389 / 67,附件名已归一。
    const id = findFileIdByRelPath(fresh, REL_PDF)!
    const row = getStoredFile(fresh, id)!
    expect(row.parts).toHaveLength(2)
    expect(row.parts.map((p) => [p.eventKind, p.year, p.batch, p.attachment, p.rowCount])).toEqual([
      ['award', 2024, 2, '附件1', 389],
      ['review', 2021, 2, '附件2', 67],
    ])

    // 冷启动回填只重建 derived 段;agent 覆盖同坐标并标冲突,未覆盖的 derived 段仍回来。
    const overwritten = applyParseResult(fresh, id, {
      parts: [
        { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附件1', rowCount: 1 },
      ],
    })
    expect(overwritten.ok).toBe(true)
    __resetFileStoreReady()
    await ensureFileStoreReady(fresh, root)
    expect(getStoredFile(fresh, id)!.parts).toEqual([
      {
        titleCode: 'specialized_sme',
        eventKind: 'award',
        year: 2024,
        batch: 2,
        attachment: '附件1',
        rowCount: 1,
        origin: 'agent',
        hasConflict: true,
      },
      {
        titleCode: 'specialized_sme',
        eventKind: 'review',
        year: 2021,
        batch: 2,
        attachment: '附件2',
        rowCount: 67,
        origin: 'derived',
        hasConflict: false,
      },
    ])

    rmSync(root, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  })
})

describe('pageImagesForAgent 页图取值', () => {
  it('非 PDF → 415;文件不存在 → 404;分辨率非法 → 400', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spztx-mcp-pdf-'))
    // 文件行在基线库里已有(REL_XLSX / REL_PDF),这里只需 root 供路径解析用。
    const notPdf = await pageImagesForAgent(db, root, { relPath: REL_XLSX })
    expect(notPdf.ok).toBe(false)
    expect(notPdf.ok === false && notPdf.statusCode).toBe(415)

    const missing = await pageImagesForAgent(db, root, { relPath: 'jxj/announcement/2024/1/没有.pdf' })
    expect(missing.ok).toBe(false)
    expect(missing.ok === false && missing.statusCode).toBe(404)

    const badDpi = await pageImagesForAgent(db, root, { relPath: REL_PDF, dpi: 9999 })
    expect(badDpi.ok).toBe(false)
    expect(badDpi.ok === false && badDpi.statusCode).toBe(400)

    rmSync(root, { recursive: true, force: true })
  })

  it('未渲染过的 PDF:如实报 rendered=0,不触发渲染', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spztx-mcp-pdf2-'))
    // 造一份最小可打开的 PDF(与 pdf-pages 的夹具同一手法)。
    const { minimalPdf } = await import('./helpers/minimal-pdf')
    mkdirSync(join(root, 'jxj/announcement/2024/2'), { recursive: true })
    writeFileSync(join(root, REL_PDF), minimalPdf({ pages: 3 }))

    const r = await pageImagesForAgent(db, root, { relPath: REL_PDF })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.pageCount).toBe(3)
    expect(r.value.rendered).toBe(0)
    expect(r.value.pages).toEqual([])
    // 目录里不该多出任何页图(本 tool 不渲染)。
    const { readdirSync } = await import('node:fs')
    const entries = readdirSync(join(root, 'jxj/announcement/2024/2'))
    expect(entries).toEqual([REL_PDF.split('/').pop()])

    rmSync(root, { recursive: true, force: true })
  })
})
