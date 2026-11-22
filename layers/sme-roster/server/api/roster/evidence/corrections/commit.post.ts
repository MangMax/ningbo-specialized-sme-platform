import { evidenceCorrectionRoute } from '#sme-roster/server/utils/roster-evidence-correction-route'
defineRouteMeta({
  "openAPI": {
    "tags": [
      "名录出处"
    ],
    "summary": "原子提交正式出处精确更正",
    "description": "按稳定证据/事件/记录/企业ID定位，校验版本、文件身份、源PDF页数、附件和同段坐标。预检不写业务；提交全批原子，保留稳定ID、原件字节及前后追加审计。关联对应动态待重核。",
    "security": [
      {
        "bearerAuth": []
      }
    ],
    "requestBody": {
      "required": true,
      "content": {
        "application/json": {
          "schema": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "request",
              "planHash"
            ],
            "properties": {
              "request": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "idempotencyKey",
                  "actor",
                  "basis",
                  "operations"
                ],
                "properties": {
                  "idempotencyKey": {
                    "type": "string",
                    "description": "1–200字符；同键不同请求或计划409"
                  },
                  "actor": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "type",
                      "id"
                    ],
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "user",
                          "agent"
                        ]
                      },
                      "id": {
                        "type": "string"
                      }
                    }
                  },
                  "basis": {
                    "type": "string",
                    "description": "已核实的更正依据，必填"
                  },
                  "operations": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 100,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "evidenceId",
                        "eventId",
                        "recordId",
                        "enterpriseId",
                        "expectedVersion",
                        "coordinate"
                      ],
                      "properties": {
                        "evidenceId": {
                          "type": "integer",
                          "minimum": 1
                        },
                        "eventId": {
                          "type": "integer",
                          "minimum": 1
                        },
                        "recordId": {
                          "type": "integer",
                          "minimum": 1
                        },
                        "enterpriseId": {
                          "type": "integer",
                          "minimum": 1
                        },
                        "expectedVersion": {
                          "type": "string",
                          "description": "get_roster_evidence返回的64位版本指纹；旧值变化409"
                        },
                        "coordinate": {
                          "type": "object",
                          "additionalProperties": false,
                          "required": [
                            "sourceFile",
                            "attachment",
                            "listNo",
                            "page"
                          ],
                          "properties": {
                            "sourceFile": {
                              "type": "string",
                              "description": "文件库相对路径；已登记且在用的经信局公布名单原件（jxj / announcement）"
                            },
                            "attachment": {
                              "type": "string",
                              "nullable": true,
                              "description": "附件名；归一后与已声明段匹配"
                            },
                            "listNo": {
                              "type": "integer",
                              "minimum": 1,
                              "nullable": true,
                              "description": "名单序号，仅坐标，不用于定位证据"
                            },
                            "page": {
                              "type": "integer",
                              "minimum": 1,
                              "nullable": true,
                              "description": "PDF实际页序，核验原件页数；非PDF必须null"
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "planHash": {
                "type": "string",
                "description": "预检返回的64位SHA256计划哈希"
              }
            }
          }
        }
      }
    },
    "responses": {
      "200": {
        "description": "committed receipt: idempotencyKey,planHash,impact,evidenceIds,committedAt; replay returns same receipt"
      },
      "400": {
        "description": "Invalid request"
      },
      "401": {
        "description": "Configured token required"
      },
      "409": {
        "description": "Version, source, plan or idempotency conflict"
      },
      "422": {
        "description": "File, page, attachment or coordinate validation failed"
      },
      "500": {
        "description": "Atomic failure; no partial writes"
      }
    }
  }
})
export default evidenceCorrectionRoute('commit')
