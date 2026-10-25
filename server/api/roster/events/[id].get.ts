import { eventCorrectionRoute } from '../../../utils/roster-event-correction-route'
defineRouteMeta({
  "openAPI": {
    "tags": ["正式事实精确读回"],
    "summary": "精确读取正式事件与可选逐出处最新事实",
    "description": "旧无official请求保持原字段和匿名读取。新增official投影需API token并脱敏；无sidecar明确unknown，不借现名/当前文件补造。新字段4000 UTF16字符，默认16KiB/最高64KiB，超限拒绝；history倒序20/50；event按evidenceId分页且总scope300/301拒绝。",
    "parameters": [
      {"name": "id", "in": "path", "required": true, "schema": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}},
      {
        "name": "official",
        "in": "query",
        "required": false,
        "schema": {"type": "string", "enum": ["latest"]},
        "description": "Explicit opt-in requires configured API token; no opt-in preserves legacy public read."
      },
      {
        "name": "pageSize",
        "in": "query",
        "required": false,
        "schema": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
        "description": "Only history or event latest pagination"
      },
      {"name": "afterEvidenceId", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}},
      {
        "name": "maxBytes",
        "in": "query",
        "required": false,
        "schema": {"type": "integer", "minimum": 1, "maximum": 65536, "default": 16384},
        "description": "UTF8 bytes of the added official envelope; no truncation"
      }
    ],
    "responses": {
      "200": {
        "description": "原响应保持；显式opt-in时仅新增official字段",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "official": {
                  "type": "object",
                  "properties": {
                    "formatVersion": {"const": 1},
                    "source": {"const": "official_evidence"},
                    "responseRedacted": {"const": true},
                    "uncaptured": {"const": "unknown_legacy"},
                    "availability": {"enum": ["available", "unknown_legacy", "empty_page", "captured_rows"]},
                    "row": {
                      "type": "object",
                      "description": "Captured values, never filled from record/current file. currentOwner is independent of captured origin.",
                      "properties": {
                        "evidenceId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "eventId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "revision": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "capturedRecordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "capturedEnterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "nameRaw": {"type": "string", "maxLength": 4000, "nullable": true},
                        "usccRaw": {"type": "string", "maxLength": 4000, "nullable": true},
                        "districtRaw": {"type": "string", "maxLength": 4000, "nullable": true},
                        "path": {"type": "string", "maxLength": 4000, "nullable": true},
                        "sha256": {"type": "string", "maxLength": 4000, "nullable": true},
                        "attachment": {"type": "string", "maxLength": 4000, "nullable": true},
                        "sectionKey": {"type": "string", "maxLength": 4000, "nullable": true},
                        "sourceDocumentId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                        "storedFileId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                        "listNo": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                        "page": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                        "bytes": {"type": "integer", "minimum": 0, "nullable": true},
                        "sourceBindingKnown": {"type": "boolean"},
                        "actor": {"type": "object", "properties": {"type": {"enum": ["user", "agent"]}, "id": {"type": "string"}}},
                        "basis": {"type": "string"},
                        "command": {"type": "object", "description": "Original typed import/correction reference"},
                        "createdAt": {"type": "string"},
                        "currentOwner": {
                          "type": "object",
                          "properties": {
                            "recordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                            "enterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}
                          },
                          "nullable": true
                        }
                      },
                      "nullable": true
                    },
                    "rows": {
                      "type": "array",
                      "maxItems": 50,
                      "items": {
                        "type": "object",
                        "description": "Captured values, never filled from record/current file. currentOwner is independent of captured origin.",
                        "properties": {
                          "evidenceId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                          "eventId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                          "revision": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                          "capturedRecordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                          "capturedEnterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                          "nameRaw": {"type": "string", "maxLength": 4000, "nullable": true},
                          "usccRaw": {"type": "string", "maxLength": 4000, "nullable": true},
                          "districtRaw": {"type": "string", "maxLength": 4000, "nullable": true},
                          "path": {"type": "string", "maxLength": 4000, "nullable": true},
                          "sha256": {"type": "string", "maxLength": 4000, "nullable": true},
                          "attachment": {"type": "string", "maxLength": 4000, "nullable": true},
                          "sectionKey": {"type": "string", "maxLength": 4000, "nullable": true},
                          "sourceDocumentId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                          "storedFileId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                          "listNo": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                          "page": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                          "bytes": {"type": "integer", "minimum": 0, "nullable": true},
                          "sourceBindingKnown": {"type": "boolean"},
                          "actor": {"type": "object", "properties": {"type": {"enum": ["user", "agent"]}, "id": {"type": "string"}}},
                          "basis": {"type": "string"},
                          "command": {"type": "object", "description": "Original typed import/correction reference"},
                          "createdAt": {"type": "string"},
                          "currentOwner": {
                            "type": "object",
                            "properties": {
                              "recordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                              "enterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}
                            },
                            "nullable": true
                          }
                        }
                      }
                    },
                    "nextBeforeRevision": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                    "nextAfterEvidenceId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true}
                  }
                }
              }
            }
          }
        }
      },
      "400": {"description": "严格参数或组合不合法"},
      "401": {"description": "新增official投影需配置API token"},
      "404": {"description": "精确出处/正式事件不存在"},
      "413": {"description": "field_limit/response_limit/source_limit；不截原文"}
    }
  }
})

export default eventCorrectionRoute('get')
