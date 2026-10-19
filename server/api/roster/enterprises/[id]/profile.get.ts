import { enterpriseProfileRoute } from '../../../../utils/enterprise-profile-route'
defineRouteMeta({ openAPI: { tags: ['企业资料'], summary: '读取轻量企业资料及 PATCH 预期版本', description: '公开只读；只返回 enterpriseId/name/city/district 和不透明 version，不加载正式历史或平台原文。version 同时保护资料、统代和最近资料审计修订。', responses: { 200: { description: 'profile,version' }, 400: { description: '非法 ID' }, 404: { description: '企业不存在' } } } })
export default enterpriseProfileRoute('get')
