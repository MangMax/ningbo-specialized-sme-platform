import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.resolve('nuxt/package.json'))
const { createJiti } = require('jiti')
const { extendRosterImportOpenApi } = await createJiti(import.meta.url).import('../layers/sme-roster/server/modules/sme-roster/roster-import-openapi.ts')

const actions = ['preflight', 'commit']
const paths = Object.fromEntries(actions.map(action => [`/api/roster/import/${action}`, { post: {} }]))
extendRosterImportOpenApi({ paths })

const bodies = actions.map(action => {
  const route = new URL(`../layers/sme-roster/server/api/roster/import/${action}.post.ts`, import.meta.url)
  const source = readFileSync(route, 'utf8')
  assert.match(source, new RegExp(`createRosterImportHandler\\('${action}'\\)`))
  assert.doesNotMatch(source, /\brequestBody\s*:/, 'Import request schema belongs to the shared discovery provider')
  const body = paths[`/api/roster/import/${action}`].post.requestBody
  assert.ok(body?.required)
  return body
})
assert.deepEqual(bodies[0], bodies[1])

if (!process.argv.includes('--check')) console.log(JSON.stringify(bodies[0], null, 2))
else console.log('Verified shared roster import request discovery')
