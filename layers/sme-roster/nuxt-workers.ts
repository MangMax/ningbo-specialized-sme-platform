import { fileURLToPath } from 'node:url'
import type { NitroBuildConfig } from 'nitro/types'

export function installRosterWorkers(config: NonNullable<NitroBuildConfig['rolldown']>) {
  // Emit an actual worker entry through the same dependency/external
  // packaging pipeline as the server. Rolldown computes a relocatable URL
  // from the launcher's final chunk, including in Nitro dev builds.
  for (const worker of [
    { location: './server/utils/enterprise-read-worker-location.ts', entry: './lib/roster/enterprise-read-worker.ts', fileName: 'enterprise-read-worker.mjs', factory: 'createEnterpriseWorker' },
    { location: './server/utils/current-export-worker-location.ts', entry: './lib/roster/current-export-worker.ts', fileName: 'current-export-worker.mjs', factory: 'createCurrentExportWorker' },
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
        if (referenceId === reference) return `new URL(${JSON.stringify(relativePath)}, import.meta.url).href`
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
  }
  for (const output of Array.isArray(config.output) ? config.output : [config.output]) {
    // Development also needs split output for the server and worker entry points.
    if (output?.codeSplitting === false) output.codeSplitting = true
  }
}
