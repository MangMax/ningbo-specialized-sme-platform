import { dispositionRoute } from '../../../utils/title-cycle-disposition-route'

defineRouteMeta({
  "openAPI": {
    "tags": [
      "称号周期处置"
    ],
    "summary": "history title-cycle dispositions",
    "description": "Little Giant revisions only. No current qualification consumer. Formal failures reference existing formal events; assert/replace starts pending. Confirm explicitly. Read enterpriseIds as comma-separated IDs.",
    "responses": {
      "200": {
        "description": "Immutable receipt or revision readback"
      },
      "400": {
        "description": "Invalid request"
      },
      "401": {
        "description": "API token required for commands"
      },
      "409": {
        "description": "Version/source/cycle/plan/idempotency conflict"
      },
      "500": {
        "description": "Operation failed; no partial commit"
      }
    },
    "parameters": [
      {
        "in": "query",
        "name": "enterpriseIds",
        "required": true,
        "description": "1 to 500 positive enterprise IDs, comma-separated. Other query fields rejected.",
        "schema": {
          "type": "string",
          "pattern": "^[0-9]+(,[0-9]+)*$"
        }
      }
    ]
  }
})
export default dispositionRoute('history')
