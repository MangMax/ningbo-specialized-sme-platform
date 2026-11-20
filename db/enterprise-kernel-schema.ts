import type Database from 'better-sqlite3'

export const ENTERPRISE_KERNEL_VERSION = 1
export const ENTERPRISE_KERNEL_RUNTIME_VERSION = 71614

/** Shared by empty-database creation and the explicit offline cutover. */
export function installEnterpriseKernelSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE enterprise_kernel_completion (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      region_sha256 TEXT,
      industry_sha256 TEXT,
      CHECK ((region_sha256 IS NULL) = (industry_sha256 IS NULL))
    );
    CREATE TABLE enterprise_region (
      code TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      parent_code TEXT REFERENCES enterprise_region(code),
      level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3)
    );
    CREATE TABLE enterprise_industry (
      code TEXT PRIMARY KEY NOT NULL,
      input_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      parent_code TEXT REFERENCES enterprise_industry(code),
      level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
      description TEXT
    );
    CREATE TABLE enterprise_directory (
      enterprise_id INTEGER PRIMARY KEY REFERENCES enterprise(id),
      district_code TEXT REFERENCES enterprise_region(code),
      township_code TEXT REFERENCES enterprise_region(code),
      industry_code TEXT REFERENCES enterprise_industry(code),
      removed_reason TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE enterprise_former_name (
      alias_id INTEGER PRIMARY KEY REFERENCES enterprise_alias(id) ON DELETE CASCADE,
      uscc TEXT,
      renamed_year INTEGER
    );
    CREATE TRIGGER enterprise_former_name_insert AFTER INSERT ON enterprise_alias
    BEGIN
      INSERT INTO enterprise_former_name(alias_id, uscc)
      SELECT NEW.id, uscc_norm FROM enterprise WHERE id = NEW.enterprise_id;
    END;
    CREATE TRIGGER enterprise_former_name_reassign AFTER UPDATE OF enterprise_id ON enterprise_alias
    BEGIN
      UPDATE enterprise_former_name SET uscc = (SELECT uscc_norm FROM enterprise WHERE id = NEW.enterprise_id)
      WHERE alias_id = NEW.id;
    END;
    CREATE TRIGGER enterprise_former_name_uscc AFTER UPDATE OF uscc_norm ON enterprise
    BEGIN
      UPDATE enterprise_former_name SET uscc = NEW.uscc_norm
      WHERE alias_id IN (SELECT id FROM enterprise_alias WHERE enterprise_id = NEW.id);
    END;
    CREATE TRIGGER enterprise_directory_identity_revision
    AFTER UPDATE OF name, city, district, uscc_norm ON enterprise
    WHEN OLD.name IS NOT NEW.name OR OLD.city IS NOT NEW.city OR
      OLD.district IS NOT NEW.district OR OLD.uscc_norm IS NOT NEW.uscc_norm
    BEGIN
      INSERT INTO enterprise_directory(enterprise_id,revision) VALUES (NEW.id,2)
      ON CONFLICT(enterprise_id) DO UPDATE SET revision=revision+1;
    END;
    CREATE TABLE enterprise_source_channel (code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE enterprise_source_list_type (code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    INSERT INTO enterprise_source_channel VALUES ('direct', '直接添加'), ('jxj', '经信局'), ('miit', '工信部');
    INSERT INTO enterprise_source_list_type VALUES ('direct', '直接添加'), ('announcement', '公布名单');
    CREATE TABLE enterprise_source (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      business_table TEXT NOT NULL,
      version_key TEXT NOT NULL,
      channel_code TEXT NOT NULL REFERENCES enterprise_source_channel(code),
      list_type_code TEXT NOT NULL REFERENCES enterprise_source_list_type(code),
      acquired_on TEXT,
      series TEXT NOT NULL,
      file_id INTEGER REFERENCES stored_file(id),
      sha256 TEXT,
      UNIQUE (module, business_table, version_key)
    );
    CREATE TABLE enterprise_source_link (
      enterprise_id INTEGER NOT NULL REFERENCES enterprise(id),
      source_id INTEGER NOT NULL REFERENCES enterprise_source(id),
      PRIMARY KEY (enterprise_id, source_id)
    );
    CREATE INDEX enterprise_source_link_source_idx ON enterprise_source_link(source_id, enterprise_id);
    CREATE TRIGGER enterprise_source_follow_merge AFTER INSERT ON enterprise_merge
    BEGIN
      INSERT OR IGNORE INTO enterprise_source_link(enterprise_id,source_id)
      SELECT NEW.into_enterprise_id,source_id FROM enterprise_source_link WHERE enterprise_id=NEW.from_enterprise_id;
    END;
    CREATE TABLE roster_announcement_intake (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL,
      request TEXT NOT NULL,
      removed_reason TEXT,
      supplement_digest TEXT,
      reviewed_request TEXT,
      receipt TEXT
    );
    CREATE TABLE roster_legacy_member (
      enterprise_id INTEGER PRIMARY KEY REFERENCES enterprise(id) ON DELETE CASCADE
    );
    CREATE TABLE roster_announcement_member (
      enterprise_id INTEGER NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
      intake_id INTEGER NOT NULL REFERENCES roster_announcement_intake(id),
      PRIMARY KEY (enterprise_id, intake_id)
    );
    CREATE INDEX roster_announcement_member_intake_idx ON roster_announcement_member(intake_id);
    CREATE TRIGGER roster_membership_follow_merge AFTER INSERT ON enterprise_merge
    BEGIN
      INSERT OR IGNORE INTO roster_legacy_member(enterprise_id)
      SELECT NEW.into_enterprise_id FROM roster_legacy_member WHERE enterprise_id=NEW.from_enterprise_id;
      INSERT OR IGNORE INTO roster_announcement_member(enterprise_id,intake_id)
      SELECT NEW.into_enterprise_id,intake_id FROM roster_announcement_member WHERE enterprise_id=NEW.from_enterprise_id;
    END;
  `)
  installEnterpriseAddressSchema(db)
}

export function installEnterpriseAddressSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE enterprise_address (
      enterprise_id INTEGER NOT NULL REFERENCES enterprise(id),
      kind TEXT NOT NULL CHECK (kind IN ('registered', 'operating')),
      address TEXT NOT NULL CHECK (length(trim(address)) BETWEEN 1 AND 500),
      PRIMARY KEY (enterprise_id, kind)
    );
  `)
}

export function assertEnterpriseKernelSchema(db: Database.Database, version: unknown) {
  if (version !== ENTERPRISE_KERNEL_RUNTIME_VERSION
    || !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='enterprise_kernel_completion'").get()
    || !db.prepare('SELECT 1 FROM enterprise_kernel_completion WHERE id = 1 AND version = ?').get(ENTERPRISE_KERNEL_VERSION)) {
    throw new Error('Enterprise kernel missing; run explicit offline enterprise kernel cutover')
  }
  db.prepare('SELECT enterprise_id,kind,address FROM enterprise_address LIMIT 0').all()
  db.prepare(`SELECT e.revision, a.renamed_year, s.version_key, l.source_id, r.code, i.input_id, c.name, t.name, b.digest, b.reviewed_request,
    legacy.enterprise_id, m.enterprise_id, m.intake_id
    FROM enterprise_directory e, enterprise_former_name a, enterprise_source s, enterprise_source_link l,
    enterprise_region r, enterprise_industry i, enterprise_source_channel c, enterprise_source_list_type t,
    roster_announcement_intake b, roster_legacy_member legacy, roster_announcement_member m LIMIT 0`).all()
}
