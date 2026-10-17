#!/usr/bin/env node
/**
 * **写回后的平台原因分布** —— 只读报告(RL-15 的验收证据)。
 *
 * 用户 2026-10-16 的诉求是「三个称号从平台获取的数据都没了」。这张票把比对页的
 * 「平台解释 / 平台证据」改成读**库内**(`difference_reason` / `platform_query` /
 * `platform_relation`)之后,需要一个**可复现**的命令回答「写回后到底落了什么」——
 * 本脚本就是它:按 `称号 × 状态 × 原因` 给出计数,顺带给出接口查询与关系的体量。
 *
 * ── 口径 ──────────────────────────────────────────────────────────────────
 * 计数走 `lib/roster/enterprise-roster.ts` 的 `listRosterDifferences`(契约 §7.3 的
 * **读模型本身**,不是另写一套 SQL),所以「页面能看到什么」与「这里数到什么」同源。
 * 它已经做了两件本脚本不该重做的事:
 *  - 差异集合 = 比对口径 ∪ 已有解释(解释留档但当前已不是差异的坐标也看得见);
 *  - 展示态**只从 `difference_reason.status` 取**(没有解释记录 ⇒ 状态机默认态 `not_queried`)。
 *
 * ── 它不做什么 ────────────────────────────────────────────────────────────
 * **不查平台、不写库**。凭据一概不需要。要产生数据请先跑
 * `scripts/reconcile-live.mjs`(独立脚本支持 `MIIT_COOKIE`)。
 *
 * 用法:
 *   node scripts/roster-reason-report.mjs [选项]
 *
 * 选项:
 *   --db <路径>   数据库(默认 NUXT_DB_PATH,再默认 data/roster.db)
 *   --json        以 JSON 输出(便于存档 / 对比)
 *   --help
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 与 `reconcile-live.mjs` 同一个理由:Node 自带的类型剥离默认只删类型,
// 遇到枚举 / 构造器参数属性会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,而本仓的
// `server/utils/roster-import.ts` 里就有构造器参数属性。该开关只能由命令行给,
// 所以这里把进程重启一次并带上它(只重启一次)。
if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(result.status ?? 1)
}

// 让本脚本能 import 本仓的 `.ts` 核心(见 hooks 文件里为什么需要它)。
register(new URL('./lib/ts-resolve-hooks.mjs', import.meta.url), import.meta.url)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

if (has('help')) {
  process.stdout.write(
    `写回后的平台原因分布(只读;RL-15)

用法: node scripts/roster-reason-report.mjs [选项]

  --db <路径>   数据库(默认 NUXT_DB_PATH,再默认 data/roster.db)
  --json        以 JSON 输出
  --help

不查平台、不写库;要产生数据先跑 scripts/reconcile-live.mjs。
`,
  )
  process.exit(0)
}

const dbPath = resolve(flag('db', process.env.NUXT_DB_PATH ?? resolve(ROOT, 'data/roster.db')))
if (!existsSync(dbPath)) {
  process.stderr.write(`✗ 数据库不存在:${dbPath}(用 --db 指定)\n`)
  process.exit(2)
}

const { useDb } = await import('../db/client.ts')
const { listRosterDifferences } = await import('../lib/roster/enterprise-roster.ts')
const { DIFFERENCE_REASONS, DIFFERENCE_STATUSES, TITLES, TITLE_ORDER } = await import('../lib/labels.ts')
const { MAX_PAGE_SIZE } = await import('../lib/query.ts')

const db = useDb({ dbPath })

/** 分页取完 —— `listRosterDifferences` 与 HTTP 端点同样受 `MAX_PAGE_SIZE` 约束。 */
function allDifferenceRows() {
  const rows = []
  let page = 1
  for (;;) {
    const result = listRosterDifferences(db, { page, pageSize: MAX_PAGE_SIZE })
    rows.push(...result.rows)
    if (rows.length >= result.total || !result.rows.length) return { rows, total: result.total }
    page += 1
  }
}

const { rows, total } = allDifferenceRows()

const grid = new Map()
const bump = (key) => grid.set(key, (grid.get(key) ?? 0) + 1)
for (const row of rows) {
  bump(`${row.titleCode}|${row.status}|${row.reasonCode ?? ''}`)
}

const queries = db.$client.prepare('select interface, rdjb, status, count(*) c from platform_query group by 1,2,3 order by 1,2,3').all()
const queryTotal = db.$client.prepare('select count(*) c from platform_query').get().c
const relationTotal = db.$client.prepare('select count(*) c from platform_relation').get().c
const aliasTotal = db.$client.prepare('select count(*) c from enterprise_alias').get().c

const report = {
  db: dbPath,
  total,
  byTitle: Object.fromEntries(
    TITLE_ORDER.map((code) => [
      code,
      Object.fromEntries(
        [...grid.entries()]
          .filter(([key]) => key.startsWith(`${code}|`))
          .sort()
          .map(([key, value]) => {
            const [, status, reason] = key.split('|')
            return [`${status}${reason ? ` × ${reason}` : ''}`, value]
          }),
      ),
    ]),
  ),
  byReason: Object.fromEntries(
    [...grid.entries()].reduce((acc, [key, value]) => {
      const reason = key.split('|')[2] || '(无原因编码)'
      acc.set(reason, (acc.get(reason) ?? 0) + value)
      return acc
    }, new Map()),
  ),
  platform: { queries: queryTotal, relations: relationTotal, aliases: aliasTotal, byQuery: queries },
}

if (has('json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
}

const lines = [`平台原因分布(库内当前解释)— ${dbPath}`, `差异坐标合计 ${total}`, '']
for (const code of TITLE_ORDER) {
  const buckets = Object.entries(report.byTitle[code])
  lines.push(`【${TITLES[code] ?? code}】`)
  if (!buckets.length) lines.push('  (无)')
  for (const [key, value] of buckets) {
    const [status, reason] = key.split(' × ')
    const statusLabel = DIFFERENCE_STATUSES[status] ?? status
    const reasonLabel = reason ? ` · ${DIFFERENCE_REASONS[reason] ?? reason}` : ''
    lines.push(`  ${statusLabel}${reasonLabel}(${[status, reason].filter(Boolean).join(' × ')}) → ${value}`)
  }
  lines.push('')
}
lines.push('【全称号合一 · 按原因】')
for (const [reason, value] of Object.entries(report.byReason).sort()) {
  lines.push(reason === '(无原因编码)' ? `  无原因编码 → ${value}` : `  ${DIFFERENCE_REASONS[reason] ?? reason}(${reason}) → ${value}`)
}
lines.push('', `【平台证据体量】查询 ${queryTotal} · 关系 ${relationTotal} · 曾用名 ${aliasTotal}`)
for (const row of queries) {
  lines.push(`  ${row.interface} rdjb=${row.rdjb || '(无)'} ${row.status} → ${row.c}`)
}
process.stdout.write(`${lines.join('\n')}\n`)
