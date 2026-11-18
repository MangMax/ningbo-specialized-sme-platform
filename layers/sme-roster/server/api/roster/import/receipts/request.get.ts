import { importReceiptRoute } from '../../../../utils/import-receipts-route'

defineRouteMeta({
  "openAPI": {
    "tags": [
      "导入回执"
    ],
    "summary": "按需读取脱敏导入请求的有界字节块",
    "description": "batchId、idempotencyKey 或历史 receiptId 三选一。返回校验后原请求体 JSON（不是提交封套）的脱敏字节块；不保证原始 JSON 空白/键顺序。offset 是字节偏移，maxBytes 默认 16384、最大 65536。data 为 base64，先拼字节再解码 UTF-8；nextOffset=null 为结束。旧批次未留原文返回 404 not_retained。需 API token。",
    "security": [
      {
        "bearerAuth": []
      }
    ],
    "parameters": [
      {
        "name": "batchId",
        "in": "query",
        "schema": {
          "type": "integer",
          "minimum": 1
        }
      },
      {
        "name": "idempotencyKey",
        "in": "query",
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "receiptId",
        "in": "query",
        "schema": {
          "type": "integer",
          "minimum": 1
        }
      },
      {
        "name": "offset",
        "in": "query",
        "schema": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740990,
          "default": 0
        }
      },
      {
        "name": "maxBytes",
        "in": "query",
        "schema": {
          "type": "integer",
          "minimum": 1,
          "maximum": 65536,
          "default": 16384
        }
      }
    ],
    "responses": {
      "200": {
        "description": "只读回执结果；Cache-Control: no-store",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "batchId": {
                  "type": "integer",
                  "minimum": 1
                },
                "receiptId": {
                  "type": "integer",
                  "minimum": 1
                },
                "redacted": {
                  "type": "boolean",
                  "enum": [
                    true
                  ]
                },
                "encoding": {
                  "type": "string",
                  "enum": [
                    "base64"
                  ]
                },
                "contentType": {
                  "type": "string"
                },
                "offset": {
                  "type": "integer",
                  "minimum": 0
                },
                "totalBytes": {
                  "type": "integer"
                },
                "nextOffset": {
                  "type": "integer",
                  "nullable": true
                },
                "data": {
                  "type": "string",
                  "format": "byte"
                }
              }
            }
          }
        }
      },
      "400": {
        "description": "invalid_query：选择器、分页或字节偏移不合法"
      },
      "401": {
        "description": "unauthorized：API token 缺失、不匹配或未配置"
      },
      "404": {
        "description": "not_found 或 not_retained；不创建目标"
      }
    }
  }
})

export default importReceiptRoute('request')
