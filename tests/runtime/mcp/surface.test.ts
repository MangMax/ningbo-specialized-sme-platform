import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MCP_WRITE_TOOLS, writeToolCallIn } from '../../../server/mcp-access-policy'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { readMcpToken, resolveMcpAuth, tokenMatches, unauthorizedMessage } from '../../../layers/core/server/utils/mcp-auth'
import { fileLocator, postgresPageImagesForAgent, requirePostgresFileRef } from '../../../layers/core/server/utils/file-agent-reference'
import { normalizeParseParts } from '../../../layers/sme-roster/server/utils/parse-result-model'
import { minimalPdf } from '../../support/minimal-pdf'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

describe('mcp-auth 鉴权判据', () => {
  it('写入 tool 名单就是这几个 —— 新增写入口必须同时改这里', () => {
    // 这条断言是**防走神**用的:名单是「哪些调用会被要求鉴权」的唯一来源,
    // 悄悄加一个写入 tool 而不改它,就是开了一条绕过鉴权的写路。
    // 票 18 的三个 + RL-11 的名录统一写入(`save_roster_batch`)。
    expect([...MCP_WRITE_TOOLS]).toEqual([
      'list_runtime_logs',
      'get_runtime_log',
      'get_runtime_log_policy',
      'set_runtime_log_policy',
      'clear_runtime_logs',
      'save_difference_decision',
      'preflight_qualification_decision',
      'commit_qualification_decision',
      'difference_snapshot',
      'refresh_enterprise_differences',
      'maintain_enterprise_alias',
      'save_ocr_result',
      'delete_ocr_result',
      'set_file_category',
      'update_file',
      'remove_file',
      'restore_file',
      'quarantine_file',
      'recover_file',
      'save_parse_result',
      'preflight_file_parse_result',
      'commit_file_parse_result',
      'save_roster_batch',
      'submit_platform_batch',
      'retry_platform_batch',
      'submit_event_archive_candidate_task',
      'retry_event_archive_candidate_task',
      'cancel_event_archive_candidate_task',
      'submit_event_annual_correspondence_task',
      'retry_event_annual_correspondence_task',
      'cancel_event_annual_correspondence_task',
      'preflight_record_correspondences',
      'save_record_correspondences',
      'preflight_event_corrections',
      'commit_event_corrections',
      'get_record_correspondence_batch',
      'get_roster_import_receipt',
      'list_roster_import_receipts',
      'list_roster_import_items',
      'patch_enterprise_profile',
      'preflight_title_cycle_disposition',
      'commit_title_cycle_disposition',
      'preflight_enterprise_fact',
      'commit_enterprise_fact',

      'preflight_roster_evidence_corrections',
      'commit_roster_evidence_corrections',
      'get_roster_evidence_correction_batch',
    ])
  })

  it('enterprise fact commands require credentials while fact reads remain public', () => {
    for (const name of ['preflight_enterprise_fact', 'commit_enterprise_fact']) {
      expect(writeToolCallIn({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })).toBe(name)
    }
    expect(writeToolCallIn({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_enterprise_facts', arguments: {} } })).toBeNull()
  })

  it('RL-11:名录写入 tool 是写入、只读预检不是', () => {
    const call = (name: string) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    })
    expect(writeToolCallIn(call('save_roster_batch'))).toBe('save_roster_batch')
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

describe('解析段输入', () => {
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

})

describe('MCP 文件引用与页图', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-file-surface-'))
  const pdfPath = 'jxj/announcement/2024/2/unrendered.pdf'
  const spreadsheetPath = 'miit/export/名单.xlsx'
  const removedPath = 'jxj/announcement/2023/1/已移出的文件.pdf'
  const removedAt = '2026-10-14T00:00:00.000Z'
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  const db = () => usePostgresDirectoryDb()

  beforeAll(async () => {
    runtime = await postgresRuntimeFixture({ dir })
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
    vi.stubEnv('NUXT_DB_READONLY', '0')
    const pdf = minimalPdf({ pages: 3 })
    mkdirSync(join(dir, 'jxj/announcement/2024/2'), { recursive: true })
    writeFileSync(join(dir, pdfPath), pdf)
    const sha256 = createHash('sha256').update(pdf).digest('hex')
    await db().execute(sql`
      INSERT INTO business.stored_file (rel_path, filename, ext, bytes, sha256, removed_at, created_at)
      VALUES (${pdfPath}, ${basename(pdfPath)}, 'pdf', ${pdf.length}, ${sha256}, NULL, '2026-11-22'),
        (${spreadsheetPath}, ${basename(spreadsheetPath)}, 'xlsx', 1, ${'b'.repeat(64)}, NULL, '2026-11-22'),
        (${removedPath}, ${basename(removedPath)}, 'pdf', 1, ${'b'.repeat(64)}, ${removedAt}, '2026-11-22')
    `)
  }, 20_000)

  afterAll(async () => {
    try {
      await closePostgresDirectoryDb()
      runtime?.close()
    } finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('id 与 relPath 恰给其一且 id 必须是正整数', () => {
    expect(fileLocator({ fileId: 1, relPath: pdfPath })).toMatchObject({ ok: false, message: expect.stringContaining('只能给一个') })
    expect(fileLocator({})).toMatchObject({ ok: false, message: expect.stringContaining('必须给') })
    for (const fileId of [0, -1, 1.5]) {
      expect(fileLocator({ fileId })).toMatchObject({ ok: false, message: expect.stringContaining('正整数') })
    }
  })

  it('按 id 与相对路径解析到同一个文件', async () => {
    const byPath = await requirePostgresFileRef(db(), { relPath: pdfPath })
    expect(byPath.relPath).toBe(pdfPath)
    expect(await requirePostgresFileRef(db(), { fileId: byPath.id })).toEqual(byPath)
  })

  it('不存在的 id 与相对路径返回 404 及中文原因', async () => {
    for (const ref of [{ fileId: 999999 }, { relPath: 'jxj/announcement/2024/1/没有这个.pdf' }]) {
      await expect(requirePostgresFileRef(db(), ref)).rejects.toMatchObject({
        statusCode: 404, message: expect.stringContaining('文件不存在'),
      })
    }
  })

  it('已移出文件可以读取且拒绝普通写入引用', async () => {
    const ref = { relPath: removedPath }
    await expect(requirePostgresFileRef(db(), ref)).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('已移出库') })
    expect(await requirePostgresFileRef(db(), ref, { allowRemoved: true })).toMatchObject({ relPath: removedPath, removedAt })
  })

  it('非 PDF 返回 415，文件不存在返回 404，分辨率非法返回 400', async () => {
    await expect(postgresPageImagesForAgent(db(), dir, { relPath: spreadsheetPath }))
      .resolves.toMatchObject({ ok: false, statusCode: 415 })
    await expect(postgresPageImagesForAgent(db(), dir, { relPath: 'missing.pdf' }))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect(postgresPageImagesForAgent(db(), dir, { relPath: pdfPath, dpi: 9999 }))
      .resolves.toMatchObject({ ok: false, statusCode: 400 })
  })

  it('读取未渲染 PDF 的页数并保留空页图目录', async () => {
    expect(await postgresPageImagesForAgent(db(), dir, { relPath: pdfPath })).toMatchObject({
      ok: true, value: { pageCount: 3, rendered: 0, pages: [] },
    })
    expect(readdirSync(join(dir, 'jxj/announcement/2024/2'))).toEqual([basename(pdfPath)])
  })
})
