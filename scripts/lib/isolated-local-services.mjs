import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CHILD_EXIT_GRACE_MS = 3_000

function childIsRunning(child) {
  return child && child.exitCode === null && child.signalCode === null
}

const ownedChildren = new WeakMap()
function processTable() {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8' })
    .trim().split('\n').map(line => {
      const [pid, parent, ...started] = line.trim().split(/\s+/)
      return { pid: Number(pid), parent: Number(parent), started: started.join(' ') }
    })
}
/** Register while the launcher is alive, before its descendants can be orphaned. */
export function trackOwnedChild(child) {
  if (ownedChildren.has(child)) return ownedChildren.get(child)
  const state = { processes: new Map(), timer: undefined, error: undefined }
  const capture = () => {
    if (!childIsRunning(child)) return
    const table = processTable(), ids = new Set([child.pid])
    let changed = true
    while (changed) {
      changed = false
      for (const row of table) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true }
    }
    for (const row of table) if (ids.has(row.pid)) state.processes.set(row.pid, row.started)
  }
  capture()
  state.timer = setInterval(() => {
    try { capture() } catch (error) { state.error = error; clearInterval(state.timer) }
  }, 250)
  state.timer.unref()
  child.once('exit', () => clearInterval(state.timer))
  child.once('error', () => clearInterval(state.timer))
  ownedChildren.set(child, state)
  return state
}

export async function reserveLoopbackPort(requestedPort = 0) {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error(`Invalid RL10 verification port: ${requestedPort}`)
  }

  const reservation = createServer()
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      reservation.off('listening', onListening)
      reject(new Error(`Cannot reserve 127.0.0.1:${requestedPort}: ${error.code ?? error.message}`))
    }
    const onListening = () => {
      reservation.off('error', onError)
      resolve()
    }
    reservation.once('error', onError)
    reservation.once('listening', onListening)
    reservation.listen({ host: '127.0.0.1', port: requestedPort, exclusive: true })
  })

  const port = reservation.address().port
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  return port
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, child?: import('node:child_process').ChildProcess }} [options]
 */
export async function waitForHttp(url, { timeoutMs = 60_000, child } = {}) {
  if (child) trackOwnedChild(child)
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child && !childIsRunning(child)) {
      throw new Error(`Service child exited before ${url} became ready (exit=${child.exitCode}, signal=${child.signalCode})`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        if (child && !childIsRunning(child)) {
          throw new Error(`Service child exited while confirming ${url}`)
        }
        return response
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ''}`)
}

function parseLocalAddress(output) {
  const matches = [...output.matchAll(/Local:\s+(https?:\/\/[^\s]+)/g)]
  if (!matches.length) return null
  try {
    return new URL(matches.at(-1)[1])
  } catch {
    return null
  }
}

async function waitForNuxtListener(child, output, expectedPort, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`Nuxt exited before announcing its listener (exit=${child.exitCode}, signal=${child.signalCode})`)
  }

  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
      error ? reject(error) : resolve()
    }
    const inspect = () => {
      const address = parseLocalAddress(output())
      if (!address) return
      if (address.hostname !== '127.0.0.1' || Number(address.port) !== expectedPort) {
        finish(new Error(`Spawned Nuxt announced ${address.href}; expected http://127.0.0.1:${expectedPort}/`))
        return
      }
      finish()
    }
    const onData = (chunk) => {
      process.stdout.write(chunk)
      inspect()
    }
    const onExit = (code, signal) => finish(new Error(`Nuxt exited before readiness (exit=${code}, signal=${signal})`))
    const onError = (error) => finish(new Error(`Nuxt spawn failed: ${error.message}`))
    const timer = setTimeout(() => finish(new Error(`Nuxt did not announce its exact listener within ${timeoutMs}ms`)), timeoutMs)

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
    inspect()
  })
}

