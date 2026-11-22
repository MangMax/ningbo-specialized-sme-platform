import { verifyFileReadAtLocator } from './file-read'
import { readPostgresFileIdentity, usePostgresFileDb } from './file-store-postgres'

export function readHttpFileIdentity(id: number) {
  const pg = usePostgresFileDb()
  return readPostgresFileIdentity(pg, id)
}

export function verifyHttpFileRead(root: string, locator: string) {
  const pg = usePostgresFileDb()
  return verifyFileReadAtLocator(root, locator, path => readPostgresFileIdentity(pg, path))
}
