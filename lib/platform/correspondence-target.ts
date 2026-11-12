/** Typed H1c target reference. Ordinary expand schema remains unchanged. */
import {eq,inArray} from 'drizzle-orm'
import {sqliteTable,integer,text,index,uniqueIndex} from 'drizzle-orm/sqlite-core'
import type {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3'
import {recordEvent,platformExportRow,enterprise,title} from '../../db/schema'
import {targetSchema,platformBusinessObservation,platformLegacyRelationAlias as a} from './target-schema'
export function correspondenceFields() { return {
    id: integer('id').primaryKey({ autoIncrement: true }),
    edgeKey: text('edge_key').notNull(),
    type: text('type', { enum: ['event_process', 'event_recognized', 'later_process', 'event_export_context', 'process_export_context', 'recognized_export'] }).notNull(),
    role: text('role').notNull(),
    eventId: integer('event_id').references(() => recordEvent.id),
    predecessorEventId: integer('predecessor_event_id').references(() => recordEvent.id),
    exportRowId: integer('export_row_id').references(() => platformExportRow.id),
    enterpriseId: integer('enterprise_id').references(() => enterprise.id),
    titleCode: text('title_code').notNull().references(() => title.code),
    status: text('status', { enum: ['candidate', 'confirmed', 'rejected', 'unlinked'] }).notNull(),
    revision: integer('revision').notNull(),
    targetIdentity: text('target_identity', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    provenance: text('provenance', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    ruleId: text('rule_id').notNull(),
    ruleVersion: text('rule_version').notNull(),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
    endedAt: text('ended_at'),
  } }
export const targetRecordCorrespondence = sqliteTable('record_correspondence', {
  ...correspondenceFields(),
  observationId: integer('observation_id').references(() => platformBusinessObservation.id),
},
  (t) => [
    uniqueIndex('record_correspondence_edge_uq').on(t.edgeKey),
    index('record_correspondence_event_idx').on(t.eventId),
    index('record_correspondence_predecessor_idx').on(t.predecessorEventId),
    index('record_correspondence_relation_idx').on(t.observationId),
    index('record_correspondence_export_idx').on(t.exportRowId),
    index('record_correspondence_enterprise_idx').on(t.enterpriseId, t.titleCode),
  ],
)

export function readObservationCorrespondenceRefs(db:BetterSQLite3Database<typeof targetSchema>|BetterSQLite3Database<typeof import('../../db/schema')>,relationIds:number[]) {
 const c=targetRecordCorrespondence
 return relationIds.length?db.select({relationId:a.oldId,id:c.id,status:c.status,revision:c.revision}).from(c).innerJoin(a,eq(a.observationId,c.observationId)).where(inArray(a.oldId,relationIds)).orderBy(a.oldId,c.id).all():[]
}
