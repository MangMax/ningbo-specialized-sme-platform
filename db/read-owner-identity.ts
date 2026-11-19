import { realpathSync, statSync } from 'node:fs'

/** Physical identity is conservative evidence, not an atomic ABA guarantee. */
export interface ReadOwnerIdentity { dbPath: string; realpath: string; dev: number; ino: number }
export function readOwnerIdentity(dbPath: string): ReadOwnerIdentity | undefined {
  try {
    const realpath = realpathSync(dbPath), stat = statSync(realpath)
    if (!stat.isFile() || !Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) return
    return { dbPath, realpath, dev: stat.dev, ino: stat.ino }
  } catch { return }
}
export function sameReadOwner(a: ReadOwnerIdentity | undefined, b: ReadOwnerIdentity | undefined): boolean {
  return !!a && !!b && a.realpath === b.realpath && a.dev === b.dev && a.ino === b.ino
}
