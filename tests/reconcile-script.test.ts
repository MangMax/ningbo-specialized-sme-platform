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
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts/reconcile-live.mjs')

const dir = mkdtempSync(join(tmpdir(), 'spztx-reconcile-script-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 不带平台的任何凭据跑脚本(用它验证「缺凭据就明确失败」)。 */
function run(args: string[], env: Record<string, string> = {}) {
  const clean = { ...process.env, ...env }
  delete clean.MIIT_COOKIE
  delete clean.MIIT_COOKIE_FILE
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...clean, ...env },
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
  it('有目标但拿不到 MIIT_COOKIE / MIIT_COOKIE_FILE ⇒ 1 退出,库里没有任何证据行', () => {
    const dbPath = join(dir, 'target.db')
    const db = useDb({ dbPath })
    const enterpriseId = db
      .insert(schema.enterprise)
      .values({ name: '宁波无凭据科技有限公司', nameNorm: '宁波无凭据科技有限公司', usccNorm: '91330211000000012K' })
      .returning({ id: schema.enterprise.id })
      .get().id
    db.insert(schema.record).values({ enterpriseId, source: 'miit', titleCode: 'specialized_sme' }).run()

    const result = run(['--db', dbPath, '--titles', 'specialized_sme'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MIIT_COOKIE')
    // 「不产出一片『未查询』的假结果」是硬约束 —— 库里必须干净。
    expect(db.select().from(schema.platformQuery).all()).toHaveLength(0)
    expect(db.select().from(schema.differenceReason).all()).toHaveLength(0)
  })
})
