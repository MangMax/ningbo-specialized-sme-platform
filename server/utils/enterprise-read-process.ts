import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

/** Worker-compatible lifecycle, with an OS process boundary for fatal V8 errors.
 * Explicit V8 flags override inherited NODE_OPTIONS, unlike Worker resourceLimits.
 * No application heap setting or timeout is changed. */
export function createEnterpriseReadProcess(entry: URL, sourceLoader?: string) {
  // Complete raw strings survive every IPC await in old/large-object space.
  // Reserve room for the SQLite JSON text + parsed string (2x raw bytes),
  // rather than giving most of the executor's allowance to short-lived tokens.
  // Redistribute the existing budget: 256 + 3*16 = 304MiB effective V8 heap,
  // below the former 128 + 3*64 = 320MiB. The app's heap is unchanged.
  const args = ['--max-old-space-size=256', '--max-semi-space-size=16']
  if (sourceLoader) args.push('--input-type=module', '--eval', sourceLoader)
  else args.push(fileURLToPath(entry))
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced',
  })
  const events = new EventEmitter()
  child.on('message', message => events.emit('message', message))
  child.on('error', error => events.emit('error', error))
  child.on('exit', (code, signal) => events.emit('exit', code, signal))
  return Object.assign(events, {
    postMessage(message: unknown) {
      child.send(message as object, error => { if (error) events.emit('error', error) })
    },
    ref() { child.ref(); child.channel?.ref() },
    unref() { child.unref(); child.channel?.unref() },
    terminate(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      return new Promise(resolve => {
        child.once('exit', () => resolve())
        // A blocking native SQLite call cannot process a cooperative stop message.
        child.kill('SIGKILL')
      })
    },
  })
}
