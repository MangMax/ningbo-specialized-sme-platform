import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Supported boundary, not an import closure: offline recovery can consume any
// server/lib/db source. Unknown and deleted paths require history. Only these
// explicit leaf surfaces are safe to skip; no parser or installed packages needed.
export function selectUpgrade(paths) {
  return paths.some(path => {
    if (!existsSync(path)) return true
    if (/^tests\/(support|fixtures)\//.test(path)) return true
    if (/^tests\//.test(path)) {
      return !path.endsWith('.test.ts') || path.endsWith('.upgrade.test.ts')
    }
    if (/^(app|components|pages|layouts|composables|assets|public)\//.test(path)) return false
    if (/^docs\//.test(path)) return path.startsWith('docs/adr/')
    if (/^README[^/]*$/.test(path)) return false
    return true
  })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(selectUpgrade(readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)))
}
