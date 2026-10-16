#!/usr/bin/env node
/**
 * **执行已确认的重名候选**（RL-14）。
 *
 * 导入侧现在会把「新建企业时库里已有同名行」显式报成**重名候选**；本脚本是那条候选到
 * **真的合并**之间的**可运行入口**：
 *
 *   1. `GET /api/roster/import/duplicate-candidates?batchKey=…` —— 读只读报告：
 *      哪些候选有平台关系证据（同一统代下 `qymc` **逐字等于**被并方名称）⇒ 可并，
 *      哪些查不到证据 ⇒ **待核（不并）**；报告里还带着一份可直接提交的请求体。
 *   2. 有可并项时把那份请求体 `POST /api/roster/import/commit` —— 与其它写入走**同一条**路径
 *      （单批事务、幂等键、逐项错误、血缘落 `import_batch.item_results`）。
 *
 * ── 为什么不复用 `lib/roster-import-client.ts` ──────────────────────────
 * 那是 TS 模块，裸 `node` 直接 import 不了（本仓没有 tsx/loader）。本脚本只做两件事：
 * GET 一份**契约形状**的报告、把报告里的 `request` 原样 POST 回去 —— 不构造请求体、
 * 不解析报告语义，判定全部在服务端（`server/utils/roster-duplicate-merge.ts`）。
 *
 * ── 可重放 ──────────────────────────────────────────────────────────────
 * 幂等键由**源批次 + 归并内容**在服务端派生：同样的证据重复跑 ⇒ 命中已提交批次、一行不增；
 * 之后补了新证据 ⇒ 内容变了 ⇒ 新键 ⇒ 新批次（原先待核的那几条这时才可能被并）。
 *
 * 用法：
 *   NUXT_API_TOKEN=<运行时密钥> node scripts/roster-duplicate-merge.mjs \
 *     --base-url http://127.0.0.1:3000 --batch-key 'jxj/little-giant#sha256:…'
 *
 * 退出码：0 成功（待核项只作提示）；1 提交失败；2 用法/读报告失败；3 有候选留待核（`--strict`）。
 * token 只从环境读，**不打印、不写文件**。
 */
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      '用法: NUXT_API_TOKEN=<token> node scripts/roster-duplicate-merge.mjs --base-url <URL> --batch-key <键> [--dry-run] [--strict]',
      '',
      '  --base-url   应用基址（默认 http://127.0.0.1:3000）',
      '  --batch-key  产出重名候选的导入批次幂等键（必填）',
      '  --dry-run    只读报告、不提交',
      '  --strict     有候选留待核时以退出码 3 结束',
    ].join('\n'),
  )
  process.exit(0)
}

const baseUrl = (flag('base-url', process.env.ROSTER_BASE_URL ?? 'http://127.0.0.1:3000')).replace(/\/+$/, '')
const batchKey = flag('batch-key')
const dryRun = args.includes('--dry-run')
const strict = args.includes('--strict')
if (!batchKey) {
  console.error('✗ 缺少 --batch-key（产出重名候选的导入批次幂等键）')
  process.exit(2)
}

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
    const message = body && typeof body === 'object' && 'message' in body ? String(body.message) : String(text || response.status)
    throw new Error(`HTTP ${response.status} ${path}：${message}`)
  }
  return body
}

const report = await call(`/api/roster/import/duplicate-candidates?batchKey=${encodeURIComponent(batchKey)}`).catch((error) => {
  console.error(`✗ 读重名候选报告失败：${error.message}`)
  process.exit(2)
})

console.log(`重名候选报告 · 批次 ${report.batchId}（${report.batchKey}）`)
console.log(`  候选 ${report.counts.candidates} 条 · 可并 ${report.counts.ready} 条 · 待核 ${report.counts.pending} 条`)
for (const item of report.pending) {
  console.log(`  ⚠ 待核 ${item.reason}：企业 ${item.candidate.existingEnterpriseId ?? '(未落行)'}「${item.candidate.existingEnterpriseName}」→ 统代 ${item.candidate.newUscc ?? '(空)'} —— ${item.message}`)
}
for (const item of report.ready) {
  console.log(
    `  ✓ 可并 企业 ${item.candidate.existingEnterpriseId}「${item.candidate.existingEnterpriseName}」→ 企业 ${item.candidate.newEnterpriseId}（统代 ${item.candidate.newUscc}）；` +
      `证据 ${item.evidence.interface}${item.evidence.rdjb ? ` rdjb=${item.evidence.rdjb}` : ''} 序号 ${item.evidence.sequenceNo}` +
      `${item.evidence.relationKey ? `（${item.evidence.relationKey}）` : ''} @${item.evidence.queriedAt} qymc=「${item.evidence.nameRaw}」`,
  )
  if (item.merge.canonicalName) {
    console.log(`      主名称以导出表为准 ⇒ 规范行改名为「${item.merge.canonicalName}」（原名落别名）`)
  } else if (item.exportName) {
    console.log(`      导出表侧的名字与现名一致，不改名`)
  } else {
    console.log(`      导出表侧没有这家企业的名字 ⇒ 不改名（不猜）`)
  }
}

if (report.request == null) {
  console.log('没有可并项（证据不足的候选一律不并）。')
  process.exit(strict && report.counts.pending > 0 ? 3 : 0)
}
if (dryRun) {
  console.log(`--dry-run：未提交。幂等键 ${report.request.idempotencyKey}`)
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
  body: JSON.stringify(report.request),
}).catch((error) => {
  console.error(`✗ 提交失败：${error.message}`)
  process.exit(1)
})

console.log(`提交结果：${result.status} · 批次 ${result.batchId} · written ${result.summary.written} / skipped ${result.summary.skipped} / failed ${result.summary.failed}`)
for (const item of result.items ?? []) {
  if (item.kind !== 'merge') continue
  if (!item.ok) {
    console.error(`  ✗ ${item.ref}：${item.error?.code} ${item.error?.message ?? ''}`)
    continue
  }
  const lineage = item.detail?.lineage
  console.log(
    `  ✓ ${item.ref}：记录 ${lineage?.childRowsMoved?.records ?? 0} 条、事件 ${lineage?.eventsMoved?.length ?? 0} 条、出处 ${lineage?.evidenceMoved?.length ?? 0} 条归入规范行 ${lineage?.intoEnterpriseId}`,
  )
}
if (result.status !== 'committed' || (result.summary?.failed ?? 0) > 0) process.exit(1)
process.exit(strict && report.counts.pending > 0 ? 3 : 0)
