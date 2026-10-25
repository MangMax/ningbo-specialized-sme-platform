import { createRosterImportHandler } from '../../../utils/roster-import-route'

/**
 * **事务提交**：`POST /api/roster/import/commit`（契约 §8.2）。
 *
 * 请求体同 `/preflight`。**幂等键在 body 的 `idempotencyKey`**（`import_batch.idempotency_key` 唯一）：
 * 同一 key 重复调用**不再重复写企业/事件**，返回既有批次的摘要。
 *
 * **单批事务**：要么整批 `committed`，要么 `failed` 且 `error` 说明原因 —— 绝不部分提交。
 * 逐项错误形状 `{ ok:false, kind, ref, error:{ code, field?, message } }`，不静默丢行。
 *
 * 需要 token（`Authorization: Bearer <NUXT_API_TOKEN>` 或 `X-API-Token`）；未配 token ⇒ 整体关闭。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '名录导入提交（单批事务、幂等重放）',
    description:
      'pending_review（待审核）须显式提交 confirmed_reason + confirmed + follow_review；保留正式历史并跟进审核，区别于 needs_review。' +
      '按 body 的 `idempotencyKey` 幂等提交：同键重复调用返回既有批次摘要，不重复写企业/事件。' +
      '单批事务：要么整批 committed，要么 failed（`error` 说明原因）—— 绝不部分提交。' +
      '载荷见 `docs/roster-lifecycle-contract.md` §8.3，归并项见 §8.4（血缘落 `item_results`）。' +
      '需要 token：`Authorization: Bearer <NUXT_API_TOKEN>`（或 `X-API-Token`）；未配 token 时本接口整体关闭。',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['idempotencyKey', 'sourceKind', 'sourceIdentity', 'payload'],
            properties: {
              idempotencyKey: { type: 'string', description: '幂等键（库层面唯一）。' },
              sourceKind: {
                type: 'string',
                enum: ['announcement', 'platform_export', 'platform_archive', 'alias_evidence'],
              },
              sourceIdentity: { type: 'string', description: '来源身份：文件相对路径 / 逻辑标识（不含凭证）。' },
              sourceSha256: { type: 'string', nullable: true },
              payload: {
  "type": "object",
  "description": "统一写入载荷；recognized_list 必填 collectionEvidence。三来源 rawData.version=1 显式选择 typed 原行，relations.rawFields 必须逐行相等；缺省保留 legacy，冲突整批拒绝。见 docs/platform-recognized-evidence.md。",
  "properties": {
    "platformRecordObservations": {
      "type": "array", "minItems": 1, "maxItems": 100,
      "description": "sourceKind=platform_archive；服务端读取原观察，不接受客户端raw/hash。预检只读业务并冻结源指纹，commit重核，源缺失/漂移整批失败。",
      "items": { "type": "object", "additionalProperties": false, "required": ["relationId"], "properties": { "relationId": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 } } }
    },
    "differences": {
      "type": "array",
      "description": "代理/用户明确裁决；不自动推断。完整字段见名录契约 §8.3。",
      "items": {
        "type": "object",
        "required": ["titleCode", "direction", "recordedAt"],
        "properties": {
          "reasonCode": { "type": "string", "nullable": true, "enum": ["moved_out", "deregistered", "renamed", "platform_stale", "pending_review", "moved_in", "other"] },
          "measureCode": { "type": "string", "nullable": true, "enum": ["keep_history", "mark_platform_snapshot", "follow_review", "mark_moved_out", "mark_deregistered", "update_current_name", "record_moved_in", "manual_review", "none"] },
          "status": { "type": "string", "enum": ["not_queried", "query_failed", "no_record", "confirmed_no_diff", "confirmed_reason", "needs_review"] },
          "verificationStatus": { "type": "string", "enum": ["confirmed", "pending"] }
        }
      }
    },
    "platformQueries": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "interface",
          "queryKey",
          "queriedAt"
        ],
        "properties": {
          "interface": {
            "type": "string",
            "enum": [
              "business_list",
              "apply_list",
              "recognized_list"
            ]
          },
          "queryKey": {
            "type": "string"
          },
          "rdjb": {
            "type": "string",
            "description": "recognized_list: original titleScope.rdjb joined with commas, preserving order"
          },
          "titleCode": {
            "type": "string",
            "nullable": true
          },
          "queriedAt": {
            "type": "string",
            "format": "date-time"
          },
          "status": {
            "type": "string",
            "enum": [
              "success",
              "no_record",
              "failed",
              "not_queried",
              "partial"
            ]
          },
          "collectionEvidence": {
            "type": "object",
            "required": [
              "source",
              "status",
              "effectiveConditions",
              "titleScope",
              "queriedAt",
              "completedAt",
              "rows",
              "pages",
              "fetchedCount",
              "declaredTotal",
              "completeness",
              "fullRange",
              "unfinished",
              "error",
              "limits"
            ],
            "properties": {
              "source": {
                "type": "string",
                "enum": [
                  "queryList",
                  "businessList",
                  "queryBusList"
                ]
              },
              "status": {
                "type": "string",
                "enum": [
                  "success",
                  "no_record",
                  "auth_failed",
                  "failed",
                  "partial",
                  "not_queried"
                ]
              },
              "effectiveConditions": {
                "type": "object",
                "required": [
                  "combination"
                ],
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "uscc": {
                    "type": "string"
                  },
                  "sqsj": {
                    "type": "string"
                  },
                  "rddqrq": {
                    "type": "string"
                  },
                  "whpcyear": {
                    "type": "string"
                  },
                  "whpc": {
                    "type": "string"
                  },
                  "szq": {
                    "type": "string"
                  },
                  "orderField": {
                    "type": "string"
                  },
                  "orderDirection": {
                    "type": "string"
                  },
                  "combination": {
                    "type": "string",
                    "enum": [
                      "and"
                    ]
                  }
                }
              },
              "titleScope": {
                "type": "object",
                "required": [
                  "mode",
                  "rdjb"
                ],
                "properties": {
                  "mode": {
                    "type": "string",
                    "enum": [
                      "source_default",
                      "selected"
                    ]
                  },
                  "rdjb": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                }
              },
              "queriedAt": {
                "type": "string"
              },
              "completedAt": {
                "type": "string"
              },
              "rows": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": {
                    "type": "string"
                  }
                }
              },
              "rawData": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "version",
                  "rows",
                  "pages"
                ],
                "properties": {
                  "version": {
                    "type": "integer",
                    "enum": [
                      1
                    ]
                  },
                  "rows": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "additionalProperties": {}
                    }
                  },
                  "pages": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "source",
                        "rdjb",
                        "page",
                        "format",
                        "body"
                      ],
                      "properties": {
                        "source": {
                          "type": "string",
                          "enum": [
                            "queryList",
                            "businessList",
                            "queryBusList"
                          ]
                        },
                        "rdjb": {
                          "type": "string",
                          "nullable": true
                        },
                        "page": {
                          "type": "integer",
                          "minimum": 1
                        },
                        "format": {
                          "type": "string",
                          "enum": [
                            "json",
                            "html-script",
                            "html-table"
                          ]
                        },
                        "body": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              },
              "pages": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "source",
                    "rdjb",
                    "page",
                    "status",
                    "fetchedCount",
                    "declaredTotal",
                    "error"
                  ],
                  "properties": {
                    "source": {
                      "type": "string",
                      "enum": [
                        "queryList",
                        "businessList",
                        "queryBusList"
                      ]
                    },
                    "rdjb": {
                      "type": "string",
                      "nullable": true
                    },
                    "page": {
                      "type": "integer"
                    },
                    "status": {
                      "type": "string",
                      "enum": [
                        "success",
                        "auth_failed",
                        "failed"
                      ]
                    },
                    "fetchedCount": {
                      "type": "integer"
                    },
                    "maxPage": {
                      "type": "integer",
                      "nullable": true,
                      "minimum": 1
                    },
                    "declaredTotal": {
                      "type": "integer",
                      "nullable": true
                    },
                    "error": {
                      "type": "object",
                      "nullable": true,
                      "required": [
                        "code",
                        "message"
                      ],
                      "properties": {
                        "code": {
                          "type": "string",
                          "enum": [
                            "invalid_input",
                            "unsupported_source",
                            "credential_unavailable",
                            "auth_failed",
                            "upstream_failed",
                            "timeout",
                            "rate_limited",
                            "safety_limit",
                            "invalid_response",
                            "sensitive_response"
                          ]
                        },
                        "message": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              },
              "fetchedCount": {
                "type": "integer"
              },
              "declaredTotal": {
                "type": "integer",
                "nullable": true
              },
              "completeness": {
                "type": "string",
                "enum": [
                  "complete",
                  "partial",
                  "not_queried"
                ]
              },
              "fullRange": {
                "type": "boolean"
              },
              "unfinished": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "source",
                    "rdjb",
                    "page"
                  ],
                  "properties": {
                    "source": {
                      "type": "string",
                      "enum": [
                        "queryList",
                        "businessList",
                        "queryBusList"
                      ]
                    },
                    "rdjb": {
                      "type": "string",
                      "nullable": true
                    },
                    "page": {
                      "type": "integer"
                    }
                  }
                }
              },
              "error": {
                "type": "object",
                "nullable": true,
                "required": [
                  "code",
                  "message"
                ],
                "properties": {
                  "code": {
                    "type": "string",
                    "enum": [
                      "invalid_input",
                      "unsupported_source",
                      "credential_unavailable",
                      "auth_failed",
                      "upstream_failed",
                      "timeout",
                      "rate_limited",
                      "safety_limit",
                      "invalid_response",
                      "sensitive_response"
                    ]
                  },
                  "message": {
                    "type": "string"
                  }
                }
              },
              "limits": {
                "type": "object",
                "required": [
                  "maxRequests",
                  "maxRows",
                  "maxDurationMs",
                  "pageSize"
                ],
                "properties": {
                  "maxRequests": {
                    "type": "integer"
                  },
                  "maxRows": {
                    "type": "integer"
                  },
                  "maxDurationMs": {
                    "type": "integer"
                  },
                  "pageSize": {
                    "type": "integer"
                  }
                }
              }
            },
            "description": "Required for recognized_list only: original source=queryBusList result, with validated original times, conditions and page/row coverage. See docs/platform-recognized-evidence.md."
          },
          "relations": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "sequenceNo"
              ],
              "properties": {
                "sequenceNo": {
                  "type": "integer",
                  "minimum": 1
                },
                "relationKey": {
                  "type": "string",
                  "nullable": true
                },
                "enterpriseId": {
                  "type": "integer",
                  "nullable": true
                },
                "usccRaw": {
                  "type": "string",
                  "nullable": true
                },
                "nameRaw": {
                  "type": "string",
                  "nullable": true
                },
                "rawFields": {
                  "type": "object"
                }
              }
            }
          }
        }
      }
    }
  }
},
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: '提交结果（`committed` 或 `failed`；`failed` 时业务数据一行未写）。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                batchId: { type: 'integer' },
                status: { type: 'string', enum: ['committed', 'failed'] },
                summary: {
                  type: 'object',
                  properties: {
                    written: { type: 'integer', description: '本次**新增**的行数（收敛不算）。' },
                    skipped: { type: 'integer' },
                    failed: { type: 'integer' },
                    canonicalProjection: {
                      type: 'object', description: '新增业务身份/内容/映射单独记数；不计入旧written。',
                      properties: {
                        recordsCreated: { type: 'integer' }, versionsCreated: { type: 'integer' },
                        observationsCreated: { type: 'integer' }, observationsReused: { type: 'integer' },
                        missingKey: { type: 'integer' }, conflict: { type: 'integer' }, unverifiable: { type: 'integer' },
                      },
                    },
                    evidenceRepointed: {
                      type: 'integer',
                      description:
                        '本次真的改掉了几行 `record_evidence.source_file`（出处指针收敛，§8.9）。' +
                        '与预检的 `preflight.evidenceRepoints` 同口径、可直接相等比对。',
                    },
                  },
                },
                items: {
                  type: 'array',
                  description: '逐项结果；失败项形如 `{ ok:false, kind, ref, error:{ code, field?, message } }`。',
                  items: { type: 'object', properties: {
                    detail: { type: 'object', properties: {
                      canonicalProjection: { type: 'array', items: { type: 'object', properties: {
                        relationId: { type: 'integer' }, recordId: { type: 'integer', nullable: true }, versionId: { type: 'integer', nullable: true },
                        identityState: { type: 'string', enum: ['resolved', 'missing_key', 'conflict'] },
                        contentState: { type: 'string', enum: ['verified', 'unverifiable'] },
                        keySource: { type: 'string', enum: ['relation_key', 'raw_id', 'both', 'none'] },
                        projectionRuleVersion: { type: 'string' }, inputFingerprint: { type: 'string' },
                        recordCreated: { type: 'boolean' }, versionCreated: { type: 'boolean' }, observationCreated: { type: 'boolean' },
                      } } },
                    } },
                  } },
                },
                error: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      400: { description: '请求体不合法（缺幂等键 / 来源身份 / payload）。' },
      401: { description: '未带 token、token 不匹配，或服务端未配置 `NUXT_API_TOKEN`。' },
      409: { description: '幂等键属于其他请求或来源；历史投影预检/失败后也不能更换命令。' },
    },
  },
})

export default createRosterImportHandler('commit')
