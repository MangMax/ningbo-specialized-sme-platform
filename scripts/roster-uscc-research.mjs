#!/usr/bin/env node
/**
 * **缺统一社会信用代码企业的补录**（RL-06）—— 可运行入口。
 *
 * 用户 2026-10-16 给的方法顺序是「**先库内、后平台**」：
 *
 *   ① 从公布名抓核心词（去区划前缀 + 去组织形式后缀，`宁波上航测绘有限公司` → `上航测绘`）；
 *   ② 在**我们自己的库**里搜（企业现名 **+ 已确认曾用名** —— 曾用名表就是匹配字典的一部分）；
 *   ③ 代理从命中的候选里判断哪些最可能是同一家，取它的统一社会信用代码；
 *   ④ 拿这个统代**去平台按统代查**（`businessList` rdjb=1/2/3 + `queryList`）验证；
 *   ⑤ 关系里 `qymc` **逐字等于**公布名 ⇒ 独立原始证据成立 ⇒ 回填统代 + 建曾用名。
 *
 * 库内搜不出时才退到辅助手段：平台 `queryList?qymc=<名称>` 子串反查（`--claims` 那条路）。
 *
 * ── 这个脚本做三件事 ────────────────────────────────────────────────────
 *   1. `GET /api/roster/uscc-research` —— 读**待查清单**与**库内计划**
 *      （补齐 / 冲突 / 未找到 / 待人工 四项计数 + 逐条理由 + 一份可直接提交的请求体）；
 *   2. `--claims <file>` —— 把公开来源查证结果（票面路径二）`POST` 回同一路径；
 *      `--verdicts <dir>` —— 把**批次判断代理的判定文件**（`uscc-verdict-batch-<N>.json`）
 *      整份 `POST` 回同一路径（**归一化与取舍在服务端**：只采纳 `resolved` +
 *      `qymcEqualsAnnouncedName === true`，且证据要能在库里对上）；
 *   3. 有可执行项时把 `plan.request` 原样 `POST /api/roster/import/commit` ——
 *      与其它写入走**同一条**路径（单批事务、幂等键、逐项错误、血缘）。
 *
 * ── 红线 ────────────────────────────────────────────────────────────────
 * 脚本**不做任何判定**：核心词、候选、逐字证据、四桶归类、判定文件的取舍全部在服务端
 * （`server/utils/uscc-research.ts`、`server/utils/uscc-verdicts.ts`）。这里只搬运 JSON 文件。
 *
 * 用法：
 *   NUXT_API_TOKEN=<运行时密钥> node scripts/roster-uscc-research.mjs --base-url http://127.0.0.1:3000
 *   NUXT_API_TOKEN=<密钥> node scripts/roster-uscc-research.mjs --verdicts <判定文件目录> --strict
 *   NUXT_API_TOKEN=<密钥> node scripts/roster-uscc-research.mjs --claims claims.json
 *
 * 退出码：0 成功；1 提交失败；2 用法/读报告失败；3 `--strict` 且仍有未补齐的目标。
 * token 只从环境读，**不打印、不写文件**。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      '用法: NUXT_API_TOKEN=<token> node scripts/roster-uscc-research.mjs [选项]',
      '',
      '  --base-url <URL>   应用基址（默认 http://127.0.0.1:3000）',
      '  --claims <file>    公开来源查证结果 JSON（数组；每项 { enterpriseId|enterpriseName, uscc, source }）',
      '  --verdicts <dir>   批次判断代理的判定文件目录（读 uscc-verdict-batch-1..5.json 整份上传）',
      '  --q <关键词>       只处理名称/曾用名命中的目标',
      '  --title <代号>     只处理该称号（可重复，逗号分隔）',
      '  --dry-run          只读报告与计划，不提交',
      '  --strict           仍有未补齐的目标时以退出码 3 结束',
      '',
      '路径一（库内核心词 → 平台按统代验证）不需要任何参数；路径二（公开来源查证）用 --claims。',
    ].join('\n'),
  )
  process.exit(0)
}

const baseUrl = (flag('base-url', process.env.ROSTER_BASE_URL ?? 'http://127.0.0.1:3000')).replace(/\/+$/, '')
const dryRun = args.includes('--dry-run')
const strict = args.includes('--strict')
const claimsFile = flag('claims')
const verdictsDir = flag('verdicts')
/** 清单筛选：GET 走 query string，POST（带 claims）走 JSON body —— 同一组参数两种载体。 */
const filters = {}
if (flag('q')) filters.q = flag('q')
if (flag('title')) filters.title = flag('title')

/** 把 HTTP 响应尽力解析成 JSON；非 2xx 抛出带响应体的错误。 */
async function call(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body ? String(body.message) : String(text || response.status)
    throw new Error(`HTTP ${response.status} ${path}：${message}`)
  }
  return body
}

let claims = []
if (claimsFile) {
  try {
    claims = JSON.parse(readFileSync(claimsFile, 'utf8'))
    if (!Array.isArray(claims)) throw new Error('顶层必须是数组')
  } catch (error) {
    console.error(`✗ 读 --claims 文件失败：${error.message}`)
    process.exit(2)
  }
}
if (claims.length) {
  console.log(`（本轮并入 ${claims.length} 条公开来源查证结果）`)
}

/**
 * 读判定文件：**整份**交给服务端（`{ file, value }` 成对），脚本不解析它们的内容 ——
 * 「哪些条目能被采纳」是服务端判定（`normalizeUsccVerdicts`），判定规则只有一处。
 */
