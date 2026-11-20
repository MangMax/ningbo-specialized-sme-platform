import { useDb } from '@db'
import { readStoredFileContentIdentity } from './file-content-identity'
import { verifyFileRead, verifyFileReadAtLocator } from './file-read-identity'
import { readPostgresFileIdentity, usePostgresFileDb } from './file-store-postgres'

export function readHttpFileIdentity(id: number) {
  const pg = usePostgresFileDb()
  return pg ? readPostgresFileIdentity(pg, id) : readStoredFileContentIdentity(useDb(), id)
}

export function verifyHttpFileRead(root: string, locator: string) {
  const pg = usePostgresFileDb()
  return pg ? verifyFileReadAtLocator(root, locator, path => readPostgresFileIdentity(pg, path)) : verifyFileRead(useDb(), root, locator)
}
