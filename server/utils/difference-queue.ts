import { z } from 'zod'
import type { PlatformRow } from '../../lib/platform/adapter'
import type { useDb } from '../../db/client'
export type SnapshotOfficialCoordinate = { enterpriseId: number; name: string; uscc: string | null; titleCode: string }
type Observation = { enterpriseId: number; source: string; rdjb: string | null; complete: boolean; segments: { rows: PlatformRow[] }[] }
type Candidate = { enterpriseId: number; titleCode: string; direction: 'missing_in_miit' | 'extra_in_miit'; status: string; reasonCode: string | null }
export type SnapshotQueue = { rows: Candidate[]; unfinished: number[] }
const titles = { '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' } as const
/** No archive/export reads: only this task's frozen official coordinates and collection segments. */
export function deriveSnapshotQueue(official: SnapshotOfficialCoordinate[], items: Observation[]): SnapshotQueue {
  const groups = new Map<string, SnapshotOfficialCoordinate[]>()
  for (const row of official) {
    const key = row.uscc && /^[0-9A-Z]{18}$/.test(row.uscc) ? row.uscc : `id:${row.enterpriseId}`
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group)
  }
  const result: SnapshotQueue = { rows: [], unfinished: [] }
  for (const group of groups.values()) {
    const enterpriseId = Math.min(...group.map(e=>e.enterpriseId))
    const ids = new Set(group.map(e=>e.enterpriseId))
    const observations = items.filter(i=>ids.has(i.enterpriseId))
    let complete = [...ids].every(id=>['queryList','businessList','queryBusList'].every(source =>
      (source==='queryList'?[null]:['1','2','3']).every(rdjb => observations.some(i=>i.enterpriseId===id&&i.source===source&&i.rdjb===rdjb&&i.complete))))
    const platform = new Set<string>()
    for (const item of observations) for (const segment of item.segments) for (const row of segment.rows) {
      // A filter is not a returned row title. Unknown titles/identity cannot prove absence.
      const title = Object.hasOwn(titles, row.rdjb ?? '') ? titles[row.rdjb as keyof typeof titles] : undefined
      const matches = row.tyshxydm ? group.some(e=>e.uscc===row.tyshxydm) : group.some(e=>e.name===row.qymc)
      if (!title || !matches) { complete=false; continue }
      platform.add(title)
    }
    if (!complete) { result.unfinished.push(enterpriseId); continue }
    const published = new Set(group.map(e=>e.titleCode))
    for (const titleCode of Object.values(titles)) {
      if (published.has(titleCode) === platform.has(titleCode)) continue
      result.rows.push({ enterpriseId,titleCode,direction:published.has(titleCode)?'missing_in_miit':'extra_in_miit',status:'not_queried',reasonCode:null })
    }
  }
  result.rows.sort((a,b)=>a.enterpriseId-b.enterpriseId||a.titleCode.localeCompare(b.titleCode)||a.direction.localeCompare(b.direction))
  result.unfinished.sort((a,b)=>a-b)
  return result
}
export function pageSnapshotQueue(queue: SnapshotQueue, page: number, pageSize: number) {
  const rows = queue.rows.filter(r=>!['confirmed_no_diff','confirmed_reason'].includes(r.status))
  return { rows: rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,unfinished:queue.unfinished }
}
export const queueInput = z.object({ jobId:z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(200).default(50) })
export function readSnapshotQueue(db:ReturnType<typeof useDb>, raw:unknown) {
  const parsed=queueInput.safeParse(raw)
  if (!parsed.success) throw Object.assign(new Error('Invalid queue parameters'),{statusCode:400})
  const {jobId,page,pageSize}=parsed.data
  // Project only the persisted queue, never deserialize the task's raw platform payloads.
  const job=db.$client.prepare("select kind,state,json_extract(result,'$.queue') queue from job where id=?").get(jobId) as {kind:string;state:string;queue:string|null}|undefined
  if (!job || job.kind!=='difference-snapshot') throw Object.assign(new Error('Snapshot not found'),{statusCode:404})
  const queue=job.queue ? JSON.parse(job.queue) as SnapshotQueue : null
  if (!queue || ['queued','running'].includes(job.state)) throw Object.assign(new Error('Snapshot queue not finalized; wait for collection or retry the same snapshot to prepare its queue'),{statusCode:409})
  return {jobId,...pageSnapshotQueue(queue,page,pageSize)}
}
