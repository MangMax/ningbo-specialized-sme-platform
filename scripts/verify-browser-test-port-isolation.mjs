#!/usr/bin/env node
/**
 * Prove the two RL-10 browser verification scripts fail closed when their requested
 * app port is already owned. The occupant is an in-process sentinel; it never writes
 * to a database and records every request so a mistaken connection fails this check.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const scripts = [
  'verify-detail-return-scroll.mjs',
  'verify-roster-return-chain.mjs',
]
const requests = []
const chromePath = process.env.CHROME_BIN ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((path) => existsSync(path))

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function close(server) {
  if (!server?.listening) return
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function makeAdjacentPorts() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const app = createServer((request, response) => {
      requests.push({ port: app.address().port, method: request.method, path: request.url })
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><html><body>sentinel occupant</body></html>')
      } else {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'sentinel blocks all API requests' }))
      }
    })
    const port = await listen(app)
    const debug = createServer((request, response) => {
      requests.push({ port: debug.address().port, method: request.method, path: request.url })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    debug.on('upgrade', (request, socket) => {
      requests.push({ port: debug.address().port, method: 'UPGRADE', path: request.url })
      socket.destroy()
    })
    try {
      await listen(debug, port + 1)
      return { app, debug, port }
    } catch {
      await close(app)
      await close(debug)
    }
  }
  throw new Error('could not reserve adjacent sentinel app and debug ports')
}

async function run(script, port) {
  const startedAt = Date.now()
  const childEnv = {
    ...process.env,
    RL10_TEST_PORT: String(port),
  }
  if (chromePath) childEnv.CHROME_BIN = chromePath
  else delete childEnv.CHROME_BIN
  const child = spawn(process.execPath, [join(process.cwd(), 'scripts', script), String(port)], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })
  let timeout
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${script} did not exit promptly on an occupied port`)), 15_000)
    }),
  ]).catch(async (error) => {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      /* process group already exited */
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve))
    }
    throw new Error(`${error.message}\n${output}`)
  }).finally(async () => {
    clearTimeout(timeout)
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      /* process group already exited */
    }
    await sleep(150)
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* process group already exited */
    }
  })
  return { ...result, output, elapsedMs: Date.now() - startedAt }
}

async function main() {
  const sentinel = await makeAdjacentPorts()
  try {
    const failures = []
    for (const script of scripts) {
      const before = requests.length
      const result = await run(script, sentinel.port)
      const observed = requests.slice(before)
      if (result.code === 0) failures.push(`${script} unexpectedly passed with an occupied port`)
      if (result.elapsedMs > 3_000) failures.push(`${script} did not fail immediately (${result.elapsedMs}ms)`)
      if (!result.output.includes(`Cannot reserve 127.0.0.1:${sentinel.port}`)) {
        failures.push(`${script} did not report the requested port reservation failure:\n${result.output}`)
      }
      if (observed.length) {
        failures.push(`${script} contacted the port occupant: ${JSON.stringify(observed)}\n${result.output}`)
      } else {
        console.log(`✓ ${script}: failed closed on occupied port ${sentinel.port} in ${result.elapsedMs}ms; occupant requests=0`)
      }
    }
    assert.deepEqual(failures, [], failures.join('\n\n'))
  } finally {
    await close(sentinel.app)
    await close(sentinel.debug)
  }
  await sleep(50)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
