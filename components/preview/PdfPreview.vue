<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { FileText } from '@lucide/vue'
import PreviewToolbar from '@/components/preview/PreviewToolbar.vue'
import PreviewStates from '@/components/preview/PreviewStates.vue'
import { PDFViewer } from '@embedpdf/vue-pdf-viewer'
import { resolvePreviewKind } from '~~/lib/preview'

/**
 * PDF 预览。用 EmbedPDF 的 `PDFViewer` —— 它自带完整界面(工具栏、缩略图、
 * 搜索、批注),这里做的是**把它收进我们这一套**:
 *
 *  - 主题:把项目的 CSS 变量读出来,映射到 EmbedPDF 的语义色 token 上,
 *    并跟着深浅主题切换重建。这样它不会在藏青界面上糊一块灰色控件。
 *  - 语言:默认 en,显式设成 zh-CN。
 *  - 权限:这是个查阅工具,只读。批注、印章、签名、密文全部关掉,
 *    避免用户以为改动会保存回原文件。
 *
 * EmbedPDF 自带工具栏,所以这个预览器**不叠加**自己的工具栏 —— 叠一层会
 * 出现两个工具栏、两套缩放按钮。导航与缩放交给它自己的控件。
 *
 * 主题用 `:key` 绑在 colorMode 上:`PDFViewer` 只在 onMounted 里 init 一次,
 * 换 config 不会重建,所以用户切深浅主题时得让它整个重新挂载,否则 PDF 会
 * 停在旧主题里 —— 而这个看板是有明暗切换的。
 */
const props = withDefaults(
  defineProps<{
    src: string
    name?: string
  }>(),
  { name: '' },
)

const info = computed(() => resolvePreviewKind(props.src))
const title = computed(() => props.name || props.src.split('/').pop() || props.src)

const colorMode = useColorMode({ selector: 'html' })
const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')

/**
 * 把当前主题的 CSS 变量读成 EmbedPDF 的 token。
 *
 * 必须在主题生效之后读,而且变量是 oklch 字面量 —— 直接交给它没问题,
 * 现代浏览器都认;不认的时候它会退回自己的默认色,不会崩。
 */
