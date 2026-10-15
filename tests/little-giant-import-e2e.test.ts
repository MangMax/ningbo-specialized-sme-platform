import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildLittleGiantImportRequest,
  type RosterImportRequest,
} from '../lib/roster/little-giant-import'
import { parseLittleGiantWorkbook } from '../lib/roster/little-giant-workbook'

/**
 * RL-02 端到端 —— **经真实 HTTP** 把这份工作簿提交给统一写入 API。
 *
 * ── 为什么不在 `pnpm test` 里默认跑 ──────────────────────────────────────
 * 这条用例会**真的把应用起起来**(`nuxt dev`)、**真的写一个临时 SQLite**,
 * 并且需要**真实源文件**(不进 Git)。它是「跑一次就能重跑」的验收,不是快速单测
 * ⇒ 用 `RL02_E2E=1` 打开:
 *
 * ```bash
 * RL02_E2E=1 pnpm test tests/little-giant-import-e2e.test.ts
 * # 换源文件:
 * RL02_E2E=1 RL02_LITTLE_GIANT_XLSX=/abs/path/经信局公布历年小巨人企业名单.xlsx pnpm test tests/little-giant-import-e2e.test.ts
 * ```
 *
 * 断言的是**用户可观察的结果**:企业去重、两条批次事件、来源证据、重复运行幂等。
 * 记数只读 DB(**写**一律走 API —— 直写 SQLite 是 SPEC 明令禁止的)。
 *
 * 依赖:RL-11 的 `POST /api/roster/import/commit`(契约 §8.2)。
 */

const DEFAULT_SOURCE =
  '/Users/mang/Workfile/宁波/专精特新/20261013/经信局名单/小巨人/经信局公布历年小巨人企业名单.xlsx'

const SOURCE_PATH = process.env.RL02_LITTLE_GIANT_XLSX ?? DEFAULT_SOURCE
const TOKEN = 'rl02-e2e-token'
const ENABLED = process.env.RL02_E2E === '1' && existsSync(SOURCE_PATH)

if (process.env.RL02_E2E === '1' && !existsSync(SOURCE_PATH)) {
  console.warn(`[RL-02] RL02_E2E=1 但找不到源文件 ${SOURCE_PATH};整组跳过。`)
}
if (process.env.RL02_E2E !== '1') {
  console.info('[RL-02] 端到端未开启(设 RL02_E2E=1 打开)。')
}

