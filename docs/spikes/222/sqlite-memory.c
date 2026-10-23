/* Synthetic measurement only. Uses the loaded SQLite's extension API, not a
 * second SQLite library, driver, parser, or runtime dependency. */
#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1
static void memory(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  sqlite3_int64 current = 0, peak = 0;
  int mode = sqlite3_value_int(argv[0]);
  int rc = sqlite3_status64(SQLITE_STATUS_MEMORY_USED, &current, &peak, mode == 2);
  if (rc != SQLITE_OK) sqlite3_result_error_code(ctx, rc);
  else sqlite3_result_int64(ctx, mode == 1 ? peak : current);
}
static void dbmemory(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  int current = 0, peak = 0, mode = sqlite3_value_int(argv[0]);
  int op = mode == 0 ? SQLITE_DBSTATUS_CACHE_USED :
           mode == 1 ? SQLITE_DBSTATUS_SCHEMA_USED : SQLITE_DBSTATUS_STMT_USED;
  int rc = sqlite3_db_status(sqlite3_context_db_handle(ctx), op, &current, &peak, 0);
  if (rc != SQLITE_OK) sqlite3_result_error_code(ctx, rc);
  else sqlite3_result_int(ctx, current);
}
int sqlite3_spikememory_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api);
  int rc = sqlite3_create_function(db, "spike_memory", 1, SQLITE_UTF8, 0, memory, 0, 0);
  if (rc != SQLITE_OK) return rc;
  return sqlite3_create_function(db, "spike_dbmemory", 1, SQLITE_UTF8, 0, dbmemory, 0, 0);
}
