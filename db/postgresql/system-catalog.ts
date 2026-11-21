import { integer, pgSchema, text } from 'drizzle-orm/pg-core'

const catalog = pgSchema('pg_catalog')

export const settings = catalog.table('pg_settings', {
  name: text('name').notNull(),
  setting: text('setting'),
})

export const namespaces = catalog.table('pg_namespace', {
  oid: integer('oid').notNull(),
  name: text('nspname').notNull(),
})

export const relations = catalog.table('pg_class', {
  oid: integer('oid').notNull(),
  namespace: integer('relnamespace').notNull(),
  name: text('relname').notNull(),
})

export const triggers = catalog.table('pg_trigger', {
  relation: integer('tgrelid').notNull(),
  name: text('tgname').notNull(),
  enabled: text('tgenabled').notNull(),
})