/** 让系统给一个空闲端口(免得和 dev 端口/别的用例撞车)。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

interface RunningApp {
  origin: string
  dbPath: string
  stop(): Promise<void>
}

async function startApp(): Promise<RunningApp> {
  const dir = mkdtempSync(join(tmpdir(), 'rl02-e2e-'))
  const dbPath = join(dir, 'roster.db')
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`

  const child: ChildProcess = spawn(
    'pnpm',
    ['exec', 'nuxt', 'dev', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: process.cwd(),
      env: { ...process.env, NUXT_API_TOKEN: TOKEN, NUXT_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString() })

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await sleep(1500)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    rmSync(dir, { recursive: true, force: true })
  }

  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await stop()
      throw new Error(`应用起不来(退出码 ${child.exitCode})\n${log.slice(-3000)}`)
    }
    try {
      const res = await fetch(`${origin}/api/health`)
      if (res.ok) return { origin, dbPath, stop }
    } catch {
      // 还没起来,继续等。
    }
    await sleep(500)
  }
  await stop()
  throw new Error(`应用 150s 内没就绪\n${log.slice(-3000)}`)
}

/** POST 一次提交;`text()` 里的错误原文要留给失败信息,所以不直接 `res.json()`。 */
async function commit(
  app: RunningApp,
  body: RosterImportRequest,
): Promise<{ status: number; contentType: string; json: Record<string, unknown> | null; text: string }> {
  const res = await fetch(`${app.origin}/api/roster/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Token': TOKEN },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  let json: Record<string, unknown> | null = null
  if (contentType.includes('json')) {
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      json = null
    }
  }
  return { status: res.status, contentType, json, text }
}

/** 提交必须打到**真的写入端点**上。打不到就直说差哪一步,别让后面几条断言各自报假错。 */
function expectCommitted(result: Awaited<ReturnType<typeof commit>>): Record<string, unknown> {
  if (!result.json || typeof result.json.batchId !== 'number') {
    throw new Error(
      'POST /api/roster/import/commit 没有返回契约 §8.2 的响应 ——\n' +
        `HTTP ${result.status} content-type=${result.contentType || '(空)'}\n` +
        `body(前 300 字):${result.text.slice(0, 300)}\n` +
        '状态 200 且 body 是 SPA 的 HTML ⇒ 该路由还不存在(RL-11 未合入)。',
    )
  }
  return result.json
}

interface Counts {
  enterprises: number
  records: number
  events: number
  evidences: number
  batches: number
}

function readCounts(dbPath: string): Counts {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n
    return {
      enterprises: one('select count(*) as n from enterprise'),
      records: one('select count(*) as n from record'),
      events: one('select count(*) as n from record_event'),
      evidences: one('select count(*) as n from record_evidence'),
      batches: one('select count(*) as n from import_batch'),
    }
  } finally {
    db.close()
  }
}

describe.skipIf(!ENABLED)('RL-02 端到端:经真实 HTTP 提交小巨人工作簿', () => {
  let app: RunningApp
  let request: RosterImportRequest
  let sourceSha256: string
  /** 第一次提交的响应。提交本身放在 `beforeAll`:打不到端点时**一次**说清根因,而不是四条用例各报假错。 */
  let firstCommit: { status: number; json: Record<string, unknown> }

  beforeAll(async () => {
    const workbook = await parseLittleGiantWorkbook(readFileSync(SOURCE_PATH))
    request = buildLittleGiantImportRequest(workbook)
    sourceSha256 = workbook.sha256
    app = await startApp()
    const result = await commit(app, request)
    firstCommit = { status: result.status, json: expectCommitted(result) }
  }, 200_000)

  afterAll(async () => {
    await app?.stop()
  })

  it('第一次提交:511 条事件全部写入,510 家企业(跨批次同码的企业已去重)', async () => {
    expect(firstCommit.json.status).toBe('committed')

    const counts = readCounts(app.dbPath)
    expect(counts.enterprises).toBe(510)
    expect(counts.records).toBe(510)
    expect(counts.events).toBe(511)
    expect(counts.evidences).toBe(511)
    expect(counts.batches).toBe(1)

    const db = new Database(app.dbPath, { readonly: true })
    try {
      const batch = db
        .prepare('select idempotency_key, source_kind, source_sha256, status from import_batch')
        .get() as Record<string, string>
      expect(batch.idempotency_key).toBe(request.idempotencyKey)
      expect(batch.source_kind).toBe('announcement')
      expect(batch.source_sha256).toBe(sourceSha256)
      expect(batch.status).toBe('committed')
    } finally {
      db.close()
    }
  })

  it('91330211316904639T:企业一行,但第 2 批与第 6 批**各留一条**认定事件', async () => {
    const db = new Database(app.dbPath, { readonly: true })
    try {
      const rows = db
        .prepare(
          `select e.id as enterprise_id, ev.event_type, ev.year, ev.batch_seq
             from enterprise e
             join record r on r.enterprise_id = e.id
             join record_event ev on ev.record_id = r.id
            where e.uscc_norm = ?
            order by ev.batch_seq`,
        )
        .all('91330211316904639T') as Array<{
          enterprise_id: number
          event_type: string
          year: number
          batch_seq: number
        }>

      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((row) => row.enterprise_id)).size).toBe(1)
      expect(rows.map((row) => [row.event_type, row.batch_seq, row.year])).toEqual([
        ['award', 2, 2020],
        ['award', 6, 2024],
      ])
    } finally {
      db.close()
    }
  })

  it('来源证据落到事件上:源文件 / 附件(工作表) / 名单序号', async () => {
    const db = new Database(app.dbPath, { readonly: true })
    try {
      const evidence = db
        .prepare(
          `select ev.source_file, ev.attachment, ev.list_no, ev.page, evt.batch_seq
             from record_evidence ev
             join record_event evt on evt.id = ev.record_event_id
            where ev.list_no = 14`,
        )
        .get() as Record<string, unknown>

      expect(evidence.source_file).toBe(request.payload.announcement.records
        .flatMap((record) => record.events)
        .flatMap((event) => event.evidence)[0]!.sourceFile)
      expect(evidence.attachment).toBe('专精特新小巨人企业 (2)')
      expect(evidence.batch_seq).toBe(2)
      // 表格给不出页码 ⇒ 空值(空值优于错误值)。
      expect(evidence.page).toBeNull()

      const withListNo = db
        .prepare('select count(*) as n from record_evidence where list_no is not null')
        .get() as { n: number }
      expect(withListNo.n).toBe(511)
    } finally {
      db.close()
    }
  })

  it('重复导入(同幂等键):返回同一批次,企业 / 事件 / 出处**一个都不多**', async () => {
    const before = readCounts(app.dbPath)
    const first = await commit(app, request)
    const firstJson = expectCommitted(first)
    const second = await commit(app, request)
    const secondJson = expectCommitted(second)

    expect(secondJson.batchId).toBe(firstJson.batchId)
    expect(second.status).toBe('committed')
    expect(readCounts(app.dbPath)).toEqual(before)
  })
})
