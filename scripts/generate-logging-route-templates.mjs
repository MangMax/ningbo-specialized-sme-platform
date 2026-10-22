#!/usr/bin/env node
/**
 * Regenerate lib/logging/route-templates.ts from the built Nitro route table.
 * Run after `pnpm build` whenever an API route is added or renamed.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = '.output/server/chunks/nitro'
const source = readdirSync(directory)
  .filter(file => file.endsWith('.mjs'))
  .map(file => readFileSync(join(directory, file), 'utf8'))
  .join('\n')
const routes = [...new Set(
  [...source.matchAll(/route: '([^']+)'/g)]
    .map(match => match[1])
    .filter(route => route === '/mcp' || route.startsWith('/api/')),
)].sort()
if (routes.length < 100) throw new Error(`refusing to write ${routes.length} route templates; build first`)

const body = routes.map(route => `  ${JSON.stringify(route)},`).join('\n')
writeFileSync('lib/logging/route-templates.ts', `/**
 * Application route templates for runtime diagnostics. Generated from the built
 * Nitro route table; \`httpRoute\` is accepted only when it is an exact member.
 * Never add a concrete request path here. Run
 * \`node scripts/generate-logging-route-templates.mjs\` after a route change.
 */
export const APPLICATION_LOG_ROUTES: ReadonlySet<string> = new Set([
${body}
])
`)
console.log(`wrote ${routes.length} route templates`)
