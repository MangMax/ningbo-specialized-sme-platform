CREATE UNIQUE INDEX job_export_request_uq ON job(kind, json_extract(params, '$.clientRequestId')) WHERE kind = 'current-roster-export';
