<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, Images, Loader2 } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge, type BadgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import ImagePreview from '@/components/preview/ImagePreview.vue'
import { DEFAULT_DPI } from '~~/lib/pdf-page'
import {
  DPI_PRESETS,
  pageImageSrc,
  pageLabel,
  galleryStatus,
  loadPageGalleryState,
  renderSummary,
  type GalleryTone,
} from '~~/lib/page-gallery'
import { describeFetchError } from '~~/lib/upload-register'
import type { PageImageRef, PdfPagesState, RenderOutcome } from '~~/server/utils/pdf-pages'

/**
 * 页图库(票 13 的后端 + 本轮的页面)。一份 PDF 的逐页 PNG:看现状、点一下渲染、逐页看。
 *
 * 三件事,分别对应票的验收:
 *
 *  1. **已有页图直接可看** —— 打开就先取现状,磁盘上有就立刻铺成缩略图网格(不用先点渲染);
 *  2. **没渲染时给明确的操作** —— 空态说清「这是什么、做什么用」,渲染按钮始终在工具栏右端
 *     (不随状态换位置:换位置会让人每次都要重新找);
 *  3. **加载 / 失败都要有反馈** —— 读现状用骨架网格、渲染中给一条状态条、渲染失败用 Alert 照实报。
 *
 * 状态怎么判、按钮叫什么,全在 `lib/page-gallery.ts`(纯函数,有单测);这里只管画。
 *
 * 页图**不属于预览器的分派**:`FilePreview` 按扩展名分派到 docx/xlsx/pptx/pdf/图片,
 * 而页图是 PDF 的**派生物**(`<文件名>.pdf.pages/pNNN.png`),不是文件库里的另一份文件。
 * 所以它单独成件,由 PDF 那个弹窗按视图切换调用(见 `components/files/PdfViewDialog.vue`)。
 */
const props = defineProps<{
  /** 源 PDF,相对文件库根的路径(与 `record_evidence.source_file` 同一口径)。 */
  file: string
}>()

/**
 * 网格列数:按容器宽度自动铺。`minmax(120px, 1fr)` —— 120px 是「一页 A4 缩到
 * 认得出版式」的下限(再窄就只剩一团灰),`1fr` 让宽屏尽量铺满。
 * 骨架与真图共用这一份:分开写迟早会不一样,骨架切到真图时就会跳一下。
 */
const GRID_COLS = 'grid-cols-[repeat(auto-fill,minmax(120px,1fr))]'

/** 现状。null = 还没取到(初次加载或读失败)。 */
const state = ref<PdfPagesState | null>(null)
/** 取现状中。 */
const loading = ref(true)
/** 取现状失败。 */
const loadError = ref('')
/** 渲染中(POST 在飞)。 */
const rendering = ref(false)
/** 渲染失败。 */
const renderError = ref('')
/** 上一次渲染的一句话交代(写了几页、跳了几页、多久)。 */
const summary = ref('')
/** 当前选的分辨率。取到现状后跟磁盘上的一致 —— 打开就该显示「现在是什么」,不是「默认是什么」。 */
const dpi = ref<number>(DEFAULT_DPI)
/** 用户是否手动调过分辨率。调过之后刷新不再覆盖他的选择。 */
const dpiTouched = ref(false)
/** 正在看的那一页;null = 网格。 */
const viewing = ref<number | null>(null)

const status = computed(() => (state.value ? galleryStatus(state.value, dpi.value) : null))

/**
 * 状态词 → 徽章样式,照仓库既有的语义:虚线 = 还没坐实(待办),次级实线 = 要留意但不是错,
 * 实线加粗 = 已成立。颜色在这一套里已被称号梯度占用,状态一律靠线型分。
 */
const TONE_BADGE: Record<GalleryTone, BadgeVariants['variant']> = {
  empty: 'dashed',
  partial: 'dashed',
  stale: 'quiet',
  ready: 'solid',
}

/** 正在看的那一页的条目。渲染后页数变少时它会找不到 —— 那就退回网格(见下面 watch)。 */
const viewingPage = computed<PageImageRef | null>(
  () => state.value?.pages.find((p) => p.page === viewing.value) ?? null,
)

