import { FolderOpen, KeyRound, ListTodo, Logs, ScanText } from '@lucide/vue'
import { defineAppModule } from './module-registry'

const ocr = { id: 'ocr', label: 'OCR' }

export default defineAppModule({
  id: 'core',
  name: '平台底座',
  clientPages: [
    { page: 'workbench', paths: ['/'], operationPage: 'roster' },
    { page: 'files', paths: ['/files', '/preview'] },
    { page: 'ocr', paths: ['/ocr'] },
    { page: 'tasks', paths: ['/tasks'] },
    { page: 'logs', paths: ['/logs'] },
    { page: 'settings', paths: ['/settings'] },
  ],
  routes: [
    '/api/files',
    '/api/health',
    '/api/jobs',
    '/api/logs',
    '/api/ocr-results',
    '/api/pdf-pages',
    '/api/settings',
    '/api/task-center',
    '/api/uploads',
  ],
  mcpTools: [
    'clear_runtime_logs',
    'delete_ocr_result',
    'get_file',
    'get_file_maintenance',
    'get_file_physical_intent',
    'get_ocr_result',
    'get_runtime_log',
    'get_runtime_log_policy',
    'list_files',
    'list_page_images',
    'list_runtime_logs',
    'quarantine_file',
    'recover_file',
    'remove_file',
    'restore_file',
    'save_ocr_result',
    'set_runtime_log_policy',
    'update_file',
  ],
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
  jobKinds: [
    { kind: 'render-pages', label: 'PDF 转图', group: ocr, spec: 'renderPagesSpec' },
    { kind: 'ocr', label: 'OCR 识别', group: ocr, spec: 'ocrSpec' },
  ],
})
