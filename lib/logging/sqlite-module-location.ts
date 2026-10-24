import { createRequire } from 'node:module'
/** Native module resolution; Nitro replaces this with the final chunk's native URL. */
export function resolveLoggingSqliteModule() { return createRequire(import.meta.url).resolve('better-sqlite3') }
