import { execFileSync, spawn, fork } from 'node:child_process'
import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CHILD_EXIT_GRACE_MS = 3_000

function childIsRunning(child) {
  return child && child.exitCode === null && child.signalCode === null
}

// Each isolated launcher gets a dedicated POSIX process group. Native children
// inherit it even if their launcher exits before cleanup; no PID-tree sampling.
const ownedGroups = new WeakMap()
function processTable(timeout) {
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid=,lstart='], { encoding: 'utf8', ...(timeout === undefined ? {} : { timeout }) })
    .trim().split('\n').map(line => {
      const [pid, group, ...started] = line.trim().split(/\s+/)
      return { pid: Number(pid), group: Number(group), started: started.join(' ') }
    })
}
function inOwnedGroup(start) {
  if (process.platform === 'win32') throw new Error('Isolated process-group services require POSIX')
  const child = start()
  if (child.pid) ownedGroups.set(child, { id: child.pid, started: processTable().find(row => row.pid === child.pid)?.started })
  return child
}
/** Preserve Node's stdio-specific return types and all call overloads. @type {typeof spawn} */
export const spawnOwnedChild = (command, args = [], options = {}) => {
  if (!Array.isArray(args)) { options = args; args = [] }
  return inOwnedGroup(() => spawn(command, args, { ...options, detached: true }))
}
/** @type {typeof fork} */
export const forkOwnedChild = (modulePath, args = [], options = {}) => {
  if (!Array.isArray(args)) { options = args; args = [] }
  return inOwnedGroup(() => fork(modulePath, args, { ...options, detached: true }))
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

/** Stop only a registered handle. Success remains Promise<void>; errors never resolve a receipt. */
export async function stopOwnedChild(child) {
  const owner = ownedGroups.get(child)
  if (!owner) {
    if (!child.pid || !childIsRunning(child)) return
    throw new AggregateError([new Error('Use spawnOwnedChild or forkOwnedChild to establish service ownership')],
      'Use spawnOwnedChild or forkOwnedChild to establish service ownership')
  }
  const group = owner.id
  // Preserve the 3s TERM / 1s KILL grace, reserving 500ms for final observation.
  // All stop-only ps calls share this budget; startup observations are unchanged.
  const deadline = Date.now() + CHILD_EXIT_GRACE_MS + 1_000 + 500
  const failures = []
  let lastObservation
  let observationFailureReason = 'observation-failed'
  const record = (phase, error) => { failures.push({ phase, error }) }
  const observe = () => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Owned service stop observation deadline exceeded')
    const table = processTable(Math.max(1, Math.min(250, remaining)))
    const leader = table.find(row => row.pid === group)
    // Keep the existing identity and group-continuity policy.
    const replaced = leader && owner.started && leader.started !== owner.started
    if (leader && !owner.started && !childIsRunning(child)) {
      observationFailureReason = 'identity-unverified'
      throw new Error('Cannot verify exited service group identity')
    }
    const members = table.filter(row => row.group === group).map(row => row.pid)
    lastObservation = { observedAt: Date.now(), members,
      reason: replaced ? 'identity-replaced' : members.length ? 'members-remain' : 'group-absent' }
    return lastObservation.reason !== 'members-remain'
  }
  // Recovery is bounded. An unsuccessful observation never authorizes a signal.
  const inspect = async phase => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return { confirmed: observe() } }
      catch (error) { record(phase, error) }
      if (attempt === 2 || Date.now() >= deadline) break
      try { await sleep(Math.min(25, Math.max(1, deadline - Date.now()))) }
      catch (error) { record(phase + '-wait', error); break }
    }
    return null
  }
  const signal = async value => {
    // Retry transient signal failures finitely, with fresh authority every time.
    for (let attempt = 0; attempt < (value === 'SIGTERM' ? 3 : 1); attempt++) {
      const current = await inspect(value + '-observe')
      if (!current || current.confirmed) return
      try { process.kill(-group, value); return }
      catch (error) { record(value, error) }
      if (Date.now() >= deadline) return
    }
  }
  const wait = async (duration, phase) => {
    const until = Math.min(Date.now() + duration, deadline - 500)
    while (Date.now() < until) {
      const current = await inspect(phase + '-observe')
      if (!current || current.confirmed) return
      try { await sleep(Math.min(25, Math.max(1, until - Date.now()))) }
      catch (error) { record(phase, error); return }
    }
  }
  await signal('SIGTERM')
  await wait(CHILD_EXIT_GRACE_MS, 'TERM-wait')
  await signal('SIGKILL')
  await wait(1_000, 'KILL-wait')
  const final = await inspect('final-observe')
  const confirmed = final?.confirmed === true
  if (confirmed) ownedGroups.delete(child)
  else record('final-verification', new Error('Owned service process group did not exit: ' + group))
  if (failures.length) {
    const error = new AggregateError(failures.map(failure => failure.error),
      'Owned service stop failed: ' + group)
    error.stopResult = Object.freeze({
      brand: 'isolated-local-services.stop', version: 1,
      termination: confirmed ? 'confirmed' : 'unconfirmed',
      reason: final ? lastObservation.reason : observationFailureReason,
      groupId: group,
      // null means unknown, never a fabricated empty group. Stale evidence is diagnostic only.
      finalMembers: final ? Object.freeze([...lastObservation.members]) : null,
      observedAt: final ? lastObservation.observedAt : null,
      lastObservation,
      failures: Object.freeze(failures.map(failure => Object.freeze(failure))),
    })
    throw error
  }
}

export async function startIsolatedNuxt({ cwd, portHint = 0, env = {} }) {
  const port = await reserveLoopbackPort(portHint)
  const baseUrl = `http://127.0.0.1:${port}`
  const nuxtCli = join(cwd, 'node_modules/nuxt/bin/nuxt.mjs')
  const child = spawnOwnedChild(process.execPath, [nuxtCli, 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
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
    try { await stopOwnedChild(child) }
    catch (cleanupError) {
      const combined = new AggregateError([error, cleanupError], 'Nuxt startup and owned service cleanup failed', { cause: error })
      combined.stopResult = cleanupError.stopResult
      throw combined
    }
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
