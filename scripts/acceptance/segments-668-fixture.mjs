// Controlled input only; creates a new isolated SQLite and files directory.
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { initializeDb, schema: s } = await jiti.import('../../db/client.ts')
const root = mkdtempSync('/tmp/browser-668-'), filesDir = join(root, 'files')
mkdirSync(filesDir)
const dbPath = join(root, 'roster.sqlite'), db = initializeDb({ create: true, dbPath })
const bytes = Buffer.from('%PDF-1.4\n% controlled description-only fixture; not used for rendering\n%%EOF')
const relPath = '受控分段668.pdf'
writeFileSync(join(filesDir, relPath), bytes)
const f = db.insert(s.storedFile).values({ relPath, filename: relPath, ext: 'pdf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parseState: 'unparsed' }).returning().get()
const e = db.insert(s.enterprise).values({ name: '受控企业668', nameNorm: '受控企业668' }).returning().get()
const r = db.insert(s.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
const ev = db.insert(s.recordEvent).values({ recordId: r.id, eventType: 'award', year: 2020, batchSeq: 1 }).returning().get()
db.insert(s.recordEvidence).values({ recordEventId: ev.id, sourceFile: relPath, page: 1, attachment: '附件1' }).run()
db.$client.close()
writeFileSync(join(root, 'empty.env'), '')
console.log(JSON.stringify({ root, dbPath, filesDir, fileId: f.id }))
