import { createPerformancePhases } from './performance-phases.mjs'

export function performanceController(server) {
  let id = 0
  const driver = createPerformancePhases()
  const command = (action, label) => new Promise((resolve, reject) => {
    const current = ++id
    const cleanup = () => { clearTimeout(timer); server.off('message', onMessage); server.off('exit', onExit) }
    const onExit = () => { cleanup(); reject(Error('Application exited during telemetry')) }
    const onMessage = message => {
      if (message?.type !== 'performance-phase' || message.id !== current) return
      cleanup(); message.error ? reject(Error(message.error)) : resolve(message.result)
    }
    const timer = setTimeout(() => { cleanup(); reject(Error('Telemetry phase timeout')) }, 5000)
    server.on('message', onMessage); server.once('exit', onExit)
    server.send({ type: 'performance-phase', id: current, action, label })
  })
  return {
    driver,
    async begin(label) { await command('begin', label); await driver.begin(label) },
    async end(label) { const app = await command('end', label); return { app, driver: await driver.end(label) } },
    close() { driver.close() },
  }
}
