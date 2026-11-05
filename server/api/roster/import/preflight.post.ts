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
 * 逻辑在 `server/utils/roster-import-http.ts`（不 import h3，可被真实 HTTP 回放测试直接驱动），
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
      '载荷见 `docs/roster-lifecycle-contract.md` §8.3（含 §8.4 的 `merges` 归并项）。',
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
      "description": "代理/用户明确裁决；不自动推断。完整字段见名录契约 §8.3。",
      "items": {
        "type": "object",
        "required": [
          "titleCode",
          "direction",
          "recordedAt"
        ],
        "properties": {
          "reasonCode": {
            "type": "string",
            "nullable": true,
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
          "measureCode": {
            "type": "string",
            "nullable": true,
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
          "verificationStatus": {
            "type": "string",
            "enum": [
              "confirmed",
              "pending"
            ]
          }
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
          "reuseExisting": {
            "type": "boolean",
            "enum": [
              true
            ],
            "description": "仅引用已存在采集坐标；缺来源结构化失败。省略正文不清空，显式提供的不可变字段仍须相同；不得补序号。legacy无collectionEvidence且rawResponse省略/null仅为原引用哨兵，不等于正文字符串null。"
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
      "description": "公布文件历史命令；未知附加字段保留，遗漏/null/归一化及逐项错误由现有领域校验处理；publishedRow 使用正式事实严格 DTO，须先预检并带回 officialEvidencePlanHash"
    },
    "officialEvidenceAppends": {
      "description": "精确正式佐证追加；expectedVersion=当前event.revision，显式声明与publishedRow；须先preflight并在payload带回officialEvidencePlanHash",
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
      "description": "复用精确更正DTO；导入采用外层幂等键，每项明确publishedRow和expectedRowRevision，与追加/capture共用最终计划",
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
              "coordinate"
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
      "additionalProperties": false
    },
    "officialEvidencePlanHash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    }
  },
  "additionalProperties": true
},
            },
          },
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
