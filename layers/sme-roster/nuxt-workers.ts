import { fileURLToPath } from 'node:url'
import type { NitroHooks } from 'nitropack/types'

export function installRosterWorkers(config: Parameters<NitroHooks['rollup:before']>[1]) {
  // Emit an actual worker entry through the same dependency/external
  // packaging pipeline as the server. Rollup computes a relocatable URL
  // from the launcher's final chunk, including in Nitro dev builds.
  for (const worker of [
    { location: './server/utils/enterprise-read-worker-location.ts', entry: './lib/roster/enterprise-read-worker.ts', fileName: 'enterprise-read-worker.mjs', factory: 'createEnterpriseWorker', chunk: 'enterprise-read-model' },
    { location: './server/utils/current-export-worker-location.ts', entry: './lib/roster/current-export-worker.ts', fileName: 'current-export-worker.mjs', factory: 'createCurrentExportWorker', chunk: 'current-export-model' },
  ]) {
    const location = fileURLToPath(new URL(worker.location, import.meta.url))
    const entry = fileURLToPath(new URL(worker.entry, import.meta.url))
    let reference: string
    const plugin = {
      name: worker.fileName,
      buildStart(this: { emitFile(file: { type: 'chunk'; id: string; fileName: string }): string }) {
        reference = this.emitFile({ type: 'chunk', id: entry, fileName: worker.fileName })
      },
      resolveFileUrl({ referenceId, relativePath }: { referenceId: string; relativePath: string }) {
        if (referenceId === reference) return `new URL(${JSON.stringify(relativePath)}, _import_meta_url_).href`
      },
      transform: {
        order: 'post' as const,
        handler(_code: string, id: string) {
          if (id !== location) return
          return { code: `import { createEnterpriseReadProcess } from ${JSON.stringify(fileURLToPath(new URL('./server/utils/enterprise-read-process.ts', import.meta.url)))};
            export function ${worker.factory}() {
              return createEnterpriseReadProcess(new URL(import.meta.ROLLUP_FILE_URL_${reference}));
            }`, map: null }
        },
      },
    }
    config.plugins = [config.plugins, plugin]
    for (const output of Array.isArray(config.output) ? config.output : [config.output]) {
      if (!output) continue
      // Nitro dev normally inlines one entry. A native worker is a second
      // entry and must keep its own module graph in dev as in production.
      output.inlineDynamicImports = false
      const original = output.manualChunks
      const dependencies = new Set<string>()
      output.manualChunks = (id: string, api: { getModuleInfo(id: string): { isExternal: boolean; importedIds: string[] } | null }) => {
        if (!dependencies.size) {
          const visit = (moduleId: string) => {
            if (dependencies.has(moduleId)) return
            const info = api.getModuleInfo(moduleId)
            if (!info || info.isExternal) return
            dependencies.add(moduleId)
            for (const imported of info.importedIds) visit(imported)
          }
          visit(entry)
        }
        // Keep the worker's complete business graph independent of Nitro's
        // app initialization chunk, preserving Nitro's normal grouping.
        if (id !== entry && dependencies.has(id)) return worker.chunk
        if (typeof original === 'function') return original(id, api)
        if (id.includes('/nitropack/dist/runtime/') || id.includes('/nitropack/dist/presets/')) return 'nitro'
      }
    }
  }
}
