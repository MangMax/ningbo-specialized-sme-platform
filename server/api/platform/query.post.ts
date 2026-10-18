import { runPlatformLiveQuery } from '../../utils/platform-live-query'

defineRouteMeta({
  openAPI: {
    tags: ['平台实时查询'], summary: '实时查询平台申报/关联记录（只读）',
    description: '独立于本库企业。businessList仅接受uscc，必须显式rdjb=1/2/3/all（创新型/专精特新中小企业/小巨人/全三称号），拒绝name。all从第一页开始，补查使用unfinished中的单称号。queryList的name 为平台名称关键词，uscc 为18位代码；同时提供按 AND 生效。无默认日期/区域限制。凭据仅由服务端解析，未知参数拒绝。只读沿用无 token 策略。完整契约及示例见 docs/platform-live-query.md。',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false, required: ['source'],
      oneOf: [
        { type: 'object', properties: { source: { type: 'string', enum: ['queryList'] }, rdjb: { type: 'null', description: '此来源禁止该参数，与顶层string约束互斥' } }, anyOf: [{ type: 'object', required: ['name'] }, { type: 'object', required: ['uscc'] }] },
        { type: 'object', properties: { source: { type: 'string', enum: ['businessList'] }, name: { type: 'null', description: '此来源禁止该参数，与顶层string约束互斥' } }, required: ['uscc', 'rdjb'], oneOf: [
          { type: 'object', properties: { rdjb: { type: 'string', enum: ['1', '2', '3'] } } },
          { type: 'object', properties: { rdjb: { type: 'string', enum: ['all'] }, startPage: { type: 'integer', enum: [1] } } },
        ] },
      ], properties: {
        source: { type: 'string', enum: ['queryList', 'businessList', 'queryBusList'], description: 'queryList与businessList可用；queryBusList仍拒绝，见 capabilities。' },
        name: { type: 'string', description: '去首尾空白后非空，最多200字符' }, uscc: { type: 'string', description: '去首尾空白后的18位大写字母/数字信用代码' },
        rdjb: { type: 'string', enum: ['1', '2', '3', 'all'], description: 'businessList必填；1创新型、2专精特新中小企业、3小巨人、all全三称号。queryList不支持。all要求startPage=1。' },
        pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 50 }, startPage: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
        maxRequests: { type: 'integer', minimum: 1, maximum: 100, default: 100 }, maxRows: { type: 'integer', minimum: 1, maximum: 5000, default: 5000 }, maxDurationMs: { type: 'integer', minimum: 1, maximum: 60000, default: 60000 },
      },
    } } } },
    responses: { 200: { content: { 'application/json': { schema: {
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
  }
} } }, description: '统一结果：source/effectiveConditions/titleScope/queriedAt/completedAt/rows/pages/fetchedCount/declaredTotal（未知为null）/status/completeness/fullRange/unfinished/error/limits。status: success/no_record/auth_failed/failed/partial/not_queried。失败绝非零条。' }, 400: { description: 'invalid_input 或 unsupported_source；不回显输入。' } },
  },
})
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  try { return await runPlatformLiveQuery(await readBody(event)) }
  catch (caught) {
    const e = caught as { statusCode?: number; code?: string }
    setResponseStatus(event, e.statusCode === 400 ? 400 : 500)
    return { error: { code: e.statusCode === 400 ? e.code : 'internal_error', message: 'Platform query request rejected' } }
  }
})
