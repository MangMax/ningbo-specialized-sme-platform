import { FolderOpen, KeyRound, ListTodo, Logs, ScanText } from '@lucide/vue'
import { defineAppModule } from './module-registry'

const ocr = { id: 'ocr', label: 'OCR' }

export default defineAppModule({
  id: 'core',
  name: '平台底座',
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
