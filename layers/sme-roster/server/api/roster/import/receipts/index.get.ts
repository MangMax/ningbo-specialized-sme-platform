import { importReceiptRoute } from '../../../../utils/import-receipts-route'

defineRouteMeta({
  "openAPI": {
    "tags": [
      "导入回执"
    ],
    "summary": "精确读取导入批次回执（只读）",
    "description": "batchId、idempotencyKey 或历史 receiptId 三选一。只读、不提交、不消费 key；不返回请求原文或全部逐项结果。preflight=仅预检；processing=提交尚无终态（不推断成功）；failed=失败；committed=已提交。旧批次 originalRequest=not_retained。需独立 API token。",
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
                "idempotencyKey": {
                  "type": "string"
                },
                "idempotencyKeyTruncated": { "type": "boolean", "description": "幂等键显示是否超过4096字符；超长旧键请固定batchId" },
                "sourceIdentityTruncated": { "type": "boolean", "description": "来源身份显示是否超过4096字符" },
                "sourceKind": {
                  "type": "string",
                  "enum": [
                    "announcement",
                    "platform_export",
                    "alias_evidence"
                  ]
                },
                "sourceIdentity": {
                  "type": "string"
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
                "committedAt": {
                  "type": "string",
                  "nullable": true
                },
                "itemCount": {
                  "type": "integer"
                },
                "summary": {
                  "type": "object",
                  "nullable": true,
                  "properties": {
                    "written": {
                      "type": "integer"
                    },
                    "skipped": {
                      "type": "integer"
                    },
                    "failed": {
                      "type": "integer"
                    },
                    "evidenceRepointed": {
                      "type": "integer"
                    }
                  }
                },
                "originalRequest": {
                  "type": "string",
                  "enum": [
                    "not_retained",
                    "redacted"
                  ]
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

export default importReceiptRoute('get')