function cssVar(name: string): string {
  if (typeof window === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const themeOverrides = computed(() => {
  // 依赖 colorMode,主题一换就重算,PDFViewer 收到新 config 会重建。
  void colorMode.value
  return {
    background: {
      app: cssVar('--background'),
      surface: cssVar('--card'),
      surfaceAlt: cssVar('--muted'),
      elevated: cssVar('--popover'),
      input: cssVar('--card'),
    },
    foreground: {
      primary: cssVar('--foreground'),
      secondary: cssVar('--muted-foreground'),
      muted: cssVar('--muted-foreground'),
      onAccent: cssVar('--primary-foreground'),
    },
    border: {
      default: cssVar('--border'),
      subtle: cssVar('--border'),
      strong: cssVar('--input'),
    },
    accent: {
      primary: cssVar('--primary'),
      primaryForeground: cssVar('--primary-foreground'),
      primaryLight: cssVar('--accent'),
    },
    interactive: {
      hover: cssVar('--accent'),
      active: cssVar('--accent'),
      selected: cssVar('--accent'),
      focus: cssVar('--ring'),
      focusRing: cssVar('--ring'),
    },
    state: {
      error: cssVar('--destructive'),
      warning: cssVar('--mark-national'),
    },
    scrollbar: {
      track: 'transparent',
      thumb: cssVar('--border'),
    },
  }
})

/**
 * pdfium 引擎的 wasm 地址。
 *
 * **两点都不能省,都是实测踩出来的**
 *
 * 1. **必须自托管**。库的默认值是
 *    `https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.15.1/dist/pdfium.wasm` ——
 *    不指定它,每台打开的机器都要去公网 CDN 拉一个 4.6 MB 的 wasm。
 *    这是个政务内网工具,不该在运行时依赖公网。文件在 `public/pdfium.wasm`。
 *
 * 2. **必须是绝对地址**。写相对路径 `/pdfium.wasm` 会让查看器**永久卡在
 *    「Initializing plugins…」**:引擎在 blob URL 的 worker 里取 wasm,
 *    worker 的 origin 是不透明的,相对路径解析不到。实测改成绝对地址才通过。
 *
 * 验证方式(想确认真的没走 CDN):把 `public/pdfium.wasm` 改名,预览会立刻失败;
 * 改回来就正常 —— 说明用的是本地这份,没有回落到 CDN。
 */
function wasmUrl(): string {
  const path = '/pdfium.wasm'
  return typeof window === 'undefined' ? path : new URL(path, window.location.origin).href
}

const config = computed(() => ({
  src: props.src,
  wasmUrl: wasmUrl(),
  // 跟随项目主题,而不是跟随系统 —— 用户在页面里切了主题,这里也要跟着。
  theme: {
    preference: (colorMode.value === 'dark' ? 'dark' : 'light') as 'light' | 'dark',
    light: themeOverrides.value,
    dark: themeOverrides.value,
  },
  i18n: { defaultLocale: 'zh-CN' as const },
  /**
   * 只读查阅:关掉一切暗示「可以改这份文件」的东西。
   *
   * `annotation` / `redaction` 是批注与密文;`insert` / `form` / `signature` /
   * `stamp` 是工具栏上的「插入 / 表单」两个模式页 —— 它们会让用户以为能往
   * 这份公布文件里填东西,而这个看板是只读台账,改动也存不回去。
   * 类别名取自库内默认 schema(未导出,只能按名屏蔽)。
   */
  disabledCategories: [
    'annotation',
    'redaction',
    'insert',
    'form',
    'signature',
    'stamp',
  ] as string[],
  tabBar: 'never' as const,
  // 字体回退默认走 CDN;关掉,避免内网环境挂在不必要的跨域请求上。
  fontFallback: null,
}))

function onReady() {
  status.value = 'ready'
}
function onError() {
  status.value = 'error'
  errorMessage.value = 'PDF 引擎没能加载这个文件,可能已损坏或路径失效。'
}

const fullscreen = ref(false)
const shell = ref<HTMLElement | null>(null)
function toggleFullscreen() {
  if (!shell.value) return
  if (document.fullscreenElement) void document.exitFullscreen()
  else void shell.value.requestFullscreen?.()
}
function onFullscreenChange() {
  fullscreen.value = !!document.fullscreenElement
}
if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  onBeforeUnmount(() => document.removeEventListener('fullscreenchange', onFullscreenChange))
}
</script>

<template>
  <!--
    两行头部的取舍:EmbedPDF 自带工具栏,而它没有文件名、下载、全屏,
    所以上面这一条补的是它缺的那几样,不是重复它的缩放与翻页。

    合并成一条需要替换它的整套 UI schema,而 `viewerUISchema` 没有导出
    (只导出了类型),只能从零写一份完整 schema;或者放弃它的界面走 headless。
    两条路都比「预览组件」这件事本身重,所以这里让它读上去是一个两行头部:
    背景同色、中间不画分隔线、行高收窄(见 .preview-pdf-header)。
  -->
  <div ref="shell" data-preview-shell class="preview-pdf-header bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
    <!--
      EmbedPDF 自带完整工具栏,这里只补两件它没有的:文件名,以及下载。
      自己的工具栏上不再放缩放/翻页,免得和它的控件打架。
    -->
    <PreviewToolbar
      :title="title"
      :kind-label="info?.label ?? 'PDF 文档'"
      :icon="FileText"
      :unit="null"
      :href="src"
      :fullscreen="fullscreen"
      :actions-disabled="status === 'error'"
      @toggle-fullscreen="toggleFullscreen"
    />
    <div class="relative min-h-0 flex-1" :class="status === 'ready' ? 'preview-ready' : ''">
      <PreviewStates
        v-if="status === 'error'"
        class="absolute inset-0 z-10"
        status="error"
        :message="errorMessage"
      />
      <PDFViewer
        :key="colorMode"
        class="h-full w-full"
        :config="config"
        @ready="onReady"
        @error="onError"
      />
    </div>
  </div>
</template>
