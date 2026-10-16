#!/usr/bin/env node
/**
 * 造一个**带「首次认定待确认」**的库,给 `scripts/verify-ledger-ui.mjs` 的 RL-08 那几条用。
 *
 * ── 为什么必须有它 ───────────────────────────────────────────────────────
 * 真库(2026-10-16 实测)里 **9946 条 `award` 一条都不缺年份,也一条都不缺出处**
 * ⇒ `status='pending'` **一次都不会触发**。于是「待确认」那条验收入口、那枚徽章、
 * 那句原因,在真库上**永远渲染不出来** —— 只看真库的话,那几条断言是 0 == 0 的空跑。
 * 一个「检查自己把自己跳过去」的验收比没有验收更坏(见 `verify-ledger-ui.mjs` 开头那段)。
 *
 * 所以这里把真库复制一份、只**追加**三行合成数据,让三个状态同时存在:
 *
 *  | 企业 | 事件 | 期望 |
 *  |---|---|---|
 *  | 甲 | 2021 认定(有出处)→ 2024 复核未通过 → 2025 再次获批 | `confirmed`,首次仍是 **2021** |
 *  | 乙 | 2021 认定,**没有出处行** | `pending` / `no_evidence` |
 *  | 丙 | 一条**定不了年**的认定 + 一条 2024 认定(有出处) | `pending` / `undated_award`,年份照给 2024 |
 *
 * 三行都是 `900001+` 的保留 id,不碰真库既有的任何一行;目标库里已经存在同 id 时**直接报错**,
 * 不覆盖、不猜。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 * ```
 * pnpm build                                              # 迁移要靠产物跑一次
 * node scripts/make-rl08-pending-db.mjs --from data/roster.db --to /tmp/rl08-pending/roster.db
 * NUXT_DB_PATH=/tmp/rl08-pending/roster.db node scripts/verify-ledger-ui.mjs --skip-build
 * ```
 * 退出码 0 = 库造好了;非 0 = 中途出错(并把原因打在 stderr)。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const FROM = resolve(flag('from', 'data/roster.db'))
const TO = resolve(flag('to', ''))
if (!flag('to', '')) {
  console.error('用法:node scripts/make-rl08-pending-db.mjs --from <真库> --to <目标库>')
  process.exit(2)
}
if (!existsSync(FROM)) {
  console.error(`找不到源库 ${FROM}(真库在仓库外,用 --from 指过去)`)
  process.exit(2)
}
/** 合成的三家企业用保留 id;/来源文件也带「合成」字样,免得被当成真出处。 */
const BASE = 900000

function columns(db, table) {
  return new Set(db.pragma(`table_info(${table})`).map((c) => c.name))
}

/**
 * 目标库要能跑 `record_event.review_outcome` / `decided_year` 这两列(RL-01 的迁移 0007)。
 * 源库由项目外 pipeline 写入,可能停在迁移之前 —— 那时直接起一次**产物**让 app 自己迁移,
 * 而不是在这里手写 `ALTER TABLE`:**迁移只有一处**。
 */
async function ensureMigrated(path) {
  const probe = new Database(path)
  const has = columns(probe, 'record_event').has('decided_year')
  probe.close()
  if (has) return

  if (!existsSync('.output/server/index.mjs')) {
    throw new Error('源库还没迁移,而 .output/server/index.mjs 不存在 —— 先 pnpm build')
  }
  const port = 3499 + (process.pid % 100)
  console.log(`▶ 源库缺 RL-01 的两列,起一次产物让 app 自己迁移(PORT=${port})`)
  const server = spawn('node', ['.output/server/index.mjs'], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), NITRO_PORT: String(port), NUXT_DB_PATH: path },
  })
  try {
    const deadline = Date.now() + 60_000
    let up = false
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
          up = true
          break
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(300)
    }
    if (!up) throw new Error('等不到产物起来(迁移没跑成)')
  } finally {
    server.kill()
    await sleep(500)
  }
}

