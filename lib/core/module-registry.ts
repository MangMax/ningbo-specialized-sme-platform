import type { LucideIcon } from '@lucide/vue'

type AppNavLink = {
  readonly title: string
  readonly url: string
}

export type AppNavItem = { readonly icon?: LucideIcon } & (
  | (AppNavLink & { readonly items?: never })
  | { readonly title: string; readonly items: readonly AppNavLink[]; readonly url?: never }
)

export type AppJobKind = {
  readonly kind: string
  readonly label: string
  readonly group: { readonly id: string; readonly label: string }
  /** Export name in the owning module's server JobSpec adapter. */
  readonly spec: string
}

type AppCredential = {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly purpose: string
  readonly sensitive?: boolean
  readonly environment?: readonly string[]
  readonly singleLine?: boolean
}

export type AppModuleManifest = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly home?: string
  readonly dashboard?: readonly AppDashboardCard[]
  readonly dependsOn?: readonly string[]
  readonly credentials?: readonly AppCredential[]
  readonly nav?: readonly AppNavItem[]
  readonly jobKinds?: readonly AppJobKind[]
}

type AppDashboardCard = {
  readonly id: string
  readonly title: string
}

export function defineAppModule<const T extends AppModuleManifest>(manifest: T): T {
  return manifest
}

export function validateAppModules(manifests: readonly AppModuleManifest[]): void {
  const modulesById = new Map<string, AppModuleManifest>()
  const navOwners = new Map<string, string>()
  const jobOwners = new Map<string, string>()

  for (const manifest of manifests) {
    const { id, nav, jobKinds, credentials } = manifest
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`模块「${id}」的 id 无效，只允许用连字符分隔的小写字母和数字`)
    }
    if (modulesById.has(id)) throw new Error(`模块「${id}」的 id 重复`)
    modulesById.set(id, manifest)

    for (const { kind } of jobKinds ?? []) {
      const owner = jobOwners.get(kind)
      if (owner !== undefined) {
        throw new Error(`模块「${id}」的任务种类「${kind}」重复，已由模块「${owner}」登记`)
      }
      jobOwners.set(kind, id)
    }

    const credentialKeys = new Set<string>()
    for (const { key } of credentials ?? []) {
      if (!/^[a-zA-Z0-9_-]+$/.test(key) || credentialKeys.has(key)) {
        throw new Error(`模块「${id}」的凭据键「${key}」无效或重复`)
      }
      credentialKeys.add(key)
    }

    for (const item of nav ?? []) {
      for (const { url } of item.items ?? [item]) {
        const owner = navOwners.get(url)
        if (owner !== undefined) {
          throw new Error(`模块「${id}」的 nav 地址「${url}」重复，已由模块「${owner}」登记`)
        }
        navOwners.set(url, id)
      }
    }
  }

  const validated = new Set<string>()
  const visiting = new Set<string>()
  const core = modulesById.get('core')

  function validateDependencies({ id, dependsOn }: AppModuleManifest) {
    if (validated.has(id)) return
    if (visiting.has(id)) {
      const path = [...visiting]
      const cycle = path.slice(path.indexOf(id)).concat(id).join(' → ')
      throw new Error(`模块「${id}」的 dependsOn 存在循环依赖：${cycle}`)
    }

    visiting.add(id)
    if (core && id !== core.id) validateDependencies(core)
    for (const dependencyId of dependsOn ?? []) {
      const dependency = modulesById.get(dependencyId)
      if (!dependency) {
        throw new Error(`模块「${id}」的 dependsOn 指向未登记模块「${dependencyId}」`)
      }
      validateDependencies(dependency)
    }
    visiting.delete(id)
    validated.add(id)
  }

  for (const manifest of manifests) validateDependencies(manifest)
}
