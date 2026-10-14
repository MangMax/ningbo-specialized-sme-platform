#!/usr/bin/env node
/**
 * 票 19 的**真实**生产验收:`nuxt build` → 起 `.output/server/index.mjs` → curl。
 *
 * ── 为什么要有这个脚本,而不是一条 vitest ────────────────────────────────
 * 票面写的是「生产构建下 OpenAPI 端点**不暴露**(实测 404)」。「实测」这两个字
 * 只能靠**真的 build 一次、真的把产物跑起来**来兑现:
 *
 *  - `tests/agent-http.test.ts` 里那条断言问的是 **nitro 自己**(`createNitro({dev:false})`
 *    之后 handler 表里有没有那两条路由)—— 快、稳,但它验的是**构建期的决定**,
 *    不是**跑起来之后的响应**;
 *  - 把一次完整 build 塞进 `pnpm test` 会拖慢整个套件(十秒级),而且要点一个端口。
 *
 * 所以拆开:单元测试守「决定」,这个脚本守「事实」。它是**可重跑的** ——
 * 不是一次性的手测记录。
 *
 * 用法:`node scripts/verify-prod-openapi.mjs [--port 3489] [--skip-build]`
 * 退出码 0 = 全部通过;非 0 = 有一条不符合预期(并打印实际状态码)。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(flag('port', '3489'))
const SKIP_BUILD = args.includes('--skip-build')
const BASE = `http://127.0.0.1:${PORT}`

/** 期望 404 的(见 server/utils/openapi-guard.ts 的名单)。 */
const EXPECT_404 = ['/_openapi.json', '/_scalar', '/_swagger']
/** 期望 200 的:业务接口不受影响。 */
const EXPECT_200 = ['/api/health', '/api/jobs/kinds']

function run(command, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, cmdArgs, { stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))))
  })
}

async function status(path) {
  try {
    const res = await fetch(`${BASE}${path}`, { redirect: 'manual' })
    return res.status
  } catch (error) {
    return `ERR(${error.code ?? error.message})`
  }
}

async function waitReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await status('/api/health')) === 200) return true
    await sleep(250)
  }
  return false
}

if (!SKIP_BUILD) {
  console.log('▶ nuxt build …')
  await run('pnpm', ['build'])
}

if (!existsSync('.output/server/index.mjs')) {
  console.error('✗ 没有 .output/server/index.mjs —— 先 build(或不要加 --skip-build)')
  process.exit(1)
}

console.log(`▶ 起生产产物:PORT=${PORT} node .output/server/index.mjs`)
const server = spawn('node', ['.output/server/index.mjs'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'production',
    // 带一个 token 起来:验证「即便服务端配了 token,spec 端点在生产也照样 404」。
    NUXT_API_TOKEN: 'verify-prod-openapi-token',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', () => {})
server.stderr.on('data', (chunk) => process.stderr.write(chunk))

let failed = 0
try {
  if (!(await waitReady())) {
    console.error('✗ 生产服务没起来')
    process.exit(1)
  }

  for (const [paths, want] of [
    [EXPECT_404, 404],
    [EXPECT_200, 200],
  ]) {
    for (const path of paths) {
      const got = await status(path)
      const ok = got === want
      if (!ok) failed += 1
      console.log(`${ok ? '✓' : '✗'} ${path.padEnd(18)} ${got}(期望 ${want})`)
    }
  }
} finally {
  server.kill('SIGKILL')
}

console.log(failed ? `\n✗ ${failed} 条不符合预期` : '\n✓ 生产环境 OpenAPI 端点不可达,业务接口正常')
process.exit(failed ? 1 : 0)
