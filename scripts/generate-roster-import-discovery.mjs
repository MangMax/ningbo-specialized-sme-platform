import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Nitro extracts literal route metadata only; keep it generated from the MCP/domain models.
const require = createRequire(import.meta.resolve('nuxt/package.json'))
const { createJiti } = require('jiti')
const { rosterImportOfficialDiscovery, rosterImportLegacyDiscovery } = await createJiti(import.meta.url).import('../layers/sme-roster/server/utils/roster-import-schema.ts')
for (const action of ['preflight', 'commit']) {
  const file = fileURLToPath(new URL(`../server/api/roster/import/${action}.post.ts`, import.meta.url))
  const source = readFileSync(file, 'utf8')
  const updated = source.replace(/payload: (\{\n[\s\S]*?\n\}),/, (_match, json) => {
    const payload = JSON.parse(json)
    Object.assign(payload.properties, rosterImportOfficialDiscovery, rosterImportLegacyDiscovery)
    payload.additionalProperties = true
    return `payload: ${JSON.stringify(payload, null, 2)},`
  })
  if (updated === source && !source.includes('"officialEvidenceAppends"')) throw new Error(`Missing payload literal: ${file}`)
  if (process.argv.includes('--check')) {
    if (updated !== source) throw new Error(`Regenerate import discovery: ${file}`)
  } else writeFileSync(file, updated)
}
