import { importReceiptRoute } from '../../../../utils/import-receipts-route'

defineRouteMeta({
  "openAPI": {
    "tags": ["导入回执"],
    "summary": "分页读取导入逐项结果",
    "description": "batchId、idempotencyKey 或历史 receiptId 三选一。稳定按原项序号分页；pageSize 最大 50。只返回索引、ok、kind、ref 和错误码/字段，不含大 detail、错误原文或请求。需 API token。 显式 projection=snapshot|eventIds 选择一个归并旧容器快照或事件ID页。source=private_batch+batchId 或 redacted_receipt+receiptId二选一，itemIndex/oldRecordId必需，不允许idempotencyKey/page/latest receipt。snapshot不嵌套eventIds，后者cursor绑定完整selector。receipt缺快照not_retained，不回退batch；原item列表不变。独立 projection=qualification 读取成功 announcement record_event 的原 after capture 与原候选 diagnostics；source/ID仍精确互斥，itemIndex必需，不要求且拒收oldRecordId，也拒收idempotencyKey/page/pageSize/cursor。qualification的maxBytes默认65536，旧分支默认16384；均可传1..65536整数。两个历史槽不从当前T2/事件/可变preflight补造。diagnostics明确captured/items、not_retained/legacy_receipt或unavailable/read_unavailable；脱敏改变一个槽时不影响另一安全槽。整个公开封套超过maxBytes返回413 response_limit/requiredBytes，无partial。",
    "security": [{"bearerAuth": []}],
    "parameters": [
      {"name": "batchId", "in": "query", "schema": {"type": "integer", "minimum": 1}},
      {"name": "idempotencyKey", "in": "query", "schema": {"type": "string"}},
      {"name": "receiptId", "in": "query", "schema": {"type": "integer", "minimum": 1}},
      {"name": "page", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 1000000, "default": 1}},
      {"name": "pageSize", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}},
      {"name": "projection", "in": "query", "required": false, "schema": {"enum": ["snapshot", "eventIds", "qualification"], "type": "string"}},
      {"name": "source", "in": "query", "required": false, "schema": {"enum": ["private_batch", "redacted_receipt"], "type": "string"}},
      {"name": "itemIndex", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 0, "maximum": 9007199254740990}},
      {"name": "oldRecordId", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}},
      {
        "name": "cursor",
        "in": "query",
        "required": false,
        "schema": {"type": "string", "description": "Maximum 512 JavaScript UTF-16 code units; values are not trimmed."},
        "description": "eventIds only; immutable source/id/item/oldRecord/index binding"
      },
      {"name": "maxBytes", "in": "query", "required": false, "description": "UTF8完整公开封套上限；schema的16384默认值属于旧snapshot/eventIds分支，qualification省略本参数时默认65536。", "schema": {"type": "integer", "minimum": 1, "maximum": 65536, "default": 16384}}
    ],
    "responses": {
      "200": {
        "description": "原列表或显式快照/eventIds页；Cache-Control:no-store。snapshot固定id/enterpriseId/titleCode/source/nameRaw/usccRaw/district/qualityFlags，原origin另列；eventIds最多50与nextCursor。source/storedRedacted/responseRedacted/availability逐项明确。qualification为另一个独立oneOf分支，完整历史assessment与候选diagnostics各自有availability，不以当前值补旧历史。",
        "content": {
          "application/json": {
            "schema": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "batchId": {"type": "integer", "minimum": 1},
                    "receiptId": {"type": ["integer", "null"]},
                    "status": {"type": "string"},
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
                          "errorCode": {"type": ["string", "null"]},
                          "errorField": {"type": ["string", "null"]}
                        }
                      }
                    }
                  },
                  "required": ["batchId", "receiptId", "status", "page", "pageSize", "total", "rows"],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "description": "Retained exact snapshot; no embedded event IDs",
                  "additionalProperties": false,
                  "required": ["formatVersion", "source", "batchId", "receiptId", "itemIndex", "oldRecordId", "storedRedacted", "responseRedacted", "availability", "snapshot", "origin"],
                  "properties": {
                    "formatVersion": {"type": "integer", "enum": [1]},
                    "source": {"enum": ["private_batch", "redacted_receipt"], "type": "string"},
                    "batchId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                    "receiptId": {"type": ["integer", "null"], "minimum": 1, "maximum": 9007199254740991},
                    "itemIndex": {"type": "integer", "minimum": 0},
                    "oldRecordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                    "storedRedacted": {"type": "boolean"},
                    "responseRedacted": {"type": "boolean", "enum": [true]},
                    "availability": {"type": "string", "enum": ["available"]},
                    "snapshot": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "id": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "enterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "titleCode": {"type": "string", "description": "Maximum 4000 JavaScript UTF-16 code units; values are not trimmed."},
                        "source": {"type": "string", "description": "Maximum 4000 JavaScript UTF-16 code units; values are not trimmed."},
                        "nameRaw": {"type": ["string", "null"], "description": "Maximum 4000 JavaScript UTF-16 code units; values are not trimmed."},
                        "usccRaw": {"type": ["string", "null"], "description": "Maximum 4000 JavaScript UTF-16 code units; values are not trimmed."},
                        "district": {"type": ["string", "null"], "description": "Maximum 4000 JavaScript UTF-16 code units; values are not trimmed."},
                        "qualityFlags": {"type": ["array", "null"], "items": {"type": "string", "description": "Maximum 4000 JavaScript UTF-16 code units; values are not trimmed."}}
                      },
                      "required": ["id", "enterpriseId", "titleCode", "source", "nameRaw", "usccRaw", "district", "qualityFlags"]
                    },
                    "origin": {
                      "type": "object",
                      "properties": {
                        "fromEnterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "intoEnterpriseId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                        "intoRecordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}
                      },
                      "required": ["fromEnterpriseId", "intoEnterpriseId", "intoRecordId"]
                    }
                  }
                },
                {
                  "type": "object",
                  "description": "Exact selected source did not retain this projection",
                  "additionalProperties": false,
                  "required": ["formatVersion", "source", "batchId", "receiptId", "itemIndex", "oldRecordId", "storedRedacted", "responseRedacted", "availability"],
                  "properties": {
                    "formatVersion": {"type": "integer", "enum": [1]},
                    "source": {"enum": ["private_batch", "redacted_receipt"], "type": "string"},
                    "batchId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                    "receiptId": {"type": ["integer", "null"], "minimum": 1, "maximum": 9007199254740991},
                    "itemIndex": {"type": "integer", "minimum": 0},
                    "oldRecordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                    "storedRedacted": {"type": "boolean"},
                    "responseRedacted": {"type": "boolean", "enum": [true]},
                    "availability": {"type": "string", "enum": ["not_retained"]}
                  }
                },
                {
                  "type": "object",
                  "description": "Independent bounded event ID page; no snapshot",
                  "additionalProperties": false,
                  "required": ["formatVersion", "source", "batchId", "receiptId", "itemIndex", "oldRecordId", "storedRedacted", "responseRedacted", "availability", "eventIds", "nextCursor"],
                  "properties": {
                    "formatVersion": {"type": "integer", "enum": [1]},
                    "source": {"enum": ["private_batch", "redacted_receipt"], "type": "string"},
                    "batchId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                    "receiptId": {"type": ["integer", "null"], "minimum": 1, "maximum": 9007199254740991},
                    "itemIndex": {"type": "integer", "minimum": 0},
                    "oldRecordId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                    "storedRedacted": {"type": "boolean"},
                    "responseRedacted": {"type": "boolean", "enum": [true]},
                    "availability": {"type": "string", "enum": ["available"]},
                    "eventIds": {"type": "array", "maxItems": 50, "items": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}},
                    "nextCursor": {"type": ["string", "null"], "description": "Maximum 512 JavaScript UTF-16 code units; values are not trimmed."}
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "description": "qualification专用精确历史封套。完整保存的三称号snapshot与原候选诊断分别验证身份/完整性及当前脱敏；不重算资格或补造旧诊断。独立payload有界载入，最终封套统一预算。",
                  "required": ["source", "batchId", "receiptId", "itemIndex", "target", "qualificationReadback", "qualificationDiagnostics"],
                  "properties": {
                    "source": {"type": "string", "enum": ["private_batch", "redacted_receipt"]},
                    "batchId": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
                    "receiptId": {"type": ["integer", "null"], "minimum": 1, "maximum": 9007199254740991},
                    "itemIndex": {"type": "integer", "minimum": 0, "maximum": 9007199254740990},
                    "target": {"type": ["object", "null"], "additionalProperties": false, "required": ["enterpriseId"], "properties": {"enterpriseId": {"type": "integer", "minimum": 1}}},
                    "qualificationReadback": {
                      "type": "object",
                      "oneOf": [
                        {
                          "type": "object", "additionalProperties": false, "required": ["stage", "status", "target", "assessment"],
                          "properties": {
                            "stage": {"type": "string", "enum": ["after"]}, "status": {"type": "string", "enum": ["captured"]},
                            "target": {"type": "object", "additionalProperties": false, "required": ["enterpriseId"], "properties": {"enterpriseId": {"type": "integer", "minimum": 1}}},
                            "assessment": {
                              "type": "object", "additionalProperties": false,
                              "description": "原始完整CurrentQualificationSnapshot；原enterprise/asOf/ruleVersion/assessmentVersion/snapshotId不变；snapshotId可由[scope,titles]独立SHA256验证。",
                              "required": ["enterpriseId", "asOf", "ruleVersion", "assessmentVersion", "snapshotId", "titles"],
                              "properties": {
                                "enterpriseId": {"type": "integer", "minimum": 1}, "asOf": {"type": "string", "format": "date-time"},
                                "ruleVersion": {"type": "string", "description": "Non-empty original rule version; minimum length 1."}, "assessmentVersion": {"type": "string", "description": "Non-empty original assessment version; minimum length 1."}, "snapshotId": {"type": "string", "description": "Exactly 64 lowercase hexadecimal characters; pattern ^[a-f0-9]{64}$."},
                                "titles": {"type": "array", "minItems": 3, "maxItems": 3, "description": "innovative_sme/specialized_sme/little_giant各一份完整称号assessment，不裁切维度。", "items": {
                                  "type": "object", "required": ["titleCode", "group", "cycles", "versions", "officialQualification", "subject", "region", "platform", "correspondence", "completeness", "evidence", "sourceVersions", "references", "notes", "shadow"],
                                  "properties": {
                                    "titleCode": {"type": "string", "enum": ["innovative_sme", "specialized_sme", "little_giant"]}, "group": {"type": "string", "enum": ["eligible", "pending", "excluded"]},
                                    "cycles": {"type": "array", "items": {"type": "object"}}, "versions": {"type": "object", "required": ["facts", "sources", "decisions", "observations"], "additionalProperties": {"type": "string", "description": "Exactly 64 lowercase hexadecimal characters; pattern ^[a-f0-9]{64}$."}},
                                    "officialQualification": {"type": "object"}, "subject": {"type": "object"}, "region": {"type": "object"}, "platform": {"type": "object"}, "correspondence": {"type": "object"}, "completeness": {"type": "object"}, "shadow": {"type": "object"},
                                    "evidence": {"type": "array", "items": {"type": "object"}}, "sourceVersions": {"type": "array", "items": {"type": "object"}}, "references": {"type": "array", "items": {"type": "string"}}, "notes": {"type": "array", "items": {"type": "string"}}
                                  }
                                }}
                              }
                            }
                          }
                        },
                        {
                          "type": "object", "additionalProperties": false, "required": ["stage", "status", "target", "reason"],
                          "properties": {
                            "stage": {"type": "string", "enum": ["after"]}, "status": {"type": "string", "enum": ["not_retained"]}, "target": {"type": "null"},
                            "reason": {"type": "string", "enum": ["legacy_receipt", "multiple_targets", "no_targets", "scope_not_established"]}, "enterpriseIds": {"type": "array", "items": {"type": "integer", "minimum": 1}}
                          }
                        },
                        {
                          "type": "object", "additionalProperties": false, "required": ["stage", "status", "target", "reason"],
                          "description": "保存capture不合法/被脱敏改变时read_unavailable，不带assessment；原capture已超限时可保留response_limit及requiredBytes。",
                          "properties": {
                            "stage": {"type": "string", "enum": ["after"]}, "status": {"type": "string", "enum": ["unavailable"]},
                            "target": {"type": "object", "additionalProperties": false, "required": ["enterpriseId"], "properties": {"enterpriseId": {"type": "integer", "minimum": 1}}},
                            "reason": {"type": "string", "enum": ["read_unavailable", "response_limit"]}, "requiredBytes": {"type": "integer", "minimum": 1}
                          }
                        }
                      ]
                    },
                    "qualificationDiagnostics": {
                      "type": "object",
                      "oneOf": [
                        {
                          "type": "object", "additionalProperties": false, "required": ["status", "items"],
                          "properties": {"status": {"type": "string", "enum": ["captured"]}, "items": {"type": "array", "description": "选中成功项对应的原候选诊断；真实留存且无诊断时才可为空。", "items": {
                            "type": "object", "additionalProperties": false, "required": ["ref", "eventType", "values", "fieldGaps"],
                            "properties": {
                              "ref": {"type": "string", "description": "Maximum 64 JavaScript UTF-16 code units; pattern ^record:(0|[1-9][0-9]*)#(0|[1-9][0-9]*)$."}, "eventType": {"type": "string", "enum": ["award", "review", "nurture", "maintain"]},
                              "values": {"type": "object", "additionalProperties": false, "description": "原候选primitive值；null与blank字符串不合并/trim，省略由原fieldGaps.inputState=omitted独立表达；安全整数不用于重新判资格。", "required": ["year", "decidedYear", "batchSeq", "reviewOutcome"], "properties": {"year": {"type": ["integer", "string", "null"], "description": "Original string/null or safe integer from -9007199254740991 through 9007199254740991."}, "decidedYear": {"type": ["integer", "string", "null"], "description": "Original string/null or safe integer from -9007199254740991 through 9007199254740991."}, "batchSeq": {"type": ["integer", "string", "null"], "description": "Original string/null or safe integer from -9007199254740991 through 9007199254740991."}, "reviewOutcome": {"type": ["integer", "string", "null"], "description": "Original string/null or safe integer from -9007199254740991 through 9007199254740991."}}},
                              "fieldGaps": {"type": "array", "maxItems": 4, "items": {"type": "object", "additionalProperties": false, "required": ["field", "valueState", "inputState"], "properties": {"field": {"type": "string", "enum": ["year", "decidedYear", "batchSeq", "reviewOutcome"]}, "valueState": {"type": "string", "enum": ["unknown", "blank", "invalid"]}, "inputState": {"type": "string", "enum": ["omitted", "null", "provided"]}}}}
                            }
                          }}}
                        },
                        {"type": "object", "additionalProperties": false, "required": ["status", "reason"], "properties": {"status": {"type": "string", "enum": ["not_retained"]}, "reason": {"type": "string", "enum": ["legacy_receipt"]}}},
                        {"type": "object", "additionalProperties": false, "required": ["status", "reason"], "properties": {"status": {"type": "string", "enum": ["unavailable"]}, "reason": {"type": "string", "enum": ["read_unavailable"]}}}
                      ]
                    }
                  }
                }
              ],
              "type": "object"
            }
          }
        }
      },
      "400": {"description": "invalid_query：选择器、分页或字节偏移不合法"},
      "401": {"description": "unauthorized：API token 缺失、不匹配或未配置"},
      "404": {"description": "missing 精确source不存在（旧列表保持not_found）；qualification未知精确source或item为not_found"},
      "409": {"description": "selector_mismatch / ambiguity；不取第一项"},
      "413": {"description": "field_limit / response_limit；仅小错误与requiredBytes，不截原文。qualification最终封套含两个slot及全部metadata，超maxBytes返回response_limit与完整requiredBytes，无partial"}
    }
  }
})

export default importReceiptRoute('items')
