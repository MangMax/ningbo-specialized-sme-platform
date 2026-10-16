#!/usr/bin/env node
/**
 * **演示/验收夹具**(RL-03)—— 把回归案例 `91330211255994457P` 的平台证据
 * 写进一份**临时库副本**,供人工在页面上核对「现名 / 曾用名 / 已核验处置 / 全部平台关系」。
 *
 * ⚠️ 这不是生产写入路径。正式写入走 RL-11 的统一批次 API(契约 §8);
 * 本脚本只往**临时副本**里灌样例数据,方便复核页面的**读**侧与接缝。
 * 它**拒绝**写到应用的真实 `data/roster.db`。
 *
 * 用法:
 *   node scripts/seed-platform-evidence-demo.mjs \
 *     --db <源库:含企业 375/7289 的真实 roster.db> \
 *     --out /tmp/platform-demo/roster.db
 *   NUXT_DB_PATH=/tmp/platform-demo/roster.db pnpm dev
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}
const source = flag('db')
const out = flag('out')
if (!source || !out) {
  console.error('用法:node scripts/seed-platform-evidence-demo.mjs --db <源库> --out <临时库路径>')
  process.exit(2)
}
const outPath = resolve(out)
const appDb = resolve(process.cwd(), 'data/roster.db')
if (outPath === appDb) {
  console.error(`✗ 拒绝写到应用真实库:${appDb}(请给一个临时路径,如 /tmp/…/roster.db)`)
  process.exit(2)
}
if (!existsSync(source)) {
  console.error(`✗ 源库不存在:${source}`)
  process.exit(2)
}

mkdirSync(dirname(outPath), { recursive: true })
rmSync(outPath, { force: true })
// `VACUUM INTO` 产出一份**一致**的副本(不必手工拷 -wal/-shm)。
const src = new Database(resolve(source), { readonly: true })
src.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`)
src.close()

const db = new Database(outPath)
db.pragma('foreign_keys = ON')
// 源库可能停在 0006(还没有 RL-01 冻结的那些表)—— 按 drizzle 的迁移台账补齐。
migrate(drizzle(db), { migrationsFolder: resolve(process.cwd(), 'db/migrations') })

const USCC = '91330211255994457P'
const NEW_NAME = '宁波上航测绘股份有限公司'
const OLD_NAME = '宁波上航测绘有限公司'

const enterprise = (name) =>
  db.prepare('select id from enterprise where name = ?').get(name)?.id ?? null

const newId = enterprise(NEW_NAME)
const oldId = enterprise(OLD_NAME)
if (newId == null || oldId == null) {
  console.error(`✗ 源库里找不到企业「${NEW_NAME}」/「${OLD_NAME}」;换个源库或先导入名录。`)
  process.exit(3)
}

// 幂等:清掉本脚本之前写过的演示数据(按演示固定的查询键 / 企业)。
db.prepare(
  `delete from platform_query where query_key = ? and queried_at in (
     '2026-10-15T17:11:21.514Z','2026-10-15T17:11:22.000Z','2026-10-15T17:11:23.000Z',
     '2026-10-15T17:11:24.000Z','2026-10-15T18:30:00.000Z')`,
).run(USCC)
db.prepare('delete from enterprise_alias where enterprise_id in (?, ?)').run(newId, oldId)
db.prepare('delete from difference_reason where enterprise_id in (?, ?)').run(newId, oldId)

const insertQuery = db.prepare(
  `insert into platform_query (interface, query_key, rdjb, title_code, queried_at, status, failure_reason, raw_response, created_at)
   values (@interface, @query_key, @rdjb, null, @queried_at, @status, @failure_reason, @raw_response, '2026-10-16T00:00:00.000Z')`,
)
const insertRelation = db.prepare(
  `insert into platform_relation
     (query_id, sequence_no, relation_key, enterprise_id, raw_fields, source_text, uscc_raw, name_raw,
      alias_name_raw, province, status, batch, declare_kind, applied_at, award_batch_label, year,
      match_basis, verification_status, created_at)
   values (@query_id, @sequence_no, @relation_key, @enterprise_id, @raw_fields, null, @uscc_raw, @name_raw,
      null, @province, @status, @batch, @declare_kind, @applied_at, @award_batch_label, @year,
      'uscc', 'confirmed', '2026-10-16T00:00:00.000Z')`,
)

const raw = JSON.stringify({ note: '演示夹具:裁剪后的关系字段,非平台原始 HTML 全文' })
function addQuery(values, relations) {
  const { lastInsertRowid } = insertQuery.run({
    failure_reason: null,
    raw_response: raw,
    ...values,
  })
  for (const relation of relations) insertRelation.run({ query_id: lastInsertRowid, enterprise_id: newId, raw_fields: raw, ...relation })
  return lastInsertRowid
}

const relation = (sequence_no, relation_key, name_raw, extra = {}) => ({
  sequence_no,
  relation_key,
  uscc_raw: USCC,
  name_raw,
  province: '宁波市',
  status: '待审核',
  batch: '2022-1',
  declare_kind: 'update',
  applied_at: null,
  award_batch_label: null,
  year: null,
  ...extra,
})

// businessList rdjb=1 / rdjb=2:请求成功、会话有效、0 行 ⇒ no_record。
addQuery({ interface: 'business_list', query_key: USCC, rdjb: '1', queried_at: '2026-10-15T17:11:21.514Z', status: 'no_record' }, [])
addQuery({ interface: 'business_list', query_key: USCC, rdjb: '2', queried_at: '2026-10-15T17:11:22.000Z', status: 'no_record' }, [])
// businessList rdjb=3:6 条关联(**曾用名证据就在前两条**)。
addQuery({ interface: 'business_list', query_key: USCC, rdjb: '3', queried_at: '2026-10-15T17:11:23.000Z', status: 'success' }, [
  relation(1, 'SQ332022062212391', OLD_NAME, { status: '终审通过', batch: '2022-1', declare_kind: 'apply', applied_at: '2022-06-22 17:17:52' }),
  relation(2, 'SQ332023041984270', OLD_NAME, { applied_at: '2023-04-19 16:46:01' }),
  relation(3, 'SQ332024052128274', NEW_NAME, { applied_at: '2024-05-21 14:10:06' }),
  relation(4, 'SQ332025060392166', NEW_NAME, { status: '省已审', batch: '2025-1', declare_kind: 'review', applied_at: '2025-06-21 09:50:48', award_batch_label: '第四批' }),
  relation(5, 'SQ332025062064737', NEW_NAME, { batch: '2025-1', applied_at: '2025-06-20 10:43:42' }),
  relation(6, 'SQ332026052238796', NEW_NAME, { batch: '2025-1', applied_at: '2026-05-22 16:49:44' }),
])
// queryList:2 条,与上面两条同名同 id(同一份记录在两个接口各出一次)。
addQuery({ interface: 'apply_list', query_key: USCC, rdjb: '', queried_at: '2026-10-15T17:11:24.000Z', status: 'success' }, [
  relation(1, 'SQ332025060392166', NEW_NAME, { status: '省已审', batch: '2025-1', declare_kind: 'review', applied_at: '2025-06-21 09:50:48', award_batch_label: '第四批', year: 2025 }),
  relation(2, 'SQ332022062212391', OLD_NAME, { status: '终审通过', batch: '2022-1', declare_kind: 'apply', applied_at: '2022-06-22 17:17:52', year: 2022 }),
])
// 会话过期 ⇒ failed(≠ no_record)。
addQuery({
  interface: 'business_list', query_key: USCC, rdjb: '3', queried_at: '2026-10-15T18:30:00.000Z',
  status: 'failed', failure_reason: 'business_list rdjb=3 queryKey=' + USCC + ':登录超时,请重新登录',
}, [])

// 代理确认的曾用名(来源 = rdjb=3 的第一条关系)。
db.prepare(
  `insert into enterprise_alias (enterprise_id, name, name_norm, source_kind, source_ref_id, valid_from, valid_to, verification_status, note, created_at)
   values (?, ?, ?, 'platform_business', 0, '2022-06-22 17:17:52', null, 'confirmed', ?, '2026-10-16T00:00:00.000Z')`,
).run(newId, OLD_NAME, OLD_NAME, '平台关系 SQ332022062212391 / SQ332023041984270 明确写出')
// 一条**待核**别名,演示 pending 不参与搜索/归并。
db.prepare(
  `insert into enterprise_alias (enterprise_id, name, name_norm, source_kind, source_ref_id, valid_from, valid_to, verification_status, note, created_at)
   values (?, ?, ?, 'manual', 0, null, null, 'pending', ?, '2026-10-16T00:00:00.000Z')`,
).run(newId, '宁波上航测绘（疑似旧写法）', '宁波上航测绘疑似旧写法', '演示:未经确认的候选')

// 已核验处置:更名 ⇒ 更新当前名并保留旧名为曾用名(原因 + 措施成对)。
db.prepare(
  `insert into difference_reason
     (enterprise_id, title_code, direction, status, reason_code, reason_note, measure_code, measure_note,
      evidence_query_id, evidence_relation_id, moved_in_city, moved_in_title_code, moved_in_year, moved_in_batch,
      verification_status, recorded_at, created_at)
   values (?, 'specialized_sme', 'extra_in_miit', 'confirmed_reason', 'renamed', ?, 'update_current_name', ?, null, null,
      null, null, null, null, 'confirmed', '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z')`,
).run(newId, '平台关系写出的历史名称与经信局公布名不一致,确认系更名', '旧名保留为曾用名,现名与曾用名都可查')

console.log('✓ 演示数据已写入:', outPath)
console.log(`  企业:${NEW_NAME} (#${newId}) / ${OLD_NAME} (#${oldId})`)
console.log('  下一步:')
console.log(`    NUXT_DB_PATH=${outPath} pnpm dev`)
console.log('    打开 http://localhost:3000/comparison (称号:专精特新;方向:应出未出)')
console.log('    点该行「平台证据」列的「平台关系 N 条 · 查看」→ /platform-queries?enterpriseId=' + newId)
db.close()
