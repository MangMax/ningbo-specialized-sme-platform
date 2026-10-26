CREATE INDEX platform_relation_current_candidate_cover_idx ON platform_relation(query_id,sequence_no,enterprise_id,uscc_raw);
--> statement-breakpoint
CREATE INDEX platform_query_current_candidate_cover_idx ON platform_query(id,rdjb,title_code,collection_evidence);
