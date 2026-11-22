import pg from 'pg'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { DEFAULT_DPI } from '../../../layers/core/lib/pdf-page'
import { renderPdfPages } from '../../../layers/core/server/utils/pdf-pages'
import { spawnCompiledApp, reserveLoopbackPort, stopOwnedChild, waitForHttp } from '../../support/owned-process.mjs'
import { minimalPdf } from '../../support/minimal-pdf'
import { startMiniOcrApi } from './fixtures/provider-api'

it('公开任务 HTTP 受文件级背压约束,完成结果经 OCR REST/MCP 原样读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-public-bound-'))
  const filesDir = join(dir, 'files')
  mkdirSync(filesDir)
  const files = ['甲.pdf', '乙.pdf', '丙.pdf']
  const ids: number[] = []
  let child: ReturnType<typeof spawnCompiledApp> | undefined
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let pool: pg.Pool | undefined
  let api: Awaited<ReturnType<typeof startMiniOcrApi>> | undefined
  let releasePoll: (() => void) | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    pool = new pg.Pool({ connectionString: runtime.url })
    for (const file of files) {
      const bytes = minimalPdf({ pages: 1 })
      writeFileSync(join(filesDir, file), bytes)
      const { rows: [row] } = await pool.query<{ id: string }>(`INSERT INTO business.stored_file
        (rel_path, filename, ext, bytes, sha256, created_at) VALUES ($1, $1, 'pdf', $2, $3, $4) RETURNING id`,
      [file, bytes.length, createHash('sha256').update(bytes).digest('hex'), new Date().toISOString()])
      ids.push(Number(row!.id))
      await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI })
    }
    const gate = new Promise<void>(resolve => { releasePoll = resolve })
    api = await startMiniOcrApi({ pages: ['公开原文🙂'], waitForPoll: () => gate })
    const port = await reserveLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    child = spawnCompiledApp(port, {
      env: { ...process.env, ...runtime.env, NUXT_BUILD_DIR: join(dir, 'nuxt'), NUXT_FILES_DIR: filesDir, NUXT_API_TOKEN: 'synthetic-api', NUXT_MCP_TOKEN: 'synthetic-mcp', NUXT_OCR_TOKEN: 'synthetic-ocr', NUXT_OCR_BASE_URL: api.origin, PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '', MIIT_COOKIE: '' },
      stdio: 'ignore',
    })
    await waitForHttp(`${baseUrl}/api/health`, { child })
    const submitted = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', headers: { authorization: 'Bearer synthetic-api', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ocr', params: { files } }) })
    expect(submitted.status).toBe(202)
    const { jobId } = await submitted.json() as { jobId: string }
    for (let i = 0; i < 300 && api.stats.submits < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(api.stats.submits).toBe(2)
    releasePoll?.(); releasePoll = undefined

    let task: { state: string; result?: { files: Array<{ file: string; ok: boolean }> } } = { state: 'queued' }
    for (let i = 0; i < 300; i++) {
      task = await (await fetch(`${baseUrl}/api/jobs/${jobId}`)).json()
      if (['done', 'failed', 'cancelled'].includes(task.state)) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(task.state).toBe('done')
    expect(task.result?.files.map(outcome => [outcome.file, outcome.ok])).toEqual(files.map(file => [file, true]))
    expect(api.stats.submits).toBe(3)
    for (const id of ids) {
      const rest = await (await fetch(`${baseUrl}/api/ocr-results?fileId=${id}&markdown=1`)).json()
      expect(rest.pages.map((row: { page: number; markdown: string }) => [row.page, row.markdown])).toEqual([[1, '公开原文🙂']])
      const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { authorization: 'Bearer synthetic-mcp', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_ocr_result', arguments: { fileId: id } } }) })
      expect(response.status).toBe(200)
      const payload = await response.text()
      const rpc = JSON.parse(payload.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? payload)
      expect(rpc.result.isError).not.toBe(true)
      expect(JSON.parse(rpc.result.content[0].text).markdown).toContain('公开原文🙂')
    }
  } finally {
    releasePoll?.()
    await stopOwnedChild(child)
    await api?.close()
    await pool?.end()
    runtime?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
