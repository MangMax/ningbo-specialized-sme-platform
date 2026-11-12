/** Bounded SQLite grammar capture. The input is the original SQLite cell, never parsed JSON. */
import type Database from 'better-sqlite3'
import { z } from 'zod'
export const APPLY_STORED_RULE = 'apply-stored-cells-v1'
export const APPLY_SQL_TITLE_RULE = 'apply-legacy-sql-fact-title-v1'
export function captureSqlFactTitle(t: Database.Database, raw: string | Buffer | null) {
  const row = z.object({ title: z.string().nullable() }).parse(t.prepare(`SELECT
    CASE WHEN json_valid(@raw) THEN
      CASE WHEN json_type(@raw,'$.rdjb')='text' THEN json_extract(@raw,'$.rdjb') ELSE NULL END
    ELSE NULL END AS title`).get({ raw }))
  return row.title?.trim() || null
}
