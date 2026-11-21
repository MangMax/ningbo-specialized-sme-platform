import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { serviceCredential } from '../../../../db/postgresql/credential-tables'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { registeredCredentials, type CredentialKey } from '../../../../lib/app-modules'
import { credentialContext, credentialState, resolveCredential, resolveFromState, type CredentialContext } from './credential-state'

export function selectedCredentialDb(ctx?: CredentialContext) {
  return ctx?.db ? undefined : usePostgresDirectoryDb()
}

export async function readPostgresCredentialState(db: NodePgDatabase) {
  try {
    return credentialState(await db.select().from(serviceCredential))
  } catch {
    throw Object.assign(new Error('凭据配置存储不可用，请检查数据库后重试。'), { statusCode: 503 })
  }
}

export function updatePostgresCredentialState(db: NodePgDatabase, values: Partial<Record<CredentialKey, string | null>>) {
  return db.transaction(async tx => {
    const updatedAt = new Date().toISOString()
    for (const key of registeredCredentials.keys()) {
      const value = values[key]
      if (value === undefined) continue
      if (value === null) {
        await tx.delete(serviceCredential).where(eq(serviceCredential.key, key))
      } else {
        await tx.insert(serviceCredential).values({ key, value, updatedAt })
          .onConflictDoUpdate({ target: serviceCredential.key, set: { value, updatedAt } })
      }
    }
    return readPostgresCredentialState(tx)
  })
}

export async function resolveRuntimeCredential(key: CredentialKey, ctx = credentialContext()) {
  const db = selectedCredentialDb(ctx)
  return db ? resolvePostgresCredential(db, key, ctx) : resolveCredential(key, ctx)
}

export async function resolvePostgresCredential(db: NodePgDatabase, key: CredentialKey, ctx = credentialContext()) {
  return resolveFromState(key, ctx, await readPostgresCredentialState(db))
}
