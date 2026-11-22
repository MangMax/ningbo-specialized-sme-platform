CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE INDEX enterprise_name_norm_idx ON enterprise(name_norm);
CREATE INDEX enterprise_name_trgm_idx ON enterprise USING gin (name_norm COLLATE "C" gin_trgm_ops);
CREATE INDEX enterprise_merge_into_idx ON enterprise_merge(into_enterprise_id);
CREATE INDEX enterprise_directory_region_idx ON enterprise_directory(district_code, township_code, enterprise_id);
CREATE INDEX enterprise_directory_industry_idx ON enterprise_directory(industry_code, enterprise_id);
CREATE INDEX enterprise_source_link_source_idx ON enterprise_source_link(source_id, enterprise_id);