/** 网格里给 `<img>` 的地址(带渲染版本号,免得换了 DPI 还显示浏览器缓存里的旧图)。 */
function srcOf(page: PageImageRef): string {
  return state.value ? pageImageSrc(state.value, page) : page.url
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const next = await loadPageGalleryState(props.file, (query) =>
      $fetch<PdfPagesState>('/api/pdf-pages', { query }),
    )
    state.value = next
    if (!dpiTouched.value) dpi.value = next.dpi
  } catch (error) {
    loadError.value = describeFetchError(error, '读不到页图状态。')
  } finally {
    loading.value = false
  }
}

/**
 * 渲染。要不要 `force` 由状态决定(见 `galleryStatus`):「最新」时点的是「重新渲染」,
 * 那就是明确要求重做;其余情况都交给幂等判据去跳。
 */
async function renderPages() {
  if (!state.value || !status.value) return
  rendering.value = true
  renderError.value = ''
  summary.value = ''
  try {
    const out = await $fetch<RenderOutcome>('/api/pdf-pages', {
      method: 'POST',
      body: { file: props.file, dpi: dpi.value, force: status.value.force },
    })
    state.value = out
    dpi.value = out.dpi
    dpiTouched.value = false
    summary.value = renderSummary(out)
  } catch (error) {
    renderError.value = describeFetchError(error, '渲染失败,请重试。')
  } finally {
    rendering.value = false
  }
}

/**
 * 换分辨率。**只认预设里的值**(`Select` 的 model 可能是 null / 数字,清空时也会回调):
 * 放一个越界值进来,下一次点渲染就会被接口 400 挡回来,而界面上看不出为什么。
 */
function pickDpi(value: unknown) {
  const next = Number(value)
  if (!(DPI_PRESETS as readonly number[]).includes(next)) return
  dpi.value = next
  dpiTouched.value = true
}

/** 换文件 = 换一切:丢掉上一份的视图、错误与小结,重新取现状。 */
watch(
  () => props.file,
  () => {
    viewing.value = null
    summary.value = ''
    renderError.value = ''
    loadError.value = ''
    dpiTouched.value = false
    dpi.value = DEFAULT_DPI
    state.value = null
    void load()
  },
  { immediate: true },
)

/** 重渲染之后页图可能变少,正在看的那页就没了 —— 别停在一个空视图上。 */
watch(
  () => state.value?.pages.length,
  () => {
    if (viewing.value !== null && !viewingPage.value) viewing.value = null
  },
)
</script>

