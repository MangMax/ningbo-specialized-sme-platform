import core from '../layers/core/lib/core/manifest'
import smeRoster from '../layers/sme-roster/manifest'
import type { AppModuleManifest } from '../layers/core/lib/core/module-registry'

const appModules = [core, smeRoster] as const

export function getAppModules(): readonly AppModuleManifest[] {
  return appModules
}

export const ocrFileSources = getAppModules().flatMap(module => module.fileCategories?.ocrSources ?? [])

type NamespacedKey<M> = M extends { id: infer Id extends string; credentials: readonly { key: infer Key extends string }[] }
  ? `${Id}.${Key}` : never
export type CredentialKey = NamespacedKey<(typeof appModules)[number]>

export const credentialGroups = getAppModules().flatMap(({ id, name, credentials }) => credentials?.length ? [{
  id,
  name,
  credentials: credentials.map(credential => ({
    ...credential,
    key: `${id}.${credential.key}` as CredentialKey,
    sensitive: credential.sensitive ?? true,
  })),
}] : [])

export const registeredCredentials = new Map(credentialGroups.flatMap(group =>
  group.credentials.map(credential => [credential.key, credential] as const)))

export function isCredentialKey(key: unknown): key is CredentialKey {
  return typeof key === 'string' && registeredCredentials.has(key as CredentialKey)
}
