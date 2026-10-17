import { createCredentialsHandler } from '../../../utils/credentials-route'
defineRouteMeta({ openAPI: { tags: ['Settings'], summary: '保存 OCR token；省略字段保持不变，空白拒绝', description: '需要现有 API 管理授权；未配置管理 token 时关闭。响应 Cache-Control: no-store。保存不代表验证可用，不触发 OCR。', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { ocrToken: { type: 'string', description: '非空，最多 65536 字符' } }, additionalProperties: false } } } }, responses: { 200: {
  "description": "OCR token 遮罩状态，不含原值",
  "content": {
    "application/json": {
      "schema": {
        "type": "object",
        "required": [
          "ocrToken"
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
          }
        }
      }
    }
  }
}, 400: { description: '输入无效' }, 401: { description: '未授权' }, 503: { description: '外置配置存储不可用' } } } })
export default createCredentialsHandler('state')
