import type { LucideIcon } from '@lucide/vue'

type AppNavLink = {
  readonly title: string
  readonly url: string
}

export type AppNavItem = { readonly icon?: LucideIcon } & (
  | (AppNavLink & { readonly items?: never })
  | { readonly title: string; readonly items: readonly AppNavLink[]; readonly url?: never }
)

type AppModuleManifest = {
  readonly id: string
  readonly name: string
  readonly dependsOn?: readonly string[]
  readonly routes?: readonly string[]
  readonly mcpTools?: readonly string[]
  readonly jobKinds?: readonly { readonly kind: string }[]
  readonly nav?: readonly AppNavItem[]
}

export function defineAppModule(manifest: AppModuleManifest): AppModuleManifest {
  return manifest
}

export function validateAppModules(manifests: readonly AppModuleManifest[]): void {
  const modulesById = new Map<string, AppModuleManifest>()
  const navOwners = new Map<string, string>()

  const routes = new Set<string>()
  const tools = new Set<string>()
  const jobKinds = new Set<string>()

  for (const manifest of manifests) {
    const { id, nav } = manifest
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`模块「${id}」的 id 无效，只允许用连字符分隔的小写字母和数字`)
    }
    if (modulesById.has(id)) throw new Error(`模块「${id}」的 id 重复`)
    modulesById.set(id, manifest)

    for (const prefix of manifest.routes ?? []) {
      if (!/^\/api(?:\/(?:[a-z0-9-]+|:[a-zA-Z][a-zA-Z0-9]*))+$/.test(prefix)) {
        throw new Error(`模块「${id}」的 API 前缀「${prefix}」无效`)
      }
      if (routes.has(prefix)) throw new Error(`API 前缀「${prefix}」重复登记`)
      routes.add(prefix)
    }
    for (const tool of manifest.mcpTools ?? []) {
      if (tools.has(tool)) throw new Error(`MCP 工具「${tool}」重复登记`)
      tools.add(tool)
    }
    for (const { kind } of manifest.jobKinds ?? []) {
      if (jobKinds.has(kind)) throw new Error(`任务种类「${kind}」重复登记`)
      jobKinds.add(kind)
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
