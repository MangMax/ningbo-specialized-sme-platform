/**
 * `scripts/reconcile-live.mjs` —— 无头长跑入口的**两个入口、一份核心**。
 *
 * 这组用例只守脚本这一层:用法与出错时不静默、以及**真的能加载到同一份 TS 核心**
 * (Node 的扩展名解析钩子 + `--experimental-transform-types` 那一套如果坏了,第一条用例
 * 就会红,而不是等到真跑全量才发现)。脚本不自己实现任何业务逻辑 ——
 * 它调用的是 `server/utils/platform-reconcile.ts` 的 `runPlatformReconcile`,
 * 与 `kind: 'reconcile'` 的任务入口完全相同。
 *
 * 不打外网:这里跑的都是「到不了网络」的路径(缺库、参数非法、缺凭据)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts/reconcile-live.mjs')

const dir = mkdtempSync(join(tmpdir(), 'spztx-reconcile-script-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * 跑脚本。**默认剥掉平台凭据**(本组用例验证的正是「缺凭据就明确失败」);
 * 要显式注入时用 `envWithoutCookie({...})` 的返回值自己传,免得剥了又加回来。
 */
function run(args: string[], env: Record<string, string> = {}) {
  const clean: Record<string, string | undefined> = { ...process.env }
  delete clean.MIIT_COOKIE
  delete clean.MIIT_COOKIE_FILE
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...clean, ...env } as Record<string, string>,
  })
}

/** 异步跑脚本:**需要在本进程里起一个 stub HTTP 服务时必须用这个** —— `spawnSync`
 *  会把事件循环整个卡住,stub 服务因此永远回不了话,脚本与测试互相等死。 */
function runAsync(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const clean: Record<string, string | undefined> = { ...process.env }
  delete clean.MIIT_COOKIE
  delete clean.MIIT_COOKIE_FILE
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...clean, ...env } as Record<string, string>,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

