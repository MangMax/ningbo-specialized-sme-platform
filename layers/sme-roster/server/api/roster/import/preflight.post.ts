import type { DiscoveryJsonSchema, NitroDiscoverySchema } from '../../../../../core/server/utils/nitro-discovery-schema'
import { createRosterImportHandler } from '../../../utils/roster-import-route'

/**
 * **只读预检**：`POST /api/roster/import/preflight`（契约 §8.1）。
 *
 * **不写业务数据** —— 只算「这次提交会发生什么」并落一条 `status='preflight'` 的
 * `import_batch`（幂等键 = body 的 `idempotencyKey`）。想真写就用 `/commit`。
 *
 * 需要 token（`Authorization: Bearer <NUXT_API_TOKEN>` 或 `X-API-Token`）；
 * **未配置 token ⇒ 写入整体关闭**（与 `POST /api/jobs` 同一分法）。
 *
 * 逻辑在 `layers/sme-roster/server/utils/roster-import-http.ts`（不 import h3，可被真实 HTTP 回放测试直接驱动），
 * 路由只做 event → 请求描述 → 响应回填这一件事。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '名录导入预检（只读，不写业务数据）',
    description:
      'pending_review（待审核）须显式提交 confirmed_reason + confirmed + follow_review；保留正式历史并跟进审核，区别于 needs_review。' +
      '算「这次提交会发生什么」并落一条 `status=preflight` 的批次，**不改任何业务数据**。' +
      '幂等键是 body 的 `idempotencyKey`：同键重复调用返回/刷新同一批次。' +
      '需要 token：`Authorization: Bearer <NUXT_API_TOKEN>`（或 `X-API-Token`）；未配 token 时本接口整体关闭。' +
      '载荷见 `lib/roster-import-client.ts`（含 §8.4 的 `merges` 归并项）。',
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
  "description": "统一写入载荷；recognized_list 必填 collectionEvidence。三来源 rawData.version=1 显式选择 typed 原行，relations.rawFields 必须逐行相等；缺省保留 legacy，冲突整批拒绝。见 lib/platform/recognized-evidence.ts。",
  "properties": {
    "platformLegacyProvenance": {
      "type": "array",
      "minItems": 1,
      "maxItems": 100,
      "description": "独立legacy采集分页补证，保留typedState=unknown；queryId/自然键/源文件SHA/segmentIndex绑定，完整原行及事务重核，不更新collectionEvidence或版本。",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "queryId",
          "interface",
          "queryKey",
          "rdjb",
          "queriedAt",
          "sourceIdentity",
          "sourceSha256",
          "segmentIndex",
          "collection",
          "relations"
        ],
        "properties": {
          "queryId": {
            "type": "integer",
            "minimum": 1
          },
          "interface": {
            "type": "string",
            "enum": [
              "business_list"
            ]
          },
          "queryKey": {
            "type": "string",
            "minLength": 1
          },
          "rdjb": {
            "type": "string",
            "minLength": 1
          },
          "queriedAt": {
            "type": "string"
          },
          "sourceIdentity": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          },
          "sourceSha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "segmentIndex": {
            "type": "integer",
            "minimum": 0
          },
          "collection": {
            "type": "object",
            "properties": {
              "source": {
                "type": "string",
                "enum": [
                  "businessList"
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
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "uscc": {
                    "type": "string"
                  },
                  "combination": {
                    "type": "string",
                    "const": "and"
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
                  }
                },
                "required": [
                  "combination"
                ]
              },
              "titleScope": {
                "type": "object",
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
                },
                "required": [
                  "mode",
                  "rdjb"
                ]
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
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {
                    "type": "string"
                  }
                }
              },
              "pages": {
                "type": "array",
                "items": {
                  "type": "object",
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
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "page": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "maxPage": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991
                        },
                        {
                          "type": "null"
                        }
                      ]
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
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "declaredTotal": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "error": {
                      "anyOf": [
                        {
                          "type": "object",
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
                          },
                          "required": [
                            "code",
                            "message"
                          ]
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "source",
                    "rdjb",
                    "page",
                    "status",
                    "fetchedCount",
                    "declaredTotal",
                    "error"
                  ]
                }
              },
              "fetchedCount": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "declaredTotal": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
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
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "page": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "source",
                    "rdjb",
                    "page"
                  ]
                }
              },
              "error": {
                "anyOf": [
                  {
                    "type": "object",
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
                    },
                    "required": [
                      "code",
                      "message"
                    ]
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "limits": {
                "type": "object",
                "properties": {
                  "maxRequests": {
                    "type": "number"
                  },
                  "maxRows": {
                    "type": "number"
                  },
                  "maxDurationMs": {
                    "type": "number"
                  },
                  "pageSize": {
                    "type": "number"
                  }
                },
                "required": [
                  "maxRequests",
                  "maxRows",
                  "maxDurationMs",
                  "pageSize"
                ]
              }
            },
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
            "description": "完整原businessList legacy采集结果：source/status/effectiveConditions/titleScope/queriedAt/completedAt/rows/pages/fetchedCount/declaredTotal/completeness/fullRange/unfinished/error/limits。rows只保留原字符串，不接受rawData/dataRows，不补造响应正文。",
            "additionalProperties": false
          },
          "relations": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "sequenceNo",
                "relationKey",
                "rawFields"
              ],
              "properties": {
                "sequenceNo": {
                  "type": "integer",
                  "minimum": 1
                },
                "relationKey": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "rawFields": {
                  "type": "object",
                  "additionalProperties": {
                    "type": "string"
                  }
                }
              }
            },
            "maxItems": 5000
          }
        }
      }
    },
    "platformRecordObservations": {
      "type": "array",
      "minItems": 1,
      "maxItems": 100,
      "description": "sourceKind=platform_archive；服务端读取原观察，不接受客户端raw/hash。预检只读业务并冻结源指纹，commit重核，源缺失/漂移整批失败。",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "relationId"
        ],
        "properties": {
          "relationId": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        }
      }
    },
    "differences": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "enterpriseName": {
            "type": "string"
          },
          "uscc": {
            "type": [
              "string",
              "null"
            ]
          },
          "titleCode": {
            "type": "string",
            "enum": [
              "little_giant",
              "specialized_sme",
              "innovative_sme"
            ]
          },
          "direction": {
            "type": "string",
            "enum": [
              "missing_in_miit",
              "extra_in_miit"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "not_queried",
              "query_failed",
              "no_record",
              "confirmed_no_diff",
              "confirmed_reason",
              "needs_review"
            ]
          },
          "reasonCode": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "moved_out",
                  "deregistered",
                  "renamed",
                  "platform_stale",
                  "pending_review",
                  "moved_in",
                  "other"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "reasonNote": {
            "type": [
              "string",
              "null"
            ]
          },
          "measureCode": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "keep_history",
                  "mark_platform_snapshot",
                  "follow_review",
                  "mark_moved_out",
                  "mark_deregistered",
                  "update_current_name",
                  "record_moved_in",
                  "manual_review",
                  "none"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "measureNote": {
            "type": [
              "string",
              "null"
            ]
          },
          "evidenceQueryId": {
            "type": [
              "number",
              "null"
            ]
          },
          "evidenceRelationId": {
            "type": [
              "number",
              "null"
            ]
          },
          "evidenceQueryRef": {
            "type": "object",
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
                "type": [
                  "string",
                  "null"
                ]
              },
              "queriedAt": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "sequenceNo": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "relationKey": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "interface",
              "queryKey"
            ],
            "additionalProperties": {},
            "description": "原查询自然键；queriedAt 省略时须唯一命中。关系引用须带 sequenceNo，给出 relationKey 时须与序号指向同一原行。"
          },
          "evidenceRelationRef": {
            "type": "object",
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
                "type": [
                  "string",
                  "null"
                ]
              },
              "queriedAt": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "sequenceNo": {
                "type": "number",
                "minimum": 1
              },
              "relationKey": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "interface",
              "queryKey",
              "sequenceNo"
            ],
            "additionalProperties": {}
          },
          "movedIn": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "city": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "titleCode": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "year": {
                    "type": [
                      "number",
                      "null"
                    ]
                  },
                  "batch": {
                    "type": [
                      "number",
                      "null"
                    ]
                  }
                },
                "additionalProperties": {}
              },
              {
                "type": "null"
              }
            ]
          },
          "verificationStatus": {
            "type": "string",
            "enum": [
              "confirmed",
              "pending"
            ]
          },
          "recordedAt": {
            "type": "string"
          }
        },
        "required": [
          "titleCode",
          "direction",
          "recordedAt"
        ],
        "additionalProperties": {},
        "anyOf": [
          {
            "required": [
              "enterpriseName"
            ]
          },
          {
            "required": [
              "uscc"
            ]
          }
        ]
      },
      "description": "原差异解释导入；enterpriseName 或 uscc 定位主体，证据裸 id 与对应自然键不可同时给。pending_review 须配 confirmed_reason + confirmed + follow_review；已由生命周期接管的坐标拒绝旧导入，使用 decision-lifecycle commands。缺失/null、归一化及原错误均由核心处理，不新增裁决规则。"
    },
    "platformQueries": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "reuseExisting": {
            "type": "boolean",
            "const": true
          },
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
            "type": "string"
          },
          "titleCode": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "little_giant",
                  "specialized_sme",
                  "innovative_sme"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "queriedAt": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "success",
              "failed",
              "no_record",
              "not_queried",
              "partial"
            ]
          },
          "collectionEvidence": {
            "anyOf": [
              {
                "type": "object",
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
                    "properties": {
                      "name": {
                        "type": "string"
                      },
                      "uscc": {
                        "type": "string"
                      },
                      "combination": {
                        "type": "string",
                        "const": "and"
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
                      }
                    },
                    "required": [
                      "combination"
                    ]
                  },
                  "titleScope": {
                    "type": "object",
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
                    },
                    "required": [
                      "mode",
                      "rdjb"
                    ]
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
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {
                        "type": "string"
                      }
                    }
                  },
                  "dataRows": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "additionalProperties": {}
                    }
                  },
                  "rawData": {
                    "type": "object",
                    "properties": {
                      "version": {
                        "type": "number",
                        "const": 1
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
                              "type": [
                                "string",
                                "null"
                              ]
                            },
                            "page": {
                              "type": "integer",
                              "exclusiveMinimum": 0,
                              "maximum": 9007199254740991
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
                          },
                          "required": [
                            "source",
                            "rdjb",
                            "page",
                            "format",
                            "body"
                          ],
                          "additionalProperties": false
                        }
                      }
                    },
                    "required": [
                      "version",
                      "rows",
                      "pages"
                    ],
                    "additionalProperties": false
                  },
                  "pages": {
                    "type": "array",
                    "items": {
                      "type": "object",
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
                          "type": [
                            "string",
                            "null"
                          ]
                        },
                        "page": {
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991
                        },
                        "maxPage": {
                          "anyOf": [
                            {
                              "type": "integer",
                              "exclusiveMinimum": 0,
                              "maximum": 9007199254740991
                            },
                            {
                              "type": "null"
                            }
                          ]
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
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "declaredTotal": {
                          "anyOf": [
                            {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "error": {
                          "anyOf": [
                            {
                              "type": "object",
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
                              },
                              "required": [
                                "code",
                                "message"
                              ]
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "source",
                        "rdjb",
                        "page",
                        "status",
                        "fetchedCount",
                        "declaredTotal",
                        "error"
                      ]
                    }
                  },
                  "fetchedCount": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "declaredTotal": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
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
                          "type": [
                            "string",
                            "null"
                          ]
                        },
                        "page": {
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991
                        }
                      },
                      "required": [
                        "source",
                        "rdjb",
                        "page"
                      ]
                    }
                  },
                  "error": {
                    "anyOf": [
                      {
                        "type": "object",
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
                        },
                        "required": [
                          "code",
                          "message"
                        ]
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "limits": {
                    "type": "object",
                    "properties": {
                      "maxRequests": {
                        "type": "number"
                      },
                      "maxRows": {
                        "type": "number"
                      },
                      "maxDurationMs": {
                        "type": "number"
                      },
                      "pageSize": {
                        "type": "number"
                      }
                    },
                    "required": [
                      "maxRequests",
                      "maxRows",
                      "maxDurationMs",
                      "pageSize"
                    ]
                  }
                },
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
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "failureReason": {
            "type": [
              "string",
              "null"
            ]
          },
          "rawResponse": {
            "type": [
              "string",
              "null"
            ]
          },
          "relations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "sequenceNo": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "description": "原查询内正安全整数序号；新完整采集按输入顺序从 1 连续编号，不截断小数"
                },
                "relationKey": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "enterpriseId": {
                  "type": [
                    "number",
                    "null"
                  ]
                },
                "usccRaw": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "nameRaw": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "aliasNameRaw": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "province": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "status": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "batch": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "declareKind": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "appliedAt": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "awardBatchLabel": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "year": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "matchBasis": {
                  "type": "string",
                  "enum": [
                    "uscc",
                    "alias",
                    "manual",
                    "none"
                  ]
                },
                "verificationStatus": {
                  "type": "string",
                  "enum": [
                    "confirmed",
                    "pending"
                  ]
                },
                "sourceText": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "rawFields": {
                  "anyOf": [
                    {
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "sequenceNo"
              ],
              "additionalProperties": {}
            }
          }
        },
        "required": [
          "interface",
          "queryKey",
          "queriedAt"
        ],
        "additionalProperties": {},
        "allOf": [
          {
            "if": {
              "properties": {
                "interface": {
                  "const": "recognized_list"
                }
              },
              "required": [
                "interface"
              ],
              "not": {
                "properties": {
                  "reuseExisting": {
                    "const": true
                  }
                },
                "required": [
                  "reuseExisting"
                ]
              }
            },
            "then": {
              "required": [
                "collectionEvidence"
              ],
              "properties": {
                "collectionEvidence": {
                  "type": "object"
                }
              }
            }
          }
        ]
      },
      "description": "三来源原查询归档；recognized_list 新采集须带原 collectionEvidence，来源/interface、查询坐标、状态/称号及每条 relation 序号/身份/rawFields 必须匹配原行。dataRows 保留全部 typed 业务字段而不保存请求/响应正文；rawData.version=1 保留 typed JSON 原值、原页 body 与来源隔离；缺省保持 legacy。reuseExisting:true 仅引用已存坐标，不补行；legacy 无 collectionEvidence 时 rawResponse 省略/null 是原引用哨兵，字符串 null 不是。显式不可变值、原行及 hash 冲突由核心拒绝，不重算来源。"
    },
    "announcement": {
      "type": "object",
      "properties": {
        "sourceDocument": {
          "type": "object",
          "properties": {
            "source": {
              "type": "string",
              "enum": [
                "jxj",
                "miit"
              ]
            },
            "title": {
              "type": "string"
            },
            "docNumber": {
              "type": [
                "string",
                "null"
              ]
            },
            "issueDate": {
              "type": [
                "string",
                "null"
              ]
            }
          },
          "required": [
            "source",
            "title"
          ],
          "additionalProperties": {}
        },
        "records": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "enterprise": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "uscc": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "district": {
                    "type": [
                      "string",
                      "null"
                    ]
                  }
                },
                "required": [
                  "name"
                ],
                "additionalProperties": {}
              },
              "titleCode": {
                "type": "string",
                "enum": [
                  "little_giant",
                  "specialized_sme",
                  "innovative_sme"
                ]
              },
              "source": {
                "type": "string",
                "enum": [
                  "jxj",
                  "miit"
                ]
              },
              "events": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "eventType": {
                      "type": "string",
                      "enum": [
                        "award",
                        "review",
                        "maintain",
                        "nurture"
                      ]
                    },
                    "year": {
                      "description": "所涉年份；旧载荷按领域 optionalInt 处理",
                      "type": [
                        "number",
                        "null"
                      ]
                    },
                    "batchSeq": {
                      "type": [
                        "number",
                        "null"
                      ]
                    },
                    "decidedYear": {
                      "type": [
                        "number",
                        "null"
                      ]
                    },
                    "reviewOutcome": {
                      "anyOf": [
                        {
                          "type": "string",
                          "enum": [
                            "passed",
                            "failed"
                          ]
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "evidence": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "sourceFile": {
                            "type": "string"
                          },
                          "attachment": {
                            "type": [
                              "string",
                              "null"
                            ]
                          },
                          "listNo": {
                            "type": [
                              "number",
                              "null"
                            ]
                          },
                          "page": {
                            "description": "仅 PDF 实际页码；非 PDF 须省略或 null",
                            "anyOf": [
                              {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "publishedRow": {
                            "type": "object",
                            "properties": {
                              "nameRaw": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "usccRaw": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "districtRaw": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "declaration": {
                                "oneOf": [
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "existing"
                                      },
                                      "sourceDocumentId": {
                                        "type": "integer",
                                        "exclusiveMinimum": 0,
                                        "maximum": 9007199254740991
                                      },
                                      "basis": {
                                        "type": "string",
                                        "maxLength": 4000
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "sourceDocumentId",
                                      "basis"
                                    ],
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "independent"
                                      },
                                      "sourceDocument": {
                                        "type": "object",
                                        "properties": {
                                          "source": {
                                            "type": "string",
                                            "const": "jxj"
                                          },
                                          "title": {
                                            "type": "string",
                                            "maxLength": 4000
                                          },
                                          "docNumber": {
                                            "anyOf": [
                                              {
                                                "type": "string",
                                                "maxLength": 4000
                                              },
                                              {
                                                "type": "null"
                                              }
                                            ]
                                          },
                                          "issueDate": {
                                            "anyOf": [
                                              {
                                                "type": "string",
                                                "maxLength": 4000
                                              },
                                              {
                                                "type": "null"
                                              }
                                            ]
                                          },
                                          "path": {
                                            "type": "string",
                                            "maxLength": 4000
                                          }
                                        },
                                        "required": [
                                          "source",
                                          "title",
                                          "docNumber",
                                          "issueDate",
                                          "path"
                                        ],
                                        "additionalProperties": false
                                      },
                                      "basis": {
                                        "type": "string",
                                        "maxLength": 4000
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "sourceDocument",
                                      "basis"
                                    ],
                                    "additionalProperties": false
                                  }
                                ]
                              },
                              "storedFileId": {
                                "anyOf": [
                                  {
                                    "type": "integer",
                                    "exclusiveMinimum": 0,
                                    "maximum": 9007199254740991
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "path": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "sha256": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "pattern": "^[a-f0-9]{64}$"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "bytes": {
                                "anyOf": [
                                  {
                                    "type": "integer",
                                    "minimum": 0,
                                    "maximum": 9007199254740991
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "attachment": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "sectionKey": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "listNo": {
                                "anyOf": [
                                  {
                                    "type": "integer",
                                    "exclusiveMinimum": 0,
                                    "maximum": 9007199254740991
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "page": {
                                "anyOf": [
                                  {
                                    "type": "integer",
                                    "exclusiveMinimum": 0,
                                    "maximum": 9007199254740991
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "sourceBindingKnown": {
                                "type": "boolean"
                              },
                              "actor": {
                                "type": "object",
                                "properties": {
                                  "type": {
                                    "type": "string",
                                    "enum": [
                                      "user",
                                      "agent"
                                    ]
                                  },
                                  "id": {
                                    "type": "string",
                                    "maxLength": 4000
                                  }
                                },
                                "required": [
                                  "type",
                                  "id"
                                ],
                                "additionalProperties": false
                              },
                              "basis": {
                                "type": "string",
                                "maxLength": 4000
                              }
                            },
                            "required": [
                              "nameRaw",
                              "usccRaw",
                              "districtRaw",
                              "declaration",
                              "storedFileId",
                              "path",
                              "sha256",
                              "bytes",
                              "attachment",
                              "sectionKey",
                              "listNo",
                              "page",
                              "sourceBindingKnown",
                              "actor",
                              "basis"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "required": [
                          "sourceFile"
                        ],
                        "additionalProperties": {}
                      }
                    }
                  },
                  "required": [
                    "eventType"
                  ],
                  "additionalProperties": {}
                }
              }
            },
            "required": [
              "enterprise",
              "titleCode"
            ],
            "additionalProperties": {}
          }
        }
      },
      "required": [
        "sourceDocument",
        "records"
      ],
      "additionalProperties": {},
      "description": "公布文件历史命令；未知附加字段保留，遗漏/null/归一化及逐项错误由现有领域校验处理；publishedRow 使用正式事实严格 DTO，原行留存后须对已核企业身份和事实调用补充预检，并在补充请求带回 officialEvidencePlanHash"
    },
    "officialEvidenceAppends": {
      "description": "精确正式佐证追加；expectedVersion=当前event.revision，显式声明与publishedRow；无公布原行时先调用导入预检并在payload带回officialEvidencePlanHash；含公布原行时使用补充预检",
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "eventId": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "recordId": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "enterpriseId": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "expectedVersion": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "evidence": {
            "type": "object",
            "properties": {
              "sourceFile": {
                "type": "string",
                "maxLength": 4000
              },
              "attachment": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 4000
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "listNo": {
                "anyOf": [
                  {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "page": {
                "anyOf": [
                  {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "publishedRow": {
                "type": "object",
                "properties": {
                  "nameRaw": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "usccRaw": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "districtRaw": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "declaration": {
                    "oneOf": [
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "existing"
                          },
                          "sourceDocumentId": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          },
                          "basis": {
                            "type": "string",
                            "maxLength": 4000
                          }
                        },
                        "required": [
                          "kind",
                          "sourceDocumentId",
                          "basis"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "independent"
                          },
                          "sourceDocument": {
                            "type": "object",
                            "properties": {
                              "source": {
                                "type": "string",
                                "const": "jxj"
                              },
                              "title": {
                                "type": "string",
                                "maxLength": 4000
                              },
                              "docNumber": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "issueDate": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "path": {
                                "type": "string",
                                "maxLength": 4000
                              }
                            },
                            "required": [
                              "source",
                              "title",
                              "docNumber",
                              "issueDate",
                              "path"
                            ],
                            "additionalProperties": false
                          },
                          "basis": {
                            "type": "string",
                            "maxLength": 4000
                          }
                        },
                        "required": [
                          "kind",
                          "sourceDocument",
                          "basis"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  },
                  "storedFileId": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "path": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "sha256": {
                    "anyOf": [
                      {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "bytes": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "attachment": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "sectionKey": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "listNo": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "page": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "sourceBindingKnown": {
                    "type": "boolean"
                  },
                  "actor": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "user",
                          "agent"
                        ]
                      },
                      "id": {
                        "type": "string",
                        "maxLength": 4000
                      }
                    },
                    "required": [
                      "type",
                      "id"
                    ],
                    "additionalProperties": false
                  },
                  "basis": {
                    "type": "string",
                    "maxLength": 4000
                  }
                },
                "required": [
                  "nameRaw",
                  "usccRaw",
                  "districtRaw",
                  "declaration",
                  "storedFileId",
                  "path",
                  "sha256",
                  "bytes",
                  "attachment",
                  "sectionKey",
                  "listNo",
                  "page",
                  "sourceBindingKnown",
                  "actor",
                  "basis"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "sourceFile",
              "attachment",
              "listNo",
              "page",
              "publishedRow"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "eventId",
          "recordId",
          "enterpriseId",
          "expectedVersion",
          "evidence"
        ],
        "additionalProperties": false
      }
    },
    "officialEvidenceCorrections": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "enum": [
                "user",
                "agent"
              ]
            },
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4000
            }
          },
          "required": [
            "type",
            "id"
          ],
          "additionalProperties": false
        },
        "basis": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4000
        },
        "operations": {
          "minItems": 1,
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "evidenceId": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "eventId": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "recordId": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "enterpriseId": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "expectedVersion": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "coordinate": {
                "type": "object",
                "properties": {
                  "sourceFile": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 4000
                  },
                  "attachment": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "listNo": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "page": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "sourceFile",
                  "attachment",
                  "listNo",
                  "page"
                ],
                "additionalProperties": false
              },
              "publishedRow": {
                "type": "object",
                "properties": {
                  "nameRaw": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "usccRaw": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "districtRaw": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "declaration": {
                    "oneOf": [
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "existing"
                          },
                          "sourceDocumentId": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          },
                          "basis": {
                            "type": "string",
                            "maxLength": 4000
                          }
                        },
                        "required": [
                          "kind",
                          "sourceDocumentId",
                          "basis"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "independent"
                          },
                          "sourceDocument": {
                            "type": "object",
                            "properties": {
                              "source": {
                                "type": "string",
                                "const": "jxj"
                              },
                              "title": {
                                "type": "string",
                                "maxLength": 4000
                              },
                              "docNumber": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "issueDate": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "maxLength": 4000
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "path": {
                                "type": "string",
                                "maxLength": 4000
                              }
                            },
                            "required": [
                              "source",
                              "title",
                              "docNumber",
                              "issueDate",
                              "path"
                            ],
                            "additionalProperties": false
                          },
                          "basis": {
                            "type": "string",
                            "maxLength": 4000
                          }
                        },
                        "required": [
                          "kind",
                          "sourceDocument",
                          "basis"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  },
                  "storedFileId": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "path": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "sha256": {
                    "anyOf": [
                      {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "bytes": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "attachment": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "sectionKey": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 4000
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "listNo": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "page": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "sourceBindingKnown": {
                    "type": "boolean"
                  },
                  "actor": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "user",
                          "agent"
                        ]
                      },
                      "id": {
                        "type": "string",
                        "maxLength": 4000
                      }
                    },
                    "required": [
                      "type",
                      "id"
                    ],
                    "additionalProperties": false
                  },
                  "basis": {
                    "type": "string",
                    "maxLength": 4000
                  }
                },
                "required": [
                  "nameRaw",
                  "usccRaw",
                  "districtRaw",
                  "declaration",
                  "storedFileId",
                  "path",
                  "sha256",
                  "bytes",
                  "attachment",
                  "sectionKey",
                  "listNo",
                  "page",
                  "sourceBindingKnown",
                  "actor",
                  "basis"
                ],
                "additionalProperties": false
              },
              "expectedRowRevision": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740990
              }
            },
            "required": [
              "evidenceId",
              "eventId",
              "recordId",
              "enterpriseId",
              "expectedVersion",
              "coordinate",
              "publishedRow",
              "expectedRowRevision"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "actor",
        "basis",
        "operations"
      ],
      "additionalProperties": false,
      "description": "复用精确更正DTO；导入采用外层幂等键，每项明确publishedRow和expectedRowRevision，与追加/capture共用最终计划"
    },
    "officialEvidencePlanHash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "aliases": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "enterpriseName": {
            "type": [
              "string",
              "null"
            ]
          },
          "uscc": {
            "type": [
              "string",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "sourceKind": {
            "type": "string",
            "enum": [
              "platform_business",
              "platform_apply",
              "announcement",
              "manual"
            ]
          },
          "sourceRefId": {
            "type": [
              "number",
              "null"
            ]
          },
          "sourceRelationRef": {
            "anyOf": [
              {
                "type": "object",
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
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "queriedAt": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "sequenceNo": {
                    "type": "number",
                    "minimum": 1
                  },
                  "relationKey": {
                    "type": [
                      "string",
                      "null"
                    ]
                  }
                },
                "required": [
                  "interface",
                  "queryKey",
                  "sequenceNo"
                ],
                "additionalProperties": {}
              },
              {
                "type": "null"
              }
            ]
          },
          "verificationStatus": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "confirmed",
                  "pending",
                  "withdrawn"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "validFrom": {
            "type": [
              "string",
              "null"
            ]
          },
          "validTo": {
            "type": [
              "string",
              "null"
            ]
          },
          "note": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "name",
          "sourceKind"
        ],
        "additionalProperties": {},
        "anyOf": [
          {
            "required": [
              "enterpriseName"
            ]
          },
          {
            "required": [
              "uscc"
            ]
          }
        ]
      },
      "description": "企业别名证据；uscc 或 enterpriseName 定位已有或本批企业，sourceRefId 与 sourceRelationRef 不可同时给。confirmed 平台别名须有匹配主体及别名的原关系证据。旧字段归一化、缺失/null、附加字段与逐项错误由原导入核心处理。"
    },
    "exportSnapshot": {
      "type": "object",
      "properties": {
        "titleCode": {
          "type": "string",
          "enum": [
            "little_giant",
            "specialized_sme",
            "innovative_sme"
          ]
        },
        "year": {
          "type": "number",
          "description": "来源年度；沿用核心 optionalInt 非零判据，写入保留给定数值"
        },
        "collectedOn": {
          "type": "string"
        },
        "originalFilename": {
          "type": "string"
        },
        "sha256": {
          "type": "string",
          "description": "来源快照身份；原核心只要求非空，不新增 hash 格式拒绝"
        },
        "rows": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sourceRowNo": {
                "type": "number",
                "description": "原行序；沿用 optionalInt，同批不得重复"
              },
              "usccRaw": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "nameRaw": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "district": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "province": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "city": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "regStatus": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "rawFields": {
                "anyOf": [
                  {
                    "type": "object",
                    "propertyNames": {
                      "type": "string"
                    },
                    "additionalProperties": {}
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "sourceRowNo"
            ],
            "additionalProperties": {}
          }
        }
      },
      "required": [
        "titleCode",
        "year",
        "collectedOn",
        "originalFilename",
        "sha256"
      ],
      "additionalProperties": {},
      "description": "平台导出快照现状对照；省略 rows 可提交空快照，不重解释为正式公布历史；同 SHA 重放、源行冲突由原核心判定。"
    },
    "usccBackfills": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "enterpriseId": {
            "type": "number"
          },
          "enterpriseName": {
            "type": "string"
          },
          "uscc": {
            "type": "string",
            "description": "沿用 usccFormatVerdict 的格式及校验位判据与旧归一化，不猜代码"
          },
          "source": {
            "type": "object",
            "properties": {
              "url": {
                "type": "string"
              },
              "checkedOn": {
                "type": "string",
                "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              "basis": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "region": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "url",
              "checkedOn",
              "basis",
              "name"
            ],
            "additionalProperties": {},
            "description": "必填判据沿用 missingUsccSourceFields：非空 URL、查证日期、主体对应依据及来源名称；不新增 URL scheme 或日历有效性规则。"
          },
          "note": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "uscc",
          "source"
        ],
        "additionalProperties": {},
        "anyOf": [
          {
            "required": [
              "enterpriseId"
            ]
          },
          {
            "required": [
              "enterpriseName"
            ]
          }
        ]
      },
      "description": "仅补已有企业缺失统代；enterpriseId 或唯一 enterpriseName 定位，同时给须一致。已有代码拒绝覆盖，被其他企业占用拒绝自动合并；原 source/lineage 保留，不改名或写别名。"
    },
    "merges": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "fromEnterpriseId": {
            "type": "number"
          },
          "fromEnterpriseName": {
            "type": "string"
          },
          "intoUscc": {
            "type": "string"
          },
          "canonicalName": {
            "type": [
              "string",
              "null"
            ]
          },
          "aliasName": {
            "type": "string"
          },
          "sourceKind": {
            "type": "string",
            "enum": [
              "platform_business",
              "platform_apply",
              "announcement",
              "manual"
            ]
          },
          "sourceRefId": {
            "type": "number"
          },
          "sourceRelationRef": {
            "type": "object",
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
                "type": [
                  "string",
                  "null"
                ]
              },
              "queriedAt": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "sequenceNo": {
                "type": "number",
                "minimum": 1
              },
              "relationKey": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "interface",
              "queryKey",
              "sequenceNo"
            ],
            "additionalProperties": {}
          },
          "evidenceQueryId": {
            "type": [
              "number",
              "null"
            ]
          },
          "evidenceQueryRef": {
            "type": "object",
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
                "type": [
                  "string",
                  "null"
                ]
              },
              "queriedAt": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "sequenceNo": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "relationKey": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "interface",
              "queryKey"
            ],
            "additionalProperties": {},
            "description": "原查询自然键；queriedAt 省略时须唯一命中。关系引用须带 sequenceNo，给出 relationKey 时须与序号指向同一原行。"
          },
          "note": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "intoUscc"
        ],
        "additionalProperties": {},
        "anyOf": [
          {
            "required": [
              "fromEnterpriseId"
            ]
          },
          {
            "required": [
              "fromEnterpriseName"
            ]
          }
        ]
      },
      "description": "原身份归并命令；fromEnterpriseId 或唯一 fromEnterpriseName 定位，同时给须一致。intoUscc 规范主体可在本批创建。canonicalName 省略/null 不改名，给出须非空；证据裸 id 与自然键不可同时给。保留别名、事件、出处、回执及归并血缘；生命周期/差异冲突由原核心保护，整批原子执行。"
    }
  },
  "additionalProperties": true
},
            },
          } satisfies DiscoveryJsonSchema as unknown as NitroDiscoverySchema,
        },
      },
    },
    responses: {
      200: {
        description: '预检结果。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                batchId: { type: 'integer' },
                status: { type: 'string', enum: ['preflight'] },
                preflight: {
                  type: 'object',
                  properties: {
                    add: { type: 'integer', description: '将新增的行数。' },
                    update: { type: 'integer', description: '将复用/更新的既有行数。' },
                    remove: { type: 'integer', description: '归并会删除的企业行数。' },
                    review: { type: 'integer', description: '落在待核状态的行数。' },
                    conflicts: { type: 'array', items: { type: 'object' } },
                    canonicalProjection: {
                      type: 'array', description: '逐观察的业务身份/内容可验证性计划；新观察 relationId 为 null。',
                      items: { type: 'object', properties: {
                        relationId: { type: 'integer', nullable: true },
                        identityState: { type: 'string', enum: ['resolved', 'missing_key', 'conflict'] },
                        contentState: { type: 'string', enum: ['verified', 'unverifiable'] },
                        keySource: { type: 'string', enum: ['relation_key', 'raw_id', 'both', 'none'] },
                      } },
                    },
                    platformObservationSources: {
                      type: 'array', description: '服务端保存的原观察输入指纹；commit服务端重读校验，不接受客户端hash。',
                      items: { type: 'object', properties: { relationId: { type: 'integer' }, inputFingerprint: { type: 'string' } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: '请求体不合法（缺幂等键 / 来源身份 / payload）。' },
      401: { description: '未带 token、token 不匹配，或服务端未配置 `NUXT_API_TOKEN`。' },
      409: { description: '幂等键属于其他请求或来源；历史投影预检后不能更换命令。' },
    },
  },
})

export default createRosterImportHandler('preflight')
