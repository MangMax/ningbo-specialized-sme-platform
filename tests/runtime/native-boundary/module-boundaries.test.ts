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

test('rejects a core dependency through a Vue external script', () => {
  const result = verify({
    'layers/core/Card.vue': '<template><div /></template>\n<script lang="ts" src="../billing/internal.ts"></script>',
    'layers/billing/internal.ts': 'export default { name: "BillingCard" }',
  })

  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(/layers\/core\/Card\.vue:2:\d+: core cannot depend on billing:/)
  expect(result.stderr).toContain('src="../billing/internal.ts"')
})

test('follows a Vue external script through an application-root bridge', () => {
  const result = verify({
    'layers/advice/Card.vue': '<script lang="ts" src="~/lib/card.ts"></script>',
    'lib/card.ts': 'export { default } from "../layers/billing/card"',
    'layers/billing/card.ts': 'export default { name: "BillingCard" }',
  })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('lib/card.ts:1:1: advice must use billing/public.ts:')
})

test('rejects a core or business dependency through application-root bridges', () => {
  const result = verify({
    'layers/core/service.ts': 'export { read } from "~/server/bridge"',
    'layers/alpha/service.ts': 'export { read } from "#server/bridge"',
    'server/bridge.ts': 'export { read } from "../lib/second-bridge"',
    'lib/second-bridge.ts': 'import "../server/bridge"\nexport { read } from "#layers/billing/internal"',
    'layers/billing/internal.ts': 'export function read() {}',
  })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('lib/second-bridge.ts:2:1: core cannot depend on billing:\n  export { read } from "#layers/billing/internal"')
  expect(result.stderr).toContain('lib/second-bridge.ts:2:1: alpha must use billing/public.ts:\n  export { read } from "#layers/billing/internal"')
})

