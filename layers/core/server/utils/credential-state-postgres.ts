import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { registeredCredentials, type CredentialKey } from '../../../../lib/app-modules'
import { credentialContext, credentialState, resolveCredential, resolveFromState, type CredentialContext } from './credential-state'

export function selectedCredentialDb(ctx?: CredentialContext) {
  return ctx?.db ? undefined : usePostgresDirectoryDb()
}

export async function readPostgresCredentialState(db: NodePgDatabase) {
  try {
    const result = await db.execute<{ key: string; value: string; updatedAt: string }>(sql`
      SELECT key,value,updated_at AS "updatedAt" FROM business.service_credential`)
    return credentialState(result.rows)
  } catch {
    throw Object.assign(new Error('凭据配置存储不可用，请检查数据库后重试。'), { statusCode: 503 })
  }
}

export function updatePostgresCredentialState(db: NodePgDatabase, values: Partial<Record<CredentialKey, string | null>>) {
  return db.transaction(async tx => {
    const updatedAt = new Date().toISOString()
    // Use the same key order for independent and mixed updates.
    for (const key of registeredCredentials.keys()) {
      const value = values[key]
      if (value === undefined) continue
      if (value === null) await tx.execute(sql`DELETE FROM business.service_credential WHERE key = ${key}`)
      else await tx.execute(sql`
        INSERT INTO business.service_credential (key, value, updated_at) VALUES (${key}, ${value}, ${updatedAt})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`)
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