async function main() {
  mkdirSync(dirname(TO), { recursive: true })
  copyFileSync(FROM, TO)
  // WAL 里可能还有没 checkpoint 的行,漏掉它就会「看不见」—— 一起拷。
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${FROM}${suffix}`)) copyFileSync(`${FROM}${suffix}`, `${TO}${suffix}`)
  }
  console.log(`▶ 复制 ${FROM} → ${TO}`)

  await ensureMigrated(TO)

  const db = new Database(TO)
  db.pragma('foreign_keys = ON')
  const clash = db.prepare('select id from enterprise where id >= ?').all(BASE)
  if (clash.length) {
    db.close()
    throw new Error(`目标库里已经有 id >= ${BASE} 的企业(${clash.length} 行)—— 换个 --to,别覆盖`)
  }

  const FILE_2022 = 'jxj/announcement/2022/甬经信中小〔2022〕145号合成夹具(不是真出处).pdf'
  const FILE_2024 = 'jxj/announcement/2024/合成夹具-2024年度认定名单(不是真出处).pdf'

  const addEnterprise = (n, name, uscc, district) => {
    const id = BASE + n
    db.prepare(
      'insert into enterprise (id, uscc_norm, name, name_norm, district, city, reg_status, quality_flags) values (?,?,?,?,?,?,?,?)',
    ).run(id, uscc, name, name, district, '宁波市', null, '[]')
    db.prepare(
      'insert into record (id, enterprise_id, title_code, source, district, uscc_raw, name_raw, quality_flags) values (?,?,?,?,?,?,?,?)',
    ).run(id, id, 'specialized_sme', 'jxj', district, uscc, name, '[]')
    return id
  }
  // `record_id` 显式给:它由 `addEnterprise` 建的那条 record 决定,不能从事件 id 推出来
  // (同一称号的几条事件挂在**同一条** record 上)。
  const addEvent = (eventId, recordId, eventType, year, decidedYear, reviewOutcome, batchSeq = null) =>
    db
      .prepare(
        'insert into record_event (id, record_id, event_type, year, batch_seq, sort_key, review_outcome, decided_year) values (?,?,?,?,?,?,?,?)',
      )
      .run(eventId, recordId, eventType, year, batchSeq, year ?? 0, reviewOutcome, decidedYear)
  const addEvidence = (eventId, sourceFile, attachment, listNo, page) =>
    db
      .prepare('insert into record_evidence (record_event_id, source_file, attachment, list_no, page) values (?,?,?,?,?)')
      .run(eventId, sourceFile, attachment, listNo, page)

  const jia = addEnterprise(1, '宁波合成甲股份有限公司', '91330211RL08SYNTH01X', '鄞州区')
  addEvent(BASE + 1, jia, 'award', 2021, 2021, null)
  addEvent(BASE + 2, jia, 'review', 2021, 2024, 'failed')
  addEvent(BASE + 3, jia, 'award', 2025, 2025, null, 1)
  addEvidence(BASE + 1, FILE_2022, '附件一', 74, null)

  const yi = addEnterprise(2, '宁波合成乙有限公司', '91330211RL08SYNTH02X', '余姚市')
  addEvent(BASE + 4, yi, 'award', 2021, 2021, null)
  // 乙**故意不写出处**:依据回不到出处 ⇒ 待确认(no_evidence)。

  const bing = addEnterprise(3, '宁波合成丙有限公司', '91330211RL08SYNTH03X', '象山县')
  addEvent(BASE + 5, bing, 'award', null, null, null)
  addEvent(BASE + 6, bing, 'award', 2024, 2024, null, 1)
  addEvidence(BASE + 6, FILE_2024, '附件二', 9, 12)

  db.close()
  console.log(`▶ 追加 3 家企业(甲 ${jia} / 乙 ${yi} / 丙 ${bing})与 6 条事件`)
  console.log('  期望:甲 confirmed(首次 2021)/ 乙 pending·no_evidence / 丙 pending·undated_award(年份 2024)')
  console.log('')
  console.log(`下一步:NUXT_DB_PATH=${TO} node scripts/verify-ledger-ui.mjs --skip-build`)
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  // 造了一半的库不要留着:它看起来像个能用的库,却少了几行。
  try {
    rmSync(TO, { force: true })
  } catch {
    /* ignore */
  }
  process.exit(1)
})
