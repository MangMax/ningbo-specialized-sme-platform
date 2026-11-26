import { execFileSync, spawn, fork } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

const CHILD_EXIT_GRACE_MS = 3_000

function childIsRunning(child) {
  return child && child.exitCode === null && child.signalCode === null
}

// Each isolated launcher gets a dedicated POSIX process group. Native children
// inherit it even if their launcher exits before cleanup; no PID-tree sampling.
const ownedGroups = new WeakMap()
function processTable() {
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8' })
    .trim().split('\n').map(line => {
      const [pid, group, state, ...started] = line.trim().split(/\s+/)
      return { pid: Number(pid), group: Number(group), state, started: started.join(' ') }
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

export async function stopOwnedChild(child, graceMs = CHILD_EXIT_GRACE_MS) {
  const owner = ownedGroups.get(child)
  if (!owner) {
    if (!child.pid || !childIsRunning(child)) return
    throw new Error('Use spawnOwnedChild or forkOwnedChild to establish service ownership')
  }
  const group = owner.id
  const members = () => {
    const table = processTable()
    const leader = table.find(row => row.pid === group)
    // A reused leader PID means the original group has already disappeared.
    if (leader && owner.started && leader.started !== owner.started) return []
    if (leader && !owner.started && !childIsRunning(child)) throw new Error('Cannot verify exited service group identity')
    return table.filter(row => row.group === group && !row.state?.startsWith('Z'))
  }
  const signal = value => {
    try { process.kill(-group, value); return true }
    catch (error) {
      if (error.code === 'ESRCH' || (error.code === 'EPERM' && !members().length)) return false
      throw error
    }
  }
  const wait = async duration => {
    const deadline = Date.now() + duration
    while (members().length && Date.now() < deadline) await sleep(25)
  }
  if (members().length) signal('SIGTERM')
  await wait(graceMs)
  if (members().length) signal('SIGKILL')
  await wait(1_000)
  if (members().length) throw new Error('Owned service process group did not exit: ' + group)
  ownedGroups.delete(child)
}

/** Start the build produced once by CI or `pnpm build`. */
export function spawnCompiledApp(port, options = {}) {
  return spawnOwnedChild(process.execPath, ['.output/server/index.mjs'], {
    ...options,
    env: { ...process.env, ...options.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port) },
  })
}
