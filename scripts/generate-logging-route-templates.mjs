#!/usr/bin/env node
/**
 * Regenerate the application route allowlist from the built Nitro route table.
 * Run after `pnpm build` whenever an API route is added or renamed.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = '.output/server'
const target = 'lib/logging-route-templates.ts'
const source = readdirSync(directory, { recursive: true })
  .filter(file => file.endsWith('.mjs') && !file.split('/').includes('node_modules'))
  .map(file => readFileSync(join(directory, file), 'utf8'))
  .join('\n')
const routes = [...new Set(
  [...source.matchAll(/^\s*route: (['"])([^'"]+)\1,?$/gm)]
    .map(match => match[2].replace(/\/:([A-Za-z_][A-Za-z_0-9]*)\(\.\*\)$/, '/**:$1'))
    .filter(route => route === '/mcp' || route.startsWith('/api/')),
)].sort()
if (routes.length < 100) throw new Error(`refusing to write ${routes.length} route templates; build first`)

const body = routes.map(route => `  ${JSON.stringify(route)},`).join('\n')
const generated = `/**
 * Application route templates for runtime diagnostics. Generated from the built
 * Nitro route table; \`httpRoute\` is accepted only when it is an exact member.
 * Never add a concrete request path here. Run
 * \`node scripts/generate-logging-route-templates.mjs\` after a route change.
 */
export const APPLICATION_LOG_ROUTES: ReadonlySet<string> = new Set([
${body}
])
`
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== generated) throw new Error('Route templates differ; regenerate after building')
  console.log(`verified ${routes.length} route templates`)
} else {
  writeFileSync(target, generated)
  console.log(`wrote ${routes.length} route templates`)
}
