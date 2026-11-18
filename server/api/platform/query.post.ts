import { runPlatformLiveQuery } from '../../utils/platform-live-query'
import { requestLogContext } from '../../../layers/core/lib/logging'

defineRouteMeta({
  openAPI: {
    tags: ['平台实时查询'], summary: '实时查询平台申报/关联/已认定企业记录（只读）',
    description: '独立于本库企业。businessList只接受uscc及必填字符串rdjb=1/2/3/all，all要求startPage=1。queryList/queryBusList的name 为平台名称关键词，uscc 为18位代码；同时提供按 AND 生效。无默认日期/区域限制。凭据仅由服务端解析，未知参数拒绝。queryBusList支持单/全三称号、认定日期范围、有效年份、维护年份及依赖年份的批次、账号区域码和qymc排序；仅明确提供时生效。只读沿用无 token 策略。完整契约及示例',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false, required: ['source'], oneOf: [
        { type: 'object', properties: { source: { type: 'string', enum: ['queryList'] }, rdjb: { type: 'null' }, sqsj: { type: 'null' }, rddqrq: { type: 'null' }, whpcyear: { type: 'null' }, whpc: { type: 'null' }, szq: { type: 'null' }, orderField: { type: 'null' }, orderDirection: { type: 'null' } }, anyOf: [{ type: 'object', required: ['name'] }, { type: 'object', required: ['uscc'] }] },
        { type: 'object', properties: { source: { type: 'string', enum: ['businessList'] }, name: { type: 'null' }, sqsj: { type: 'null' }, rddqrq: { type: 'null' }, whpcyear: { type: 'null' }, whpc: { type: 'null' }, szq: { type: 'null' }, orderField: { type: 'null' }, orderDirection: { type: 'null' } }, required: ['uscc', 'rdjb'], oneOf: [
          { type: 'object', properties: { rdjb: { type: 'string', enum: ['1', '2', '3'] } } },
          { type: 'object', properties: { rdjb: { type: 'string', enum: ['all'] }, startPage: { type: 'integer', enum: [1] } } },
        ] },
        { type: 'object', properties: { source: { type: 'string', enum: ['queryBusList'] }, rdjb: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['1', '2', '3'] } } }, anyOf: [{ type: 'object', required: ['name'] }, { type: 'object', required: ['uscc'] }] },
      ], properties: {
        source: { type: 'string', enum: ['queryList', 'businessList', 'queryBusList'], description: '三种来源均可用，各来源输入限制不同，见oneOf与capabilities。' },
        rawDataVersion: { type: 'integer', enum: [1], description: '显式保真扩展：返回rawData.version=1的typed原行及成功页完整原文；rows继续为旧字符串投影。原文敏感或超预算则整页拒收。' },
        name: { type: 'string', description: '非空，最多200字符' }, uscc: { type: 'string', description: '18位大写字母/数字信用代码' },
        rdjb: { type: ['string', 'array'], oneOf: [{ type: 'string', enum: ['1', '2', '3', 'all'] }, { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['1', '2', '3'] } }], description: 'businessList必须提供字符串1/2/3/all；queryBusList为不重复非空数组，缺省全三称号；queryList禁止。1创新型/2专精特新中小企业/3小巨人。' },
        sqsj: { type: 'string', description: '仅queryBusList；认定时间范围 YYYY/MM/DD - YYYY/MM/DD；真实日期且起始不晚于结束，边界是否包含及平台时区未验证。' },
        rddqrq: { type: 'string', description: '仅queryBusList；有效年份，不是精确到期日期。' },
        whpcyear: { type: 'string', description: '仅queryBusList；维护年份，不等于认定年份。' },
        whpc: { type: 'string', description: '仅queryBusList；维护批次1–15；必须同时提供whpcyear，否则拒绝。不是YYYY-N。' },
        szq: { type: 'string', description: '仅queryBusList；账号可见范围的8位筛选码，与结果行szq不同，不提供通用字典。' },
        orderField: { type: 'string', enum: ['qymc'], description: '仅queryBusList；须同时提供orderDirection，只有企业名称排序已实证。' },
        orderDirection: { type: 'string', enum: ['asc', 'desc'], description: '仅queryBusList；须同时提供orderField。' },
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
    "rawData": { "type": "object", "required": ["version", "rows", "pages"], "properties": {
      "version": { "type": "integer", "enum": [1] },
      "rows": { "type": "array", "items": { "type": "object", "additionalProperties": {} } },
      "pages": { "type": "array", "items": { "type": "object", "required": ["source", "rdjb", "page", "format", "body"], "properties": {
        "source": { "type": "string", "enum": ["queryList", "businessList", "queryBusList"] }, "rdjb": { "type": "string", "nullable": true }, "page": { "type": "integer" },
        "format": { "type": "string", "enum": ["json", "html-script", "html-table"] }, "body": { "type": "string" }
      } } }
    } },
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
        "sqsj": { "type": "string" },
        "rddqrq": { "type": "string" },
        "whpcyear": { "type": "string" },
        "whpc": { "type": "string" },
        "szq": { "type": "string" },
        "orderField": { "type": "string" },
        "orderDirection": { "type": "string" },
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
          "maxPage": { "type": "integer", "nullable": true, "minimum": 1 },
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
  try { return await runPlatformLiveQuery(await readBody(event), { logContext: event.context ? requestLogContext(event) : undefined }) }
  catch (caught) {
    const e = caught as { statusCode?: number; code?: string }
    setResponseStatus(event, e.statusCode === 400 ? 400 : 500)
    return { error: { code: e.statusCode === 400 ? e.code : 'internal_error', message: 'Platform query request rejected' } }
  }
})
