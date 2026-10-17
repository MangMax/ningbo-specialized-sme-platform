#!/usr/bin/env node
/**
 * **出处页码补录**(RL-10)—— 可运行入口。
 *
 * 把**已核对过的 PDF 实际页序**通过应用公开 API(`POST /api/roster/evidence/pages`)写到既有
 * `record_evidence` 行上。脚本**不做任何判定**:定位、三态、留空待核全在服务端
 * (`lib/roster/evidence-page.ts` 的纯判据 + `server/utils/roster-evidence-pages.ts`)。
 * 这里只把两种输入形态搬成 API 的 `entries`,再把逐条结论打印出来。
 *
 * ── 两种输入 ────────────────────────────────────────────────────────────
 *
 *  - `--entries <file>` —— 直接给 API 的形状:数组,或 `{ "entries": [...] }`。
 *    每项 `{ sourceFile, listNo, page, enterpriseId?|enterpriseName?, district?, basis? }`。
 *  - `--from-visual-check <file>` —— **人工核对页图**的产出(本项目工作流里的
 *    `ocr-visual-check.json`)。每项 `{ enterpriseId, sourceFile, listNo, page, verdict, note }`,
 *    其中 `page` 是人逐页核对时**眼睛看到的那个页码**,`note` 写清了它在哪个附件的第几行。
 *    映射成 `{ sourceFile, listNo, page, enterpriseId, basis: "人工核对页图:<note>" }`。
 *    `verdict` 说的是**名字读得对不对**,与「这一行印在第几页」是两件事,故不参与筛选。
 *
 * ── 为什么必须带定位 ────────────────────────────────────────────────────
 *
 * 库里 `record_evidence` 没有分节列,而 `甬经信中小〔2022〕145号` 一份文件里三张名单的序号
 * **各自从 1 起算** —— 裸序号会定位到**另一家公司**。所以每条都要 `enterpriseId` 或
 * `enterpriseName`;服务端缺了就拒收(`entry_incomplete`),脚本不改这个判据。
 *
 * 用法:
 *   NUXT_API_TOKEN=<运行时密钥> node scripts/roster-evidence-pages.mjs --from-visual-check <核对文件>
 *   NUXT_API_TOKEN=<密钥> node scripts/roster-evidence-pages.mjs --entries pages.json --dry-run
 *
 * 退出码:0 成功(可能有待核项);1 请求失败;2 用法/读文件失败。
 * token 只从环境读,**不打印、不写文件**。
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      '用法: NUXT_API_TOKEN=<token> node scripts/roster-evidence-pages.mjs [选项]',
      '',
      '  --base-url <URL>            应用基址(默认 http://127.0.0.1:3000)',
      '  --entries <file>            直接给 API 形状的 JSON(数组或 { entries: [...] })',
      '  --from-visual-check <file>  人工核对页图的产出(ocr-visual-check.json)',
      '  --dry-run                   只报结论,不写库',
      '',
      '每项必须带 enterpriseId 或 enterpriseName 定位 —— 裸序号会被服务端拒收',
      '(同一份公布文件里可以有多个「序号各自从 1 起算」的分节名单)。',
    ].join('\n'),
  )
  process.exit(0)
}

const baseUrl = flag('base-url', process.env.ROSTER_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const dryRun = args.includes('--dry-run')
const entriesFile = flag('entries')
const visualFile = flag('from-visual-check')

function fail(message, code = 2) {
  console.error(message)
  process.exit(code)
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`读不了${what} ${file}:${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 人工核对页图 → API 的 `entries`。判据只有「有没有整数页码与定位」,不筛 `verdict`。 */
function fromVisualCheck(raw) {
  const items = Array.isArray(raw) ? raw : (raw?.items ?? [])
  const entries = []
  const skipped = []
  for (const it of items) {
    const page = Number(it?.page)
    const listNo = Number(it?.listNo)
    const ok =
      typeof it?.sourceFile === 'string' &&
      it.sourceFile !== '' &&
      Number.isInteger(page) &&
      page >= 1 &&
      Number.isInteger(listNo) &&
      listNo >= 1 &&
      Number.isInteger(Number(it?.enterpriseId))
    if (!ok) {
      skipped.push(it)
      continue
    }
    entries.push({
      sourceFile: it.sourceFile,
      listNo,
      page,
      enterpriseId: Number(it.enterpriseId),
      basis: `人工核对页图:${it.note ?? ''}`.trim(),
    })
  }
  return { entries, skipped }
}

let entries
let skipped = []
if (visualFile) {
  ;({ entries, skipped } = fromVisualCheck(readJson(visualFile, '核对文件')))
} else if (entriesFile) {
  const raw = readJson(entriesFile, '条目文件')
  entries = Array.isArray(raw) ? raw : (raw?.entries ?? [])
} else {
  fail('必须给 --entries <file> 或 --from-visual-check <file>(--help 看用法)')
}

if (!Array.isArray(entries) || entries.length === 0) {
  fail('没有可提交的条目 —— 检查输入文件里有没有整数 `page` / `listNo` 与 `sourceFile`。')
}
if (skipped.length > 0) {
  console.log(`跳过 ${skipped.length} 项:缺 sourceFile / 整数 page / 整数 listNo / enterpriseId。`)
}

const token = process.env.NUXT_API_TOKEN
if (!token) fail('没有 NUXT_API_TOKEN —— 写入口需要 token(只从环境读,不打印)。')

const res = await fetch(`${baseUrl}/api/roster/evidence/pages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ entries, dryRun }),
})

const body = await res.json().catch(() => null)
if (!res.ok) {
  console.error(`补录失败:HTTP ${res.status} ${body ? JSON.stringify(body, null, 2) : ''}`)
  process.exit(1)
}

const s = body.summary
console.log(
  [
    `${body.status === 'dry_run' ? '预演(未写库)' : '已写入'} · 提交 ${s.requested} 条`,
    `定得下来 ${s.assigned}(真改 ${s.written} / 值没变 ${s.unchanged})· 留空待核 ${s.pending}`,
  ].join('\n'),
)

if (body.assignments.length > 0) {
  console.log('\n已定位:')
  for (const a of body.assignments) {
    console.log(
      `  #${a.index} evidence#${a.evidenceId} ${a.sourceFile.split('/').pop()} 序号 ${a.listNo} → 第 ${a.page} 页` +
        `(原 ${a.previous ?? '空'})${a.basis ? ` · ${a.basis}` : ''}`,
    )
  }
}

if (body.pending.length > 0) {
  console.log('\n留空待核(一行没改):')
  for (const p of body.pending) {
    console.log(`  #${p.index} ${p.reason} —— ${p.detail}`)
  }
}

// 有待核项是**正常结果**(票面:未定/无法定位的留空并标待核),不是失败。
process.exit(0)
