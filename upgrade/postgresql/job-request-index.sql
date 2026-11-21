-- Keep JSON escapes for NUL and lone surrogates as text. Double literal
-- backslashes in the projection so they cannot collide with those escapes.
CREATE OR REPLACE FUNCTION business.job_params_for_query(raw text)
RETURNS json LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN CASE WHEN strpos(raw, chr(92)) = 0 THEN raw::json ELSE (
  SELECT string_agg(
    CASE
      WHEN parts[2] IS NOT NULL THEN repeat(chr(92), 4)
      WHEN parts[3] IS NOT NULL THEN chr(92) || lower(parts[3] COLLATE "C")
      ELSE parts[1]
    END, '' ORDER BY position
  )::json
  FROM regexp_matches(raw COLLATE "C", $pattern$
    ( [^\\]+
    | \\u[dD][89aAbB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}
    | (\\\\|\\u005[cC])
    | (\\u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2}))
    | \\.
    )
  $pattern$, 'gx') WITH ORDINALITY AS tokens(parts, position)
) END;

CREATE UNIQUE INDEX job_export_request_uq
  ON business.job (kind, (nullif((business.job_params_for_query(params) -> 'clientRequestId')::jsonb, 'null'::jsonb)))
  WHERE kind = 'current-roster-export';
