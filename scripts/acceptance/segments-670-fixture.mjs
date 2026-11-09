// Controlled input only; creates a new isolated SQLite and files directory.
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { initializeDb, schema: s } = await jiti.import('../../db/client.ts')
const root = mkdtempSync('/tmp/browser-670-'), filesDir = join(root, 'files')
mkdirSync(filesDir)
const dbPath = join(root, 'roster.sqlite'), db = initializeDb({ create: true, dbPath })
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>', ...Array.from({ length: 4 }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>')]
let pdf = '%PDF-1.4\n'; const offsets = [0]
objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
const bytes = Buffer.from(pdf)
const relPath = '受控分段670.pdf'
writeFileSync(join(filesDir, relPath), bytes)
const f = db.insert(s.storedFile).values({ relPath, filename: relPath, ext: 'pdf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parseState: 'unparsed' }).returning().get()
const e = db.insert(s.enterprise).values({ name: '受控企业670', nameNorm: '受控企业670' }).returning().get()
const r = db.insert(s.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
const ev = db.insert(s.recordEvent).values({ recordId: r.id, eventType: 'award', year: 2020, batchSeq: 1 }).returning().get()
db.insert(s.recordEvidence).values({ recordEventId: ev.id, sourceFile: relPath, page: 1, attachment: '附件1' }).run()
db.insert(s.ocrResult).values({ fileId: f.id, pageNo: 1, markdown: '受控OCR670', channel: 'upload' }).run()
db.$client.close()
writeFileSync(join(root, 'empty.env'), '')
console.log(JSON.stringify({ root, dbPath, filesDir, fileId: f.id }))
