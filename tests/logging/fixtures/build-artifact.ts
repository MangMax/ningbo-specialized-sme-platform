import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function hashBuiltServer() {
  const directory = '.output/server'
  const hash = createHash('sha256')
  for (const file of readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.mjs')).sort()) {
    hash.update(file + '\0')
    hash.update(createHash('sha256').update(readFileSync(join(directory, file))).digest())
  }
  return hash.digest('hex')
}
