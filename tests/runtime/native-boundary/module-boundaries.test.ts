import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const script = fileURLToPath(new URL('../../../scripts/verify-module-boundaries.mjs', import.meta.url))
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'module-boundaries-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function verify(files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  return spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
}

test.each(['../billing/public', '~/layers/billing/public', '~~/layers/billing/public', '@/layers/billing/public', '#layers/billing/public'])(
  'core cannot import a business layer through %s',
  specifier => {
    const statement = `import type { Invoice } from '${specifier}'`
    const result = verify({
      'layers/core/service.ts': statement,
      'layers/billing/public.ts': 'export type Invoice = { id: number }',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`layers/core/service.ts:1:1: core cannot depend on billing:\n  ${statement}`)
  },
)

test('cross-layer re-exports and dynamic imports must resolve to the public entrance', () => {
  const result = verify({
    'layers/advice/internal.ts': 'export { read } from "#layers/billing/public/internal"',
    'layers/advice/card.vue': '<template><p>Card</p></template>\n<script setup lang="ts">\nconst card = await import("#layers/billing/card.vue")\n</script>',
    'layers/billing/public/internal.ts': 'export function read() {}',
    'layers/billing/card.vue': '<template><p>Invoice</p></template>',
  })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('layers/advice/internal.ts:1:1: advice must use billing/public.ts:')
  expect(result.stderr).toContain('export { read } from "#layers/billing/public/internal"')
  expect(result.stderr).toContain('layers/advice/card.vue:3:20: advice must use billing/public.ts:')
  expect(result.stderr).toContain('import("#layers/billing/card.vue")')
})

test('permits a public entrance, same-layer code, core facilities and application composition', () => {
  const result = verify({
    'layers/core/service.ts': 'export { install } from "~/server/composition"',
    'server/composition.ts': 'import { read } from "#layers/billing/internal"; export const install = { read }',
    'layers/advice/use.ts': 'export { read } from "../billing/public.js"',
    'layers/advice/use-core.ts': 'export { install } from "#core/service"',
    'layers/billing/public.ts': 'export { read } from "./internal"',
    'layers/billing/internal.ts': 'export function read() {}',
  })

  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
})

test('table definitions cannot cross business layers through a shared schema barrel or public entrance', () => {
  const result = verify({
    'layers/billing/schema.ts': 'import { sqliteTable } from "drizzle-orm/sqlite-core"; export const invoice = sqliteTable("invoice", {})',
    'layers/billing/public.ts': 'export { invoice as exportedInvoice } from "./schema"',
    'db/index.ts': 'export * from "../layers/billing/schema"',
    'layers/advice/query.ts': 'import { invoice as table } from "@db"\nimport * as billing from "#layers/billing/public"',
  })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('layers/advice/query.ts:1:1: advice cannot import table invoice owned by billing:')
  expect(result.stderr).toContain('layers/advice/query.ts:2:1: advice cannot import table invoice owned by billing:')
  expect(result.stderr).toContain('import { invoice as table } from "@db"')
  expect(result.stderr).toContain('import * as billing from "#layers/billing/public"')
})

test.each([
  'db.prepare(\x60SELECT * FROM mine JOIN main.[Invoice] ON 1 = 1\x60)',
  'db.prepare("INSERT OR IGNORE INTO \\"invoice\\" DEFAULT VALUES")',
  'db.exec(\x60CREATE TABLE child (id REFERENCES invoice(id))\x60)',
  'db.prepare(\x60UPDATE OR REPLACE /* comment */ invoice SET id = ?\x60)',
  'db.prepare(\x60SELECT * FROM mine, invoice\x60)',
  'db.prepare("SELECT * FROM " + "invoice")',
])('rejects cross-business table references in SQL: %s', statement => {
  const result = verify({
    'layers/billing/schema.ts': 'export const invoice = sqliteTable("invoice", {})',
    'layers/advice/query.ts': `\n${statement}`,
  })

  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(/layers\/advice\/query\.ts:2:\d+: advice cannot reference table invoice owned by billing in SQL:/)
})

test('SQL can reference own and core tables and can mention foreign names in values or comments', () => {
  const result = verify({
    'layers/billing/schema.ts': 'export const invoice = sqliteTable("invoice", {})',
    'layers/core/schema.ts': 'export const sharedFile = sqliteTable("shared_file", {})',
    'layers/advice/schema.ts': 'export const note = sqliteTable("note", {})',
    'layers/advice/query.ts': [
      'import { sharedFile } from "#core/schema"',
      'import { note } from "./schema"',
      'db.prepare(\x60SELECT "from invoice" FROM note JOIN shared_file ON 1 = 1 -- JOIN invoice',
      '  WHERE content = \'FROM invoice\' /* FROM invoice */\x60)',
    ].join('\n'),
  })

  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
})

test('checks references to another business table declared in the shared schema', () => {
  const result = verify({
    'scripts/shared-schema-table-owners.json': '{"billing":["invoice"],"core":["stored_file"]}',
    'db/schema.ts': [
      'import { sqliteTable as table } from "drizzle-orm/sqlite-core"',
      'export const invoice = table("invoice", {})',
      'export const storedFile = table("stored_file", {})',
    ].join('\n'),
    'layers/billing/public.ts': 'export function readInvoice() {}',
    'layers/core/service.ts': 'import type * as schema from "@db/schema"',
    'layers/advice/query.ts': [
      'import { storedFile, invoice } from "@db/schema"',
      'db.prepare("SELECT * FROM \'invoice\'")',
    ].join('\n'),
  })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('layers/advice/query.ts:1:1: advice cannot import table invoice owned by billing:')
  expect(result.stderr).toContain('layers/advice/query.ts:2:12: advice cannot reference table invoice owned by billing in SQL:')
  expect(result.stderr).not.toContain('core/service.ts')
  expect(result.stderr).not.toContain('cannot import table stored_file')
})
