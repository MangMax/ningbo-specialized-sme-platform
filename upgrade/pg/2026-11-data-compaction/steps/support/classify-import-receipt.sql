-- JavaScript accepts escaped NUL and lone surrogates. PostgreSQL JSON traversal
-- rejects those escapes, so replace them only for this path check. None of the
-- substituted characters can form either queried ASCII key. JSON null itself
-- is still a retained property value, and an empty body is classified as absent.
-- Two independent lookups select the last definition of each key like JSON.parse.
CREATE FUNCTION pg_temp.import_historical_projection(body text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
RETURN regexp_replace(nullif(body, ''), $pattern$(?<!\\)((?:\\\\)*)\\u(0000|[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2})$pattern$,
    $replacement$\1\\uFFFD$replacement$, 'g')::json -> 'payload' -> 'platformRecordObservations' IS NOT NULL;
