import { createCredentialsHandler } from '../../../utils/credentials-route'
defineRouteMeta({ openAPI: { tags: ['Settings'], summary: '读取配置状态，仅返回遮罩', description: '需要现有 API 管理授权；未配置管理 token 时关闭。响应 Cache-Control: no-store。保存不代表验证可用，不触发 OCR 或平台核查。', security: [{ bearerAuth: [] }],  responses: { 200: {
  "description": "OCR token 与平台 Cookie 遮罩状态，不含原值",
  "content": {
    "application/json": {
      "schema": {
        "type": "object",
        "required": [
          "ocrToken", "miitCookie"
        ],
        "properties": {
          "ocrToken": {
            "type": "object",
            "required": [
              "configured",
              "source",
              "masked",
              "updatedAt",
              "hasSaved"
            ],
            "properties": {
              "configured": {
                "type": "boolean"
              },
              "source": {
                "type": "string",
                "enum": [
                  "saved",
                  "NUXT_OCR_TOKEN",
                  "PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN",
                  "none"
                ]
              },
              "masked": {
                "type": "string"
              },
              "updatedAt": {
                "type": "string",
                "nullable": true
              },
              "hasSaved": {
                "type": "boolean"
              }
            }
          },
          "miitCookie": {
            "type": "object",
            "required": [
              "configured",
              "source",
              "masked",
              "updatedAt",
              "hasSaved"
            ],
            "properties": {
              "configured": {
                "type": "boolean"
              },
              "source": {
                "type": "string",
                "enum": [
                  "saved",
                  "MIIT_COOKIE",
                  "MIIT_COOKIE_FILE",
                  "none"
                ]
              },
              "masked": {
                "type": "string"
              },
              "updatedAt": {
                "type": "string",
                "nullable": true
              },
              "hasSaved": {
                "type": "boolean"
              }
            }
          }
        }
      }
    }
  }
}, 400: { description: '输入无效' }, 401: { description: '未授权' }, 503: { description: '外置配置存储不可用' } } } })
export default createCredentialsHandler('state')
