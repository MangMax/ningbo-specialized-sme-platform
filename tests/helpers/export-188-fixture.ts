import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { initializeDb, schema as s } from '../../db/client'

export function export188Candidate(db: ReturnType<typeof initializeDb>, name: string, titleCode = 'specialized_sme') {
  const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, district: '鄞州区' }).returning().get()
  const record = db.insert(s.record).values({ enterpriseId: enterprise.id, nameRaw: name, titleCode, source: 'jxj' }).returning().get()
  const event = db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: new Date().getFullYear(), batchSeq: 1 }).returning().get()
  db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'jxj/announcement/synthetic-188.xlsx', attachment: '合成名单', listNo: enterprise.id }).run()
  return enterprise
}

/** Child entry: ACK is only valid after the single transaction and handle close. */
export function populateExport188DisconnectFixture(dbPath: string) {
  const db = initializeDb({ create: true,  dbPath })
  try {
    db.transaction(() => {
      for (let i = 0; i < 30000; i++) export188Candidate(db, '合成断开' + i + randomBytes(160).toString('hex'), 'innovative_sme')
    })
  } finally { db.$client.close() }
}

export async function seedExport188DisconnectFixture(dbPath: string) {
  const entry = fileURLToPath(import.meta.url)
  const jiti = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  const child = spawn(process.execPath, ['-e', `
    const { createJiti } = require(${JSON.stringify(jiti)});
    (async () => {
      const fixture = await createJiti(${JSON.stringify(entry)}, { fsCache: false }).import(${JSON.stringify(entry)});
      fixture.populateExport188DisconnectFixture(${JSON.stringify(dbPath)});
      process.send({ type: 'committed-and-closed' }, () => process.disconnect());
    })().catch(error => {
      process.exitCode = 1;
      process.send({ type: 'failed', message: String(error.message) }, () => process.disconnect());
    });
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      let acknowledged = false, failure: Error | undefined
      child.on('message', message => {
        const receipt = message as { type?: string; message?: string }
        if (receipt.type === 'committed-and-closed') acknowledged = true
        if (receipt.type === 'failed') failure = new Error('Export fixture seed failed: ' + receipt.message)
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (failure) reject(failure)
        else if (code === 0 && acknowledged) resolve()
        else reject(new Error(`Export fixture child closed without commit/close ACK (code=${code}, signal=${signal})`))
      })
      timer = setTimeout(() => reject(new Error('Export fixture seed exceeded 60000ms')), 60000)
    })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
}
