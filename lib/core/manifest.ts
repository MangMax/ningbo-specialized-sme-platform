import { FolderOpen, KeyRound, ListTodo, Logs, ScanText } from '@lucide/vue'
import { defineAppModule } from './module-registry'

export default defineAppModule({
  id: 'core',
  name: '平台底座',
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
  jobKinds: [
    { kind: 'ocr' },
    { kind: 'render-pages' },
  ],
  nav: [
    { title: '文件管理', url: '/files', icon: FolderOpen },
    { title: '识别校对', url: '/ocr', icon: ScanText },
    { title: '后台任务', url: '/tasks', icon: ListTodo },
    { title: '运行日志', url: '/logs', icon: Logs },
    { title: '密钥配置', url: '/settings', icon: KeyRound },
  ],
})
