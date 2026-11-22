import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnOwnedChild, reserveLoopbackPort, waitForHttp, stopOwnedChild } from './owned-process.mjs'
import { postgresRuntimeFixture } from './postgres-fixture.mjs'

const cwd = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
export function readDiscoveryArtifact(path) {
  const capture = JSON.parse(readFileSync(path, 'utf8'))
  if (capture.head !== head() || capture.source !== 'nuxt-dev/_openapi.json' || !capture.spec?.paths || !capture.spec?.openapi) {
    throw new Error('Development discovery artifact has wrong head or invalid capture metadata')
  }
  return capture.spec
}
export async function captureDiscovery() {
  const dir = mkdtempSync(join(tmpdir(), 'development-discovery-'))
  let child
  let postgres
  let output = ''
  try {
    postgres = await postgresRuntimeFixture({ dir })
    const port = await reserveLoopbackPort()
    child = spawnOwnedChild(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'dev', '--host', '127.0.0.1', '--port', String(port)], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, ...postgres.env, NUXT_DB_READONLY: '1', NUXT_BUILD_DIR: join(dir, 'build'),
        NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'),
        NUXT_ROSTER_EXPORT_DIR: join(dir, 'exports'),
      },
    })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000) })
    await waitForHttp(`http://127.0.0.1:${port}/api/health`, { child, timeoutMs: 90_000 })
    const response = await waitForHttp(`http://127.0.0.1:${port}/_openapi.json`, { child, timeoutMs: 90_000 })
    const spec = await response.json()
    if (!spec.paths || !spec.openapi) throw new Error('Invalid real development OpenAPI')
    return { head: head(), source: 'nuxt-dev/_openapi.json', capturedAt: new Date().toISOString(), spec }
  } catch (error) { throw new Error(String(error) + '\n' + output, { cause: error }) }
  finally {
    try { if (child) await stopOwnedChild(child) }
    finally {
      postgres?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Expected output artifact path')
  writeFileSync(process.argv[2], JSON.stringify(await captureDiscovery()))
}
