import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PlatformBatchItem, PlatformBatchResult, PlatformBatchSegment } from '../../lib/platform/batch-query'
import type { PlatformQueryError } from '../../lib/platform/live-query'
import { platformBatchSegment } from '../../lib/platform/postgres-batch-segment-table'

export type PlatformBatchCheckpointItem = Omit<PlatformBatchItem, 'segments'> & { error: PlatformQueryError | null }
export type PlatformBatchCheckpoint = Omit<PlatformBatchResult, 'items'> & { items: PlatformBatchCheckpointItem[] }

export function platformBatchCheckpoint({ items, ...result }: PlatformBatchResult): PlatformBatchCheckpoint {
  return {
    ...result,
    items: items.map(({ segments, ...item }) => ({ ...item, error: segments.at(-1)?.error ?? null })),
  }
}

export interface PlatformBatchSegmentUpdate {
  itemId: string
  segmentIndex: number
  segment: PlatformBatchSegment
}

export async function savePostgresPlatformBatchSegment(db: NodePgDatabase, jobId: string, update: PlatformBatchSegmentUpdate) {
  const { itemId, segmentIndex, segment } = update
  const payload = JSON.stringify(segment)
  await db.insert(platformBatchSegment).values({ jobId, itemId, segmentIndex, payload }).onConflictDoUpdate({
    target: [platformBatchSegment.jobId, platformBatchSegment.itemId, platformBatchSegment.segmentIndex],
    set: { payload: sql`excluded.payload` },
  })
}

export async function readPostgresPlatformBatchSegments(db: NodePgDatabase, jobId: string, itemId?: string) {
  const rows = await db.select({
    itemId: platformBatchSegment.itemId,
    payload: platformBatchSegment.payload,
  }).from(platformBatchSegment).where(and(
    eq(platformBatchSegment.jobId, jobId),
    itemId === undefined ? undefined : eq(platformBatchSegment.itemId, itemId),
  )).orderBy(platformBatchSegment.itemId, platformBatchSegment.segmentIndex)
  const segments = new Map<string, PlatformBatchSegment[]>()
  for (const row of rows) {
    const item = segments.get(row.itemId) ?? []
    item.push(JSON.parse(row.payload) as PlatformBatchSegment)
    segments.set(row.itemId, item)
  }
  return segments
}

export function restorePlatformBatchCheckpointItem(
  { error, ...item }: PlatformBatchCheckpointItem,
  segments: Map<string, PlatformBatchSegment[]>,
): PlatformBatchItem {
  return { ...item, segments: segments.get(item.itemId) ?? [] }
}

export async function readPostgresPlatformBatchResult(db: NodePgDatabase, jobId: string, checkpoint: PlatformBatchCheckpoint | null): Promise<PlatformBatchResult | null> {
  if (!checkpoint) return null
  const { items, ...result } = checkpoint
  const segments = await readPostgresPlatformBatchSegments(db, jobId)
  return { ...result, items: items.map(item => restorePlatformBatchCheckpointItem(item, segments)) }
}
