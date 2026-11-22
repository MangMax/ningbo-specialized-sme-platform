\set ON_ERROR_STOP on
BEGIN;
LOCK TABLE business.record_correspondence, business.record_correspondence_audit IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE business.record_correspondence_audit DISABLE TRIGGER correspondence_audit_append_only;
\ir support/compact-correspondence-query-evidence.sql
ALTER TABLE business.record_correspondence_audit ENABLE TRIGGER correspondence_audit_append_only;
COMMIT;
