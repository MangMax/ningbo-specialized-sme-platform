import { statSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

// File count/hash alone puts the paid-crash, 10k snapshot and multi-stream
// suites together. Keep these distinct cost classes explicit, not a generated
// timing report. The rest use source size plus a process/import startup floor.
// Estimates affect scheduling only; every file still runs once, isolated.
export function schedulingCost(path: string, bytes: number, project: string) {
  if (project === 'app') {
    if (/\/files\/ocr\/publication\.app\.test\.ts$/.test(path)
      || /\/logging\/exports\/export\.http\.app\.test\.ts$/.test(path)
      || /\/current-export\/little-giant\.http\.app\.test\.ts$/.test(path)) return 60
    return 5 + bytes / 1500
  }
  // db5 Linux runtime2: pagination 55s; OCR job/date UI/pages 14–22s.
  // Separate these repeated native/raster workloads from cheap import-only files.
  if (/\/platform\/reconciliation\/slot-pagination-job\.test\.ts$/.test(path)) return 60
  if (/\/files\/ocr\/(job|page)\.test\.ts$/.test(path)
    || /\/comparison\/date-time-picker\.ui\.test\.ts$/.test(path)) return 25
  return 2 + bytes / 10000
}

export default class BalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard!
    const bins = Array.from({ length: count }, () => ({ cost: 0, files: [] as TestSpecification[] }))
    const ranked = files.map(spec => {
      const path = relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/')
      return { spec, path, cost: schedulingCost('/' + path, statSync(spec.moduleId).size, spec.project.name) }
    }).sort((a, b) => b.cost - a.cost || a.path.localeCompare(b.path, 'en'))
    for (const item of ranked) {
      const bin = bins.reduce((best, next) => next.cost < best.cost ? next : best)
      bin.files.push(item.spec)
      bin.cost += item.cost
    }
    return bins[index - 1]!.files
  }
}