test('permits standalone application composition, same-layer code, core facilities and public entrances', () => {
  const result = verify({
    'layers/core/service.ts': 'export function install() {}',
    'layers/core/Card.vue': '<!-- <script src="../billing/internal.ts"></script> -->\n<script lang="ts" src="./card.ts"></script>',
    'layers/core/card.ts': 'export default { name: "CoreCard" }',
    'server/composition.ts': 'import { install } from "#core/service"; import { read } from "#layers/billing/internal"; install(); read()',
    'layers/advice/use.ts': 'export { read } from "../billing/public.js"',
    'layers/advice/use-bridge.ts': 'export { read } from "~/server/public-bridge"',
    'server/public-bridge.ts': 'export { read } from "#layers/billing/public"',
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
  'db.exec(\x60CREATE TABLE IF NOT EXISTS invoice (id INTEGER)\x60)',
  'db.exec(\x60DROP TABLE IF EXISTS invoice\x60)',
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

test('checks the unquoted table name ignore in a FROM target', () => {
  const result = verify({
    'layers/billing/schema.ts': 'export const ignored = sqliteTable("ignore", {})',
    'layers/advice/query.ts': 'db.prepare("SELECT * FROM /* table target */ ignore")',
  })

  expect(result.status).toBe(1)
  expect(result.stderr.trim()).toBe('layers/advice/query.ts:1:12: advice cannot reference table ignore owned by billing in SQL:\n  "SELECT * FROM /* table target */ ignore"')
})

test.each([
  ['nested FROM target', 'SELECT * FROM ((main.[Invoice]))'],
  ['parenthesized JOIN target', 'SELECT * FROM mine JOIN (invoice AS i) ON 1 = 1'],
  ['comma inside a parenthesized table group', 'SELECT * FROM (mine, invoice)'],
  ['physical table inside a derived query', 'SELECT * FROM (SELECT * FROM invoice)'],
])('checks foreign SQL tables in a %s', (_name, sql) => {
  const result = verify({
    'layers/billing/schema.ts': 'export const invoice = sqliteTable("invoice", {})',
    'layers/advice/query.ts': `\ndb.prepare(${JSON.stringify(sql)})`,
  })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('layers/advice/query.ts:2:12: advice cannot reference table invoice owned by billing in SQL:')
})

test('resolves a local const interpolation at its lexical use site', () => {
  const statement = 'db.prepare(`SELECT * FROM ${table} WHERE id = ${id}`)'
  const result = verify({
    'layers/billing/schema.ts': 'export const invoice = sqliteTable("invoice", {})',
    'layers/advice/query.ts': [
      'const table = "own_table"',
      statement,
      'function read(id: number) {',
      '  const suffix = "voice" as const',
      '  const table = ("in" + suffix)',
      `  ${statement}`,
      '}',
    ].join('\n'),
  })

  expect(result.status).toBe(1)
  expect(result.stderr.trim()).toBe(`layers/advice/query.ts:6:14: advice cannot reference table invoice owned by billing in SQL:\n  ${statement.slice('db.prepare('.length, -1)}`)
})

test('resolves a local const table name in static SQL concatenation', () => {
  const sql = '"SELECT * FROM " + table'
  const result = verify({
    'layers/billing/schema.ts': 'export const invoice = sqliteTable("invoice", {})',
    'layers/advice/query.ts': [
      'const table = "own_table"',
      `db.prepare(${sql})`,
      'function read() {',
      '  const suffix = "voice" as const',
      '  const table = ("in" + suffix)',
      `  db.prepare(${sql})`,
      '}',
    ].join('\n'),
  })

  expect(result.status).toBe(1)
  expect(result.stderr.trim()).toBe(`layers/advice/query.ts:6:14: advice cannot reference table invoice owned by billing in SQL:\n  ${sql}`)
})

test('permits references to local CTEs named like a foreign table', () => {
  const result = verify({
    'layers/billing/schema.ts': 'export const invoice = sqliteTable("invoice", {})',
    'layers/advice/query.ts': [
      'db.prepare("WITH seed AS (SELECT 1), [Invoice](id) AS NOT MATERIALIZED (SELECT * FROM seed) SELECT * FROM ([invoice])")',
      'db.prepare("WITH RECURSIVE invoice(id) AS (VALUES (1) UNION ALL SELECT id + 1 FROM invoice WHERE id < 2) SELECT * FROM invoice")',
    ].join('\n'),
  })

  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
})

test.each([
  ['schema-qualified read', 'WITH invoice AS (SELECT 1) SELECT * FROM main.invoice'],
  ['schema-qualified read in a CTE body', 'WITH invoice AS (SELECT * FROM main.invoice) SELECT * FROM invoice'],
  ['write target', 'WITH invoice AS (SELECT 1) UPDATE invoice SET id = 2'],
  ['outside the nested CTE scope', 'SELECT * FROM (WITH invoice AS (SELECT 1) SELECT * FROM invoice), invoice'],
  ['in the subsequent statement', 'WITH invoice AS (SELECT 1) SELECT * FROM invoice; SELECT * FROM invoice'],
])('still reports a physical table for a CTE with a foreign name: %s', (_name, sql) => {
  const result = verify({
    'layers/billing/schema.ts': 'export const invoice = sqliteTable("invoice", {})',
    'layers/advice/query.ts': `\ndb.exec(${JSON.stringify(sql)})`,
  })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('layers/advice/query.ts:2:9: advice cannot reference table invoice owned by billing in SQL:')
})

test('SQL can reference own and core tables and can mention foreign names in values or comments', () => {
  const result = verify({
    'layers/billing/schema.ts': 'export const invoice = sqliteTable("invoice", {}); export const ignored = sqliteTable("ignore", {})',
    'layers/core/schema.ts': 'export const sharedFile = sqliteTable("shared_file", {})',
    'layers/advice/schema.ts': 'export const note = sqliteTable("note", {})',
    'layers/advice/query.ts': [
      'import { sharedFile } from "#core/schema"',
      'import { note } from "./schema"',
      'db.prepare(\x60SELECT "from invoice" FROM note JOIN shared_file ON 1 = 1 -- JOIN invoice',
      '  WHERE content = \'FROM invoice\' /* FROM invoice */\x60)',
      'db.prepare("UPDATE OR /* conflict action */ IGNORE note SET id = ?")',
      'db.prepare("WITH ignore AS (SELECT 1) SELECT * FROM ignore")',
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
