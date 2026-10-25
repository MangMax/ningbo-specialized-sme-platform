import { importReceiptRoute } from '../../../../utils/import-receipts-route'

defineRouteMeta({
  "openAPI": {
    "tags": ["导入回执"],
    "summary": "分页读取导入逐项结果",
    "description": "batchId、idempotencyKey 或历史 receiptId 三选一。稳定按原项序号分页；pageSize 最大 50。只返回索引、ok、kind、ref 和错误码/字段，不含大 detail、错误原文或请求。需 API token。 显式 projection=snapshot|eventIds 选择一个归并旧容器快照或事件ID页。source=private_batch+batchId 或 redacted_receipt+receiptId二选一，itemIndex/oldRecordId必需，不允许idempotencyKey/page/latest receipt。snapshot不嵌套eventIds，后者cursor绑定完整selector。receipt缺快照not_retained，不回退batch；原item列表不变。",
    "security": [{"bearerAuth": []}],
    "parameters": [
      {"name": "batchId", "in": "query", "schema": {"type": "integer", "minimum": 1}},
      {"name": "idempotencyKey", "in": "query", "schema": {"type": "string"}},
      {"name": "receiptId", "in": "query", "schema": {"type": "integer", "minimum": 1}},
      {"name": "page", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 1000000, "default": 1}},
      {"name": "pageSize", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}},
      {"name": "projection", "in": "query", "required": false, "schema": {"enum": ["snapshot", "eventIds"]}},
      {"name": "source", "in": "query", "required": false, "schema": {"enum": ["private_batch", "redacted_receipt"]}},
      {"name": "itemIndex", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 0, "maximum": 9007199254740990}},
      {"name": "oldRecordId", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}},
      {
        "name": "cursor",
        "in": "query",
        "required": false,
        "schema": {"type": "string", "maxLength": 512},
        "description": "eventIds only; immutable source/id/item/oldRecord/index binding"
      },
      {"name": "maxBytes", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 1, "maximum": 65536, "default": 16384}}
    ],
    "responses": {
      "200": {
        "description": "原列表或显式快照/eventIds页；Cache-Control:no-store。snapshot固定id/enterpriseId/titleCode/source/nameRaw/usccRaw/district/qualityFlags，原origin另列；eventIds最多50与nextCursor。source/storedRedacted/responseRedacted/availability逐项明确。",
        "content": {
          "application/json": {
            "schema": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "batchId": {"type": "integer", "minimum": 1},
                    "receiptId": {"type": "integer", "nullable": true},
                    "page": {"type": "integer", "minimum": 1},
                    "pageSize": {"type": "integer", "minimum": 1},
                    "total": {"type": "integer"},
                    "rows": {
                      "type": "array",
                      "maxItems": 50,
                      "items": {
                        "type": "object",
                        "properties": {
                          "index": {"type": "integer", "minimum": 0},
                          "ok": {"type": "boolean"},
                          "kind": {"type": "string"},
                          "ref": {"type": "string"},
                          "errorCode": {"type": "string", "nullable": true},
                          "errorField": {"type": "string", "nullable": true}
                        }
                      }
                    }
                  }
                },
                {
                  "type": "object",
                  "properties": {
                    "formatVersion": {"const": 1},
                    "source": {"enum": ["private_batch", "redacted_receipt"]},
                    "batchId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                    "receiptId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991, "nullable": true},
                    "itemIndex": {"type": "integer", "minimum": 0},
                    "oldRecordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                    "storedRedacted": {"type": "boolean"},
                    "responseRedacted": {"const": true},
                    "availability": {"enum": ["available", "not_retained"]},
                    "snapshot": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "id": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "enterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "titleCode": {"type": "string", "maxLength": 4000},
                        "source": {"type": "string", "maxLength": 4000},
                        "nameRaw": {"type": "string", "maxLength": 4000, "nullable": true},
                        "usccRaw": {"type": "string", "maxLength": 4000, "nullable": true},
                        "district": {"type": "string", "maxLength": 4000, "nullable": true},
                        "qualityFlags": {"type": "array", "items": {"type": "string", "maxLength": 4000}, "nullable": true}
                      }
                    },
                    "origin": {
                      "type": "object",
                      "properties": {
                        "fromEnterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "intoEnterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "intoRecordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}
                      }
                    },
                    "eventIds": {"type": "array", "maxItems": 50, "items": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}},
                    "nextCursor": {"type": "string", "maxLength": 512, "nullable": true}
                  }
                }
              ]
            }
          }
        }
      },
      "400": {"description": "invalid_query：选择器、分页或字节偏移不合法"},
      "401": {"description": "unauthorized：API token 缺失、不匹配或未配置"},
      "404": {"description": "missing 精确source不存在（旧列表保持not_found）"},
      "409": {"description": "selector_mismatch / ambiguity；不取第一项"},
      "413": {"description": "field_limit / response_limit；仅小错误与requiredBytes，不截原文"}
    }
  }
})

export default importReceiptRoute('items')
