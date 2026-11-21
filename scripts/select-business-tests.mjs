import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inventory, matrices, loggingBusiness, postgresTestFiles } from './business-test-groups.mjs'
import { selectUpgrade } from './select-upgrade-tests.mjs'

// These are terminal HTTP surfaces. Shared implementation changes deliberately
// select all consumers; directory ownership is not a dependency graph.
const routes = [
  [/^(?:layers\/core\/)?server\/api\/logs\//, [loggingBusiness]],
]

export function selectBusinessTests(paths, event = 'pull_request') {
  const rows = inventory()
  const businesses = new Set()
  const reasons = []
  let full = event !== 'pull_request'
  for (const path of paths) {
    const test = rows.find(row => row.file === path)
    if (test) {
      businesses.add(test.business)
      reasons.push(`${path}: 测试所属业务`)
    } else if (/^(docs\/(?!adr\/)|README[^/]*$)/.test(path)) {
      reasons.push(`${path}: 文档，无业务测试`)
    } else {
      const route = existsSync(path) && routes.find(([pattern]) => pattern.test(path))
      if (route) {
        for (const row of rows) {
          if (route[1].some(prefix => row.business.startsWith(prefix))) businesses.add(row.business)
        }
        // HTTP contracts and cross-cutting instrumentation remain covered.
        businesses.add('运行环境 · 界面与基础设施')
        businesses.add(loggingBusiness)
        reasons.push(`${path}: HTTP 业务及接口、日志覆盖`)
      } else if (path.startsWith('layers/sme-roster/')) {
        full = true
        reasons.push(`${path}: 名录模块共享实现或非终端路由，全量`)
      } else if (path.startsWith('layers/core/')) {
        full = true
        reasons.push(`${path}: 平台底座共享实现，全量`)
      } else {
        full = true
        reasons.push(`${path}: 共享实现、资源或未知范围，全量`)
      }
    }
  }
  const upgrade = full || selectUpgrade(paths)
  const all = matrices(upgrade)
  const selected = {
    native: all.native.filter(group => full || (group.postgres
      ? paths.some(path => postgresTestFiles.includes(path))
      : businesses.has(group.business))),
    app: all.app.filter(group => full || businesses.has(group.business)),
  }
  const watcher = full || paths.includes('tests/runtime/development/nuxt-runtime-watch.http.app.test.ts')
  const ttl = full || paths.some(path => /^(?:(?:layers\/sme-roster\/)?server\/api\/roster\/|tests\/roster\/official-evidence\/)/.test(path))
  if (ttl) selected.app.push({ group: '深度测试 · 名录 · 快照真实过期', project: 'expiry' })
  if (watcher) selected.app.push({ group: '深度测试 · 运行环境 · 开发服务热更新', project: 'watcher' })
  return { ...selected, full, upgrade, ttl, watcher, reasons,
    skipped: [...all.native, ...all.app].filter(group => !selected[group.project].includes(group)).map(group => group.group) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = selectBusinessTests(readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean), process.env.EVENT)
  console.log(JSON.stringify(result, null, 2))
  if (process.env.GITHUB_OUTPUT) {
    for (const lane of ['native', 'app']) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${lane}=${JSON.stringify({ include: result[lane] })}\n${lane}_count=${result[lane].length}\n`)
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 回归范围：${result.full ? '全量' : '按改动选择'}\n\n${result.reasons.map(reason => `- ${reason}`).join('\n')}\n\n### 选中\n\n${[...result.native, ...result.app].map(row => `- ${row.group}`).join('\n') || '- 无业务测试；构建和类型检查仍必跑'}\n\n### 未选择（不代表通过）\n\n${result.skipped.map(group => `- ${group}`).join('\n')}\n`)
  }
}