<template>
  <div class="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
    <!-- 单页视图的头部:回网格 + 这是第几页。图片来源与缩放交给下面的 ImagePreview 工具栏,
         这里不重复放下载 / 适应(会变成两条工具栏干同一件事)。 -->
    <div
      v-if="viewingPage"
      class="flex min-h-10 shrink-0 items-center gap-2 border-b px-2 py-1"
    >
      <Button variant="ghost" size="sm" class="h-7 px-1.5 text-xs" @click="viewing = null">
        <ArrowLeft />
        返回全部页
      </Button>
      <span class="text-muted-foreground text-xs tabular-nums">
        {{ pageLabel(viewingPage.page) }} / 共 {{ state?.pageCount ?? state?.rendered }} 页
      </span>
    </div>

    <!-- 网格视图的工具栏:左=状态,右=动作。动作永远在同一个位置。 -->
    <div
      v-else-if="state && status"
      class="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5"
    >
      <Badge :variant="TONE_BADGE[status.tone]">{{ status.word }}</Badge>
      <!-- 未渲染时不在这里重复一遍:那件事空态里说更完整(有图标、有解释)。 -->
      <span v-if="status.tone !== 'empty'" class="min-w-0 text-[13px] leading-relaxed">
        {{ status.headline }}<span v-if="status.detail" class="text-muted-foreground">
          · {{ status.detail }}</span
        >
      </span>

      <span class="ml-auto flex shrink-0 items-center gap-2">
        <span class="text-muted-foreground text-xs">分辨率</span>
        <Select :model-value="String(dpi)" @update:model-value="pickDpi">
          <SelectTrigger class="bg-card h-8 w-28" aria-label="页图分辨率">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="preset in DPI_PRESETS" :key="preset" :value="String(preset)">
              {{ preset }} DPI
            </SelectItem>
          </SelectContent>
        </Select>
        <Button :disabled="rendering" @click="renderPages">
          <Loader2 v-if="rendering" class="animate-spin" />
          {{ rendering ? '渲染中…' : status.actionLabel }}
        </Button>
      </span>
    </div>

    <!-- 渲染中:细条而不是盖住网格 —— 重渲染时旧页图还看得见,不必闪一下就没了。 -->
    <div
      v-if="rendering && state?.rendered"
      class="bg-muted/50 text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs"
      role="status"
      aria-live="polite"
    >
      <Loader2 class="size-3.5 animate-spin" />
      正在渲染页图…<span v-if="state?.pageCount" class="tabular-nums"
        >共 {{ state.pageCount }} 页,大文件要几秒</span
      >
    </div>

    <!-- 失败 / 上一次的小结。放在工具栏下面、内容上面:两种视图下都看得见。 -->
    <div v-if="renderError || summary" class="flex shrink-0 flex-col gap-2 border-b px-3 py-2">
      <Alert v-if="renderError" variant="destructive">
        <!-- `!` 是必须的:`alertVariants` 的 destructive 给说明文字加了 90% 透明,
             深色下只剩 4.25:1(低于 4.5:1);那条规则同权重、位置更靠后,
             只有 important 压得过(与删除 / 上传弹窗同一处处理)。 -->
        <AlertDescription class="text-destructive! font-medium">{{ renderError }}</AlertDescription>
      </Alert>
      <p v-else class="text-muted-foreground text-[13px] leading-relaxed tabular-nums">
        {{ summary }}
      </p>
    </div>

    <!-- 单页:复用图片预览器(滚轮缩放、适应、旋转、下载都是打磨过的)。 -->
    <ImagePreview
      v-if="viewingPage"
      :src="srcOf(viewingPage)"
      :name="pageLabel(viewingPage.page)"
    />

    <!-- 取现状中:骨架网格。 -->
    <div v-else-if="loading" class="grid gap-3 overflow-hidden p-3" :class="GRID_COLS">
      <div v-for="i in 8" :key="i" class="flex flex-col gap-1.5">
        <Skeleton class="aspect-[210/297] w-full rounded-sm" />
        <Skeleton class="h-3 w-12" />
      </div>
    </div>

    <Empty v-else-if="loadError" class="flex-1 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Images /></EmptyMedia>
        <EmptyTitle>读不到页图状态</EmptyTitle>
        <EmptyDescription>{{ loadError }}</EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" size="sm" @click="load()">重试</Button>
    </Empty>

    <!-- 首次渲染中:还没有任何页图可铺,给一个明确在动的状态。 -->
    <div
      v-else-if="rendering"
      class="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8"
      role="status"
      aria-live="polite"
    >
      <Loader2 class="size-5 animate-spin" />
      <span class="text-[13px]">正在渲染页图…</span>
      <span v-if="state?.pageCount" class="text-xs tabular-nums">
        共 {{ state.pageCount }} 页,大文件要几秒
      </span>
    </div>

    <!-- 一张都没有:说清这是什么、做什么用。动作在工具栏右端,这里只解释。 -->
    <Empty v-else-if="!state?.rendered" class="flex-1 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Images /></EmptyMedia>
        <EmptyTitle>{{ status?.headline ?? '还没有页图' }}</EmptyTitle>
        <EmptyDescription>{{ status?.detail }}</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <div v-else class="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-auto p-3" :class="GRID_COLS">
      <button
        v-for="page in state.pages"
        :key="page.page"
        type="button"
        class="group hover:border-primary/40 hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 active:scale-[0.97] motion-reduce:active:scale-100 flex flex-col gap-1.5 rounded-md border bg-card p-1.5 text-left transition-[color,background-color,border-color,transform] duration-150 ease-snap focus-visible:outline-none motion-reduce:transition-none"
        :title="`${pageLabel(page.page)} · ${page.width}×${page.height}`"
        @click="viewing = page.page"
      >
        <!-- 缩略图按整页显示(contain):要认得出是「哪一页」,靠的是整页的版式,
             裁掉一半反而认不出。底色用 muted,白页在白底上也有个框。 -->
        <span class="bg-muted block aspect-[210/297] overflow-hidden rounded-sm border">
          <img
            :src="srcOf(page)"
            :alt="pageLabel(page.page)"
            loading="lazy"
            decoding="async"
            class="size-full object-contain"
          />
        </span>
        <span class="px-0.5 text-xs font-medium tabular-nums">{{ pageLabel(page.page) }}</span>
      </button>
    </div>
  </div>
</template>
