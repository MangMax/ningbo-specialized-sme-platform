import type Database from 'better-sqlite3'

function isSqliteClient(value: unknown): value is Database.Database {
  if (!value || typeof value !== 'object') return false
  return typeof Reflect.get(value, 'backup') === 'function' && typeof Reflect.get(value, 'pragma') === 'function'
}

/** Drizzle transactions retain the same native client on their session. */
export function sqliteConnection(db:object):Database.Database {
 const direct:unknown=Reflect.get(db,'$client')
 if(isSqliteClient(direct))return direct
 const session:unknown=Reflect.get(db,'session')
 const client:unknown=session&&typeof session==='object'?Reflect.get(session,'client'):null
 if(isSqliteClient(client))return client
 throw new Error('Target requires its original SQLite connection')
}
