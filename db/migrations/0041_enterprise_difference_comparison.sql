CREATE TABLE enterprise_difference_comparison (
 enterprise_id INTEGER NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
 title_code TEXT NOT NULL REFERENCES title(code),
 comparison_state TEXT NOT NULL CHECK(comparison_state IN ('synchronized','unsynchronized','not_established')),
 reasons TEXT NOT NULL,
 comparison_error TEXT,
 decision_cutoff_id INTEGER NOT NULL DEFAULT 0,
 business_fingerprint TEXT NOT NULL,
 changed_at TEXT NOT NULL,
 refreshed_at TEXT NOT NULL,
 PRIMARY KEY(enterprise_id,title_code)
);