export async function stopOwnedChild(child) {
  if (!childIsRunning(child) && !ownedChildren.has(child)) return
  // Nuxt's CLI may exit before its app/native children. Keep only this
  // launcher's tracked descendants while ownership can be established; never
  // search by a port, executable name or shared workspace path.
  const state = trackOwnedChild(child)
  clearInterval(state.timer)
  // Refresh once more while the launcher is still alive. Identity checks keep
  // an exited/reused PID outside the set we are allowed to signal.
  const table = processTable()
  const ids = new Set([child.pid])
  for (let size = -1; size !== ids.size;) {
    size = ids.size
    for (const row of table) if (ids.has(row.parent)) ids.add(row.pid)
  }
  if (childIsRunning(child)) for (const row of table) if (ids.has(row.pid)) state.processes.set(row.pid, row.started)
  const owned = state.processes
  const living = () => processTable().filter(row => owned.get(row.pid) === row.started).map(row => row.pid)
  const wait = async duration => {
    const deadline = Date.now() + duration
    while (living().length && Date.now() < deadline) await sleep(100)
  }
  if (childIsRunning(child)) child.kill('SIGTERM')
  else for (const pid of living()) { try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error } }
  await wait(CHILD_EXIT_GRACE_MS)
  for (const pid of living().reverse()) {
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await wait(1_000)
  const remaining = living()
  ownedChildren.delete(child)
  if (remaining.length) throw new Error(`Owned service processes did not exit: ${remaining.join(',')}`)
  if (state.error) throw state.error
}

export async function startIsolatedNuxt({ cwd, portHint = 0, env = {} }) {
  const port = await reserveLoopbackPort(portHint)
  const baseUrl = `http://127.0.0.1:${port}`
  const nuxtCli = join(cwd, 'node_modules/nuxt/bin/nuxt.mjs')
  const child = spawn(process.execPath, [nuxtCli, 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  trackOwnedChild(child)
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const collect = (chunk) => { output += chunk }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  try {
    await waitForNuxtListener(child, () => output, port, 60_000)
    if (!childIsRunning(child)) throw new Error('Nuxt exited after announcing its listener')
    await waitForHttp(`${baseUrl}/`, { child })
    if (!childIsRunning(child)) throw new Error('Nuxt exited before startup verification completed')
    return { child, port, baseUrl, stop: () => stopOwnedChild(child) }
  } catch (error) {
    await stopOwnedChild(child)
    throw error
  }
}

export async function waitForChromeDevTools(chrome, profile, timeoutMs = 30_000) {
  const markerPath = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  let lastError
  let childError
  const onChildError = (error) => { childError = error }
  chrome.on('error', onChildError)
  try {
    while (Date.now() < deadline) {
      if (childError) throw new Error(`Chrome spawn failed: ${childError.message}`)
      if (!childIsRunning(chrome)) {
        throw new Error(`Chrome exited before publishing its DevTools port (exit=${chrome.exitCode}, signal=${chrome.signalCode})`)
      }
      try {
        const marker = (await readFile(markerPath, 'utf8')).trim().split(/\r?\n/)
        const port = Number(marker[0])
        const path = marker[1]
        if (Number.isInteger(port) && port > 0 && port <= 65_535 && path?.startsWith('/devtools/')) {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(2_000),
          })
          if (response.ok) {
            const version = await response.json()
            const socket = new URL(version.webSocketDebuggerUrl)
            if (socket.hostname !== '127.0.0.1' || Number(socket.port) !== port || socket.pathname !== path) {
              throw new Error('Chrome DevTools endpoint did not match its private startup marker')
            }
            if (!childIsRunning(chrome)) throw new Error('Chrome exited while confirming its DevTools endpoint')
            return version
          }
          lastError = new Error(`DevTools HTTP ${response.status}`)
        }
      } catch (error) {
        lastError = error
      }
      await sleep(100)
    }
    throw new Error(`Timed out waiting for spawned Chrome DevTools marker${lastError ? `: ${lastError.message}` : ''}`)
  } finally {
    chrome.off('error', onChildError)
  }
}
