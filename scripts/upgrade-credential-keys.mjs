import Database from 'better-sqlite3'

const [path] = process.argv.slice(2)
if (!path) throw new Error('Usage: node scripts/upgrade-credential-keys.mjs DATABASE (stop writers and back up first)')

const db = new Database(path, { fileMustExist: true })
try {
  db.transaction(() => {
    db.exec(`UPDATE service_credential SET key = CASE key
      WHEN 'ocrToken' THEN 'core.ocrToken'
      WHEN 'miitCookie' THEN 'sme-roster.miitCookie'
    END WHERE key IN ('ocrToken', 'miitCookie')`)
  }).immediate()
} finally {
  db.close()
}