describe('用法与参数', () => {
  it('--help 打印用法并 0 退出(顺带证明脚本能加载 TS 核心)', () => {
    const result = run(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--titles')
    expect(result.stdout).toContain('--dry-run')
    expect(result.stdout).toContain('--base-url')
    expect(result.stdout).toContain('MIIT_COOKIE')
    expect(result.stdout).not.toContain('MIIT_COOKIE_FILE')
  })

  it('参数非法 ⇒ 2 退出并说明原因(不静默用默认值把长跑跑偏)', () => {
    const limit = run(['--limit', '0'])
    expect(limit.status).toBe(2)
    expect(limit.stderr).toContain('--limit 必须是正整数')

    const concurrency = run(['--concurrency', 'abc'])
    expect(concurrency.status).toBe(2)
    expect(concurrency.stderr).toContain('--concurrency')
  })

  it('库不存在 ⇒ 2 退出并指出路径', () => {
    const result = run(['--db', join(dir, 'does-not-exist.db')])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('数据库不存在')
  })
})

describe('缺凭据:明确失败,一行不写', () => {
  it('有目标但只有旧凭据文件 ⇒ 1 退出,库里没有任何证据行', () => {
    const dbPath = join(dir, 'target.db')
    const db = useDb({ dbPath })
    const enterpriseId = db
      .insert(schema.enterprise)
      .values({ name: '宁波无凭据科技有限公司', nameNorm: '宁波无凭据科技有限公司', usccNorm: '91330211000000012K' })
      .returning({ id: schema.enterprise.id })
      .get().id
    db.insert(schema.record).values({ enterpriseId, source: 'miit', titleCode: 'specialized_sme' }).run()

    const cookiePath = join(dir, 'legacy-cookie.txt')
    writeFileSync(cookiePath, 'session=synthetic-legacy-cookie')
    const result = run(['--db', dbPath, '--titles', 'specialized_sme'], { MIIT_COOKIE_FILE: cookiePath })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MIIT_COOKIE')
    // 「不产出一片『未查询』的假结果」是硬约束 —— 库里必须干净。
    expect(db.select().from(schema.platformQuery).all()).toHaveLength(0)
    expect(db.select().from(schema.differenceReason).all()).toHaveLength(0)
  })
})

describe('--base-url:把同一个 job 交给正在运行的 app 并轮询', () => {
  it('提交 202 → 仅摘要轮询到 done → 按需读取完整回执并落 JSON', async () => {
    const report = {
      startedAt: '2026-10-16T02:00:00.000Z',
      finishedAt: '2026-10-16T02:00:05.000Z',
      usccCount: 1,
      targetCount: 2,
      relations: 8,
      aliases: 1,
      mergeCandidates: [],
      write: { batchId: 1, status: 'committed', written: 11, skipped: 0 },
      queries: { network: 4, reused: 0, byInterface: { business_list: 3, apply_list: 1 } },
      counts: {
        confirmed: 1,
        byReason: { renamed: 1 },
        noRecord: 1,
        needsReview: 0,
        queryFailed: 0,
        notQueried: 0,
        reusedFresh: 0,
        total: 2,
      },
    }
    const seen: { method: string; path: string; auth: string | undefined; body: unknown }[] = []
    let polls = 0
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const raw = Buffer.concat(chunks).toString('utf8')
        seen.push({
          method: req.method ?? '',
          path: req.url ?? '/',
          auth: req.headers.authorization,
          body: raw ? JSON.parse(raw) : null,
        })
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        if (req.method === 'POST') return send(202, { jobId: 'job-1', kind: 'reconcile', state: 'queued', progress: { done: 0, total: 1 } })
        if (req.url?.includes('view=summary')) {
          polls += 1
          return send(200, {
            state: polls < 2 ? 'running' : 'done', progress: { done: polls < 2 ? 0 : 1, total: 1 },
            resultSummary: { available: true }, detailUrl: '/api/jobs/job-1',
          })
        }
        return send(200, { state: 'done', progress: { done: 1, total: 1 }, result: report, error: null })
      })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const out = join(dir, 'remote-report.json')

    try {
      const result = await runAsync(
        ['--base-url', `http://127.0.0.1:${port}`, '--poll-seconds', '1', '--out', out, '--titles', 'specialized_sme'],
        { NUXT_API_TOKEN: 'script-remote-token' },
      )
      expect(result.status).toBe(0)
      // 提交的就是**同一个 kind 与参数** —— 不是另起一套逻辑。
      expect(seen[0]!.method).toBe('POST')
      expect(seen[0]!.path).toBe('/api/jobs')
      expect(seen[0]!.body).toEqual({ kind: 'reconcile', params: { titles: ['specialized_sme'] } })
      expect(seen[0]!.auth).toBe('Bearer script-remote-token')
      expect(seen.slice(1).map(({ method, path }) => ({ method, path }))).toEqual([
        { method: 'GET', path: '/api/jobs/job-1?view=summary' },
        { method: 'GET', path: '/api/jobs/job-1?view=summary' },
        { method: 'GET', path: '/api/jobs/job-1' },
      ])
      expect(seen.every((call) => call.auth === 'Bearer script-remote-token')).toBe(true)
      // 报告照常打印并落盘。
      expect(result.stdout).toContain('已查并确认 1(更名 1)')
      expect(result.stdout).toContain('写回:批次 1 committed')
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(report)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each(['failed', 'cancelled'])('摘要终态 %s 后保留完整错误与部分回执，不重提任务', async (state) => {
    const receipt = { segments: [{ page: 2 }, { page: 1 }], artifact: 'exports/partial.xlsx', batchId: 17 }
    const paths: string[] = []
    const server = createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`)
      res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.method === 'POST' ? { jobId: 'job-1' }
        : req.url?.includes('view=summary')
          ? { state, progress: { done: 1, total: 2 }, error: '任务有错误，请读取详情', resultSummary: { available: true }, detailUrl: '/api/jobs/job-1' }
          : { state, error: 'synthetic segment failure', result: receipt }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const out = join(dir, `${state}-receipt.json`)
    try {
      const result = await runAsync(['--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, '--poll-seconds', '1', '--out', out], { NUXT_API_TOKEN: 'synthetic-token' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`任务 ${state}:synthetic segment failure`)
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(receipt)
      expect(paths).toEqual(['POST /api/jobs', 'GET /api/jobs/job-1?view=summary', 'GET /api/jobs/job-1'])
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it('终态详情读取失败明确退出，不把摘要当完整报告', async () => {
    const paths: string[] = []
    const server = createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`)
      const summary = req.url?.includes('view=summary')
      res.writeHead(req.method === 'POST' ? 202 : summary ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.method === 'POST' ? { jobId: 'job-1' } : summary ? { state: 'done', progress: { done: 1, total: 1 } } : { message: 'unavailable' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const result = await runAsync(['--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, '--poll-seconds', '1'], { NUXT_API_TOKEN: 'synthetic-token' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('读取任务详情失败(503)')
      expect(result.stdout).not.toContain('写回:')
      expect(paths).toEqual(['POST /api/jobs', 'GET /api/jobs/job-1?view=summary', 'GET /api/jobs/job-1'])
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it('摘要终态后同 ID 被重试重开时继续摘要轮询，以新详情状态为准', async () => {
    const paths: string[] = []
    let details = 0
    const server = createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`)
      res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' })
      if (req.method === 'POST') return res.end(JSON.stringify({ jobId: 'job-1' }))
      if (req.url?.includes('view=summary')) return res.end(JSON.stringify({ state: 'failed', progress: { done: 1, total: 2 } }))
      details++
      res.end(JSON.stringify(details === 1 ? { state: 'running', result: { checkpoint: true } } : { state: 'cancelled', error: 'retried then cancelled', result: null }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const result = await runAsync(['--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, '--poll-seconds', '1'], { NUXT_API_TOKEN: 'synthetic-token' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('任务 cancelled:retried then cancelled')
      expect(paths).toEqual(['POST /api/jobs', 'GET /api/jobs/job-1?view=summary', 'GET /api/jobs/job-1', 'GET /api/jobs/job-1?view=summary', 'GET /api/jobs/job-1'])
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it('--base-url 但没有 NUXT_API_TOKEN ⇒ 2 退出并说明从环境读(不进命令行)', () => {
    const result = run(['--base-url', 'http://127.0.0.1:1'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('NUXT_API_TOKEN')
  })
})