const verdictFiles = []
if (verdictsDir) {
  for (const batch of [1, 2, 3, 4, 5]) {
    const file = `uscc-verdict-batch-${batch}.json`
    try {
      verdictFiles.push({ file, value: JSON.parse(readFileSync(join(verdictsDir, file), 'utf8')) })
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`✗ 读判定文件 ${file} 失败：${error.message}`)
        process.exit(2)
      }
      console.log(`（${file} 尚未产出，跳过）`)
    }
  }
  console.log(`（本轮读取判定文件 ${verdictFiles.length} 份）`)
}

const usePost = claims.length > 0 || verdictFiles.length > 0
const query = new URLSearchParams(filters).toString()
const report = await call(
  usePost ? '/api/roster/uscc-research' : `/api/roster/uscc-research${query ? `?${query}` : ''}`,
  usePost
    ? {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...filters, claims, verdictFiles }),
      }
    : {},
).catch((error) => {
  console.error(`✗ 读补录报告失败：${error.message}`)
  process.exit(2)
})

if (report.verdicts) {
  for (const batch of report.verdicts.batches) {
    console.log(`  判定批次 ${batch.batch ?? '?'}（${batch.file}）· ${batch.items} 条 · 产出 ${batch.generatedAt ?? '(缺 generatedAt)'}`)
  }
  console.log(`  判定文件采纳 ${report.verdicts.accepted} 条（其余按原判定不动库）`)
  for (const item of report.verdicts.untouched) {
    console.log(
      `  · 不动库 ${item.enterpriseId}「${item.name}」：${item.verdict} —— ${item.reason}` +
        (item.blocked ? `【需核对原件：${item.blocked}】` : ''),
    )
  }
  for (const problem of report.verdicts.problems) console.log(`  ⚠ 判定文件问题：${problem}`)
}

const plan = report.plan
console.log(`待查清单：仍缺统一社会信用代码的企业 ${report.checklist.counts.total} 家`)
console.log(
  `分项：补齐 ${plan.counts.filled} · 冲突 ${plan.counts.conflict} · 未找到 ${plan.counts.notFound} · 待人工 ${plan.counts.manual}` +
    `（闭合 ${plan.counts.closed}；库内路径 ${plan.counts.byRoute.library}、平台证据认领 ${plan.counts.byRoute.platform_claim}、公开来源 ${plan.counts.byRoute.public_source}；` +
    `其中 ${plan.counts.aliasAlreadyPresent} 条规范行已有同名曾用名 ⇒ 只并身份不重复写别名）`,
)
for (const item of plan.ready) {
  const route = item.route === 'library' ? '库内核心词' : '公开来源'
  const evidence = item.evidence
    ? `；证据 ${item.evidence.interface}${item.evidence.rdjb ? ` rdjb=${item.evidence.rdjb}` : ''} 序号 ${item.evidence.sequenceNo}` +
      `${item.evidence.relationKey ? `（${item.evidence.relationKey}）` : ''} @${item.evidence.queriedAt} qymc=「${item.evidence.nameRaw}」`
    : `；来源 ${item.backfill?.source?.url ?? '(公开来源)'}（查证于 ${item.backfill?.source?.checkedOn ?? '—'}）`
  console.log(`  ✓ 补齐 ${item.targetId}「${item.targetName}」→ ${item.uscc}（${route}）${evidence}`)
}
for (const item of plan.pending) {
  const mark = item.outcome === 'conflict' ? '⚠ 冲突' : item.outcome === 'not_found' ? '· 未找到' : '△ 待人工'
  console.log(`  ${mark} ${item.targetId}「${item.targetName}」：${item.code} —— ${item.message}`)
}

if (plan.request == null) {
  console.log('没有可执行项（证据不足的目标一律不补）。')
  process.exit(strict && plan.counts.closed < report.checklist.counts.total ? 3 : 0)
}
if (dryRun) {
  console.log(`--dry-run：未提交。幂等键 ${plan.request.idempotencyKey}`)
  process.exit(0)
}

const token = process.env.NUXT_API_TOKEN
if (!token) {
  console.error('✗ 提交需要 NUXT_API_TOKEN（只从环境读；未配置时写入整体关闭）')
  process.exit(2)
}
const result = await call('/api/roster/import/commit', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(plan.request),
}).catch((error) => {
  console.error(`✗ 提交失败：${error.message}`)
  process.exit(1)
})

console.log(
  `提交结果：${result.status} · 批次 ${result.batchId} · written ${result.summary.written} / skipped ${result.summary.skipped} / failed ${result.summary.failed}`,
)
for (const item of result.items ?? []) {
  if (item.kind !== 'merge' && item.kind !== 'uscc_backfill') continue
  if (!item.ok) {
    console.error(`  ✗ ${item.ref}：${item.error?.code} ${item.error?.message ?? ''}`)
    continue
  }
  if (item.kind === 'merge') {
    const lineage = item.detail?.lineage
    console.log(
      `  ✓ ${item.ref}：记录 ${lineage?.childRowsMoved?.records ?? 0} 条、事件 ${lineage?.eventsMoved?.length ?? 0} 条、出处 ${lineage?.evidenceMoved?.length ?? 0} 条归入规范行 ${lineage?.intoEnterpriseId}`,
    )
  } else {
    const lineage = item.detail?.lineage
    console.log(`  ✓ ${item.ref}：企业 ${lineage?.enterpriseId}「${lineage?.enterpriseName}」补上统代 ${lineage?.uscc}`)
  }
}
if (result.status !== 'committed' || (result.summary?.failed ?? 0) > 0) process.exit(1)
process.exit(strict && plan.counts.closed < report.checklist.counts.total ? 3 : 0)
