import Database from 'better-sqlite3'
/** Drizzle transactions retain the same native client on their session. */
export function sqliteConnection(db:object):Database.Database {
 const direct:unknown=Reflect.get(db,'$client')
 if(direct instanceof Database)return direct
 const session:unknown=Reflect.get(db,'session')
 const client:unknown=session&&typeof session==='object'?Reflect.get(session,'client'):null
 if(client instanceof Database)return client
 throw new Error('Target requires its original SQLite connection')
}
