import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { useDb } from '../../../../db'
import { serviceCredential } from '../../../../db/schema'
import { isCredentialKey, registeredCredentials, type CredentialKey } from '../../../../lib/app-modules'

import {
  credentialContext, credentialState, credentialStatus as statusFromState,
  resolveFromState, storageError, type CredentialReadContext, type CredentialState,
} from './credential-resolution'
export { credentialContext, credentialState, resolveFromState } from './credential-resolution'

export interface CredentialContext extends CredentialReadContext {
  db?: BetterSQLite3Database<typeof import('../../../../db/schema')>
}

function readState(ctx: CredentialContext): CredentialState {
  try {
    return credentialState((ctx.db ?? useDb()).select().from(serviceCredential).all())
  } catch { throw storageError() }
}
export function resolveCredential(key: CredentialKey, ctx: CredentialContext = credentialContext(), override?: string) {
  if (!isCredentialKey(key)) throw new Error('不支持的凭据键')
  if (override?.trim()) return { value: override.trim(), source: 'override', updatedAt: null, hasSaved: false }
  return resolveFromState(key, ctx, readState(ctx))
}
export function credentialStatus(ctx: CredentialContext) {
  return statusFromState(ctx, readState(ctx))
}
export function updateCredential(key: CredentialKey, value: string | null, ctx: CredentialContext): void {
  updateCredentials({ [key]: value }, ctx)
}
/** One transaction keeps independent keys intact and rolls back a failed mixed update. */
export function updateCredentials(values: Partial<Record<CredentialKey, string | null>>, ctx: CredentialContext): void {
  if (!Object.keys(values).every(isCredentialKey)) throw new Error('不支持的凭据键')
  try {
    const db = ctx.db ?? useDb()
    db.transaction(tx => {
      const updatedAt = new Date().toISOString()
      for (const key of registeredCredentials.keys()) {
        const value = values[key]
        if (value === null) tx.delete(serviceCredential).where(eq(serviceCredential.key, key)).run()
        else if (value !== undefined) tx.insert(serviceCredential).values({ key, value, updatedAt }).onConflictDoUpdate({ target: serviceCredential.key, set: { value, updatedAt } }).run()
      }
    })
  } catch { throw storageError() }
}

export function sqliteCredentialStorage(ctx: CredentialContext) {
  return {
    read: () => readState(ctx),
    update(values: Partial<Record<CredentialKey, string | null>>) {
      updateCredentials(values, ctx)
      return readState(ctx)
    },
  }
}
