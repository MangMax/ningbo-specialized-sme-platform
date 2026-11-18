import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.resolve('nuxt/package.json'))
const { transformSync } = require('esbuild') as { transformSync: (source: string, options: { loader: 'ts' }) => { code: string } }
function metadata(path: string) {
  const source = readFileSync(new URL(`../../../${path.startsWith('files/') ? 'layers/core/' : ''}server/api/${path}`, import.meta.url), 'utf8')
  // Nitro erases TypeScript before extracting the literal defineRouteMeta argument.
  const { code } = transformSync(source, { loader: 'ts' })
  let result: unknown
  runInNewContext(code.replace(/^import .*;$/gm, '').split('export default')[0]!, {
    defineRouteMeta: (value: unknown) => { result = value },
  })
  return result
}
it.each(['preflight', 'commit'])('retains literal %s discovery constraints after TypeScript erasure', action => {
  expect(metadata(`roster/import/${action}.post.ts`)).toMatchObject({ openAPI: { requestBody: { content: { 'application/json': { schema: { properties: { payload: { additionalProperties: true, properties: {
    officialEvidencePlanHash: { pattern: '^[a-f0-9]{64}$' },
    officialEvidenceAppends: { minItems: 1, maxItems: 100 },
    differences: { items: { properties: { reasonCode: { anyOf: [{ type: 'string' }, { type: 'null' }] } } } },
  } } } } } } } } })
})
it('retains physical recovery string limits after TypeScript erasure', () => {
  expect(metadata('files/[id]/physical-recovery.get.ts')).toMatchObject({ openAPI: { parameters: [{ schema: { type: 'string', maxLength: 100 } }] } })
  expect(metadata('files/[id]/physical-recovery.post.ts')).toMatchObject({ openAPI: { requestBody: { content: { 'application/json': { schema: { additionalProperties: false, properties: { intentId: { maxLength: 100 }, basis: { maxLength: 2000 } } } } } } } })
})
