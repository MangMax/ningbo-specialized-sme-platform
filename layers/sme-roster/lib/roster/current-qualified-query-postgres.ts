import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createPostgresPlatformQualificationReader } from './platform-qualification-postgres'
import { currentCandidateIdBlocks } from './current-candidate-reader'
import { readPostgresCurrentCandidateIds } from './current-candidates-postgres'
import { readPostgresCurrentDetailBatch, readPostgresCurrentFilterBatch } from './current-qualification-postgres'
import { createCurrentQualifiedPage, projectCurrentQualifiedRow, type CurrentQualifiedFilter, type CurrentQualifiedRow } from './current-qualified-page'

export function listPostgresCurrentQualified(db: NodePgDatabase, filter: CurrentQualifiedFilter, asOf = Date.now()) {
  return db.transaction(async tx => {
    const title = filter.titleCode
    const readPlatform = createPostgresPlatformQualificationReader(tx)
    const page = createCurrentQualifiedPage(filter, new Date(asOf).toISOString())
    const ids = await readPostgresCurrentCandidateIds(tx, title, filter.sort)
    for (const block of currentCandidateIdBlocks(ids)) {
      const results = await readPostgresCurrentFilterBatch(tx, block, title, asOf, readPlatform)
      for (const id of block) {
        const result = results.get(id)
        if (result) page.observe(id, result.row, result.effectiveStatus)
      }
    }
    const hydrated = new Map<number, CurrentQualifiedRow>()
    for (const block of currentCandidateIdBlocks(page.selectedIds())) {
      const results = await readPostgresCurrentDetailBatch(tx, block, title, asOf, readPlatform)
      for (const [id, detail] of results) hydrated.set(id, projectCurrentQualifiedRow(detail, title))
    }
    return page.result(id => hydrated.get(id)!)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
