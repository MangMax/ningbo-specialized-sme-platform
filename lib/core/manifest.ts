import { FolderOpen, KeyRound, ListTodo, Logs, ScanText } from '@lucide/vue'
import { defineAppModule } from './module-registry'

export default defineAppModule({
  id: 'core',
  name: '平台底座',
  credentials: [{
    key: 'ocrToken',
    name: 'OCR token',
    description: '保存后供新任务使用，不会自动发起 OCR。优先级为显式覆盖、页面保存值、NUXT_OCR_TOKEN、PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN。',
    purpose: '在线 OCR',
    environment: ['NUXT_OCR_TOKEN', 'PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN'],
  }],
  nav: [
    { title: '文件管理', url: '/files', icon: FolderOpen },
    { title: '识别校对', url: '/ocr', icon: ScanText },
    { title: '后台任务', url: '/tasks', icon: ListTodo },
    { title: '运行日志', url: '/logs', icon: Logs },
    { title: '密钥配置', url: '/settings', icon: KeyRound },
  ],
})
