import { importReceiptRoute } from '../../../../utils/import-receipts-route'

defineRouteMeta({
  "openAPI": {
    "tags": [
      "导入回执"
    ],
    "summary": "分页读取导入回执历史",
    "description": "batchId 或 idempotencyKey 二选一。稳定按 receiptId 升序分页；pageSize 最大 50。历史终态回执只读；旧批次的未留存历史不补造。需 API token。",
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
        "name": "page",
        "in": "query",
        "schema": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000000,
          "default": 1
        }
      },
      {
        "name": "pageSize",
        "in": "query",
        "schema": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "default": 20
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
                  "nullable": true
                },
                "page": {
                  "type": "integer",
                  "minimum": 1
                },
                "pageSize": {
                  "type": "integer",
                  "minimum": 1
                },
                "total": {
                  "type": "integer"
                },
                "rows": {
                  "type": "array",
                  "maxItems": 50,
                  "items": {
                    "type": "object",
                    "properties": {
                      "batchId": {
                        "type": "integer",
                        "minimum": 1
                      },
                      "receiptId": {
                        "type": "integer",
                        "nullable": true
                      },
                      "status": {
                        "type": "string",
                        "enum": [
                          "preflight",
                          "processing",
                          "failed",
                          "committed"
                        ]
                      },
                      "operation": {
                        "type": "string",
                        "nullable": true,
                        "enum": [
                          "preflight",
                          "commit",
                          "replay"
                        ]
                      },
                      "createdAt": {
                        "type": "string"
                      },
                      "completedAt": {
                        "type": "string",
                        "nullable": true
                      },
                      "itemCount": {
                        "type": "integer"
                      }
                    }
                  }
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

export default importReceiptRoute('history')
