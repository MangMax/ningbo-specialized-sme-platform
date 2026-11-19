import { validateAppModules, type AppModuleManifest } from '../layers/core/lib/core/module-registry'

export type CredentialKey = `${string}.${string}`

let modules: readonly AppModuleManifest[] = []
export let ocrFileSources = modules.flatMap(module => module.fileCategories?.ocrSources ?? [])
export let credentialGroups = collectCredentials(modules)
export let registeredCredentials = indexCredentials(credentialGroups)

export function installAppModules(manifests: readonly AppModuleManifest[]): void {
  validateAppModules(manifests)
  modules = manifests
  ocrFileSources = modules.flatMap(module => module.fileCategories?.ocrSources ?? [])
  credentialGroups = collectCredentials(modules)
  registeredCredentials = indexCredentials(credentialGroups)
}

export function getAppModules(): readonly AppModuleManifest[] {
  return modules
}

function collectCredentials(manifests: readonly AppModuleManifest[]) {
  return manifests.flatMap(({ id, name, credentials }) => credentials?.length ? [{
    id,
    name,
    credentials: credentials.map(credential => ({
      ...credential,
      key: `${id}.${credential.key}` as CredentialKey,
      sensitive: credential.sensitive ?? true,
    })),
  }] : [])
}

function indexCredentials(groups: ReturnType<typeof collectCredentials>) {
  return new Map(groups.flatMap(group =>
    group.credentials.map(credential => [credential.key, credential] as const)))
}

export function isCredentialKey(key: unknown): key is CredentialKey {
  return typeof key === 'string' && registeredCredentials.has(key as CredentialKey)
}
