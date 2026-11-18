<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, Images, Loader2, ZoomIn, ZoomOut } from '@lucide/vue'
import { Alert, AlertDescription } from '#core/app/components/ui/alert'
import { Badge, type BadgeVariants } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#core/app/components/ui/select'
import { Skeleton } from '#core/app/components/ui/skeleton'
import ImagePreview from '@/components/preview/ImagePreview.vue'
import { DEFAULT_DPI } from '~~/lib/pdf-page'
import {
  DPI_PRESETS,
  PAGE_IMAGE_ZOOM_MIN,
  RENDER_FAILED_WORD,
  describeRenderFailure,
  pageImageSrc,
  pageLabel,
  galleryStatus,
  loadPageGalleryState,
  singlePageCountLabel,
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
  /**
   * **一进来就落在哪一页**(RL-10 的深链:出处页码 → 该 PDF 实际页)。1 起;
   * 不给 / 非正整数 ⇒ 停在网格,与从前一样。
   *
   * 落点是**单页视图**(`viewing`),不是自动滚到网格里的某一张 —— 深链的用途是
   * 「看这一页」,让人从一堆缩略图里自己找第 8 张不叫定位。该页还没渲染时,
   * 网格视图会照常铺出来并给出渲染入口(`viewing` 暂时回到 null;目标页号会保留,待渲染后恢复),
   * 不会停在一个空白的单页上。
   */
  page?: number | null
}>()
const emit = defineEmits<{
  'pages-state': [state: PdfPagesState]
  'page-change': [page: number]
}>()

/** 入参 `page` 折成「该看第几页」;不是 ≥1 的整数就没有落点(**不取整、不回落成第 1 页**)。 */
function requestedPage(): number | null {
  const p = props.page
  return typeof p === 'number' && Number.isInteger(p) && p >= 1 ? p : null
}

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
/** 取现状失败(第一次请求都没成,没有任何可显示的东西)。 */
const loadError = ref('')
/**
 * 按清单 DPI 的**二次核对**没成(F3):第一次响应里的清单仍然有效,只是 `upToDate`
 * 不可信。这种情况**不清空界面** —— 磁盘上明明有页图,不该因为一次核对失败就白屏。
 */
const loadUnconfirmed = ref(false)
/** 渲染中(POST 在飞)。 */
const rendering = ref(false)
/** 服务端给的渲染失败说明(没有就是空串 —— 见 describeRenderFailure 的注释)。 */
const renderFailure = ref('')
/** 渲染失败过。与 `renderFailure` 分开:网络失败时说明是空串,但状态仍然是「失败」。 */
const renderFailed = ref(false)
/** 深链不能可靠定位时单独报告,不能退回显示另一页。 */
const targetPageIssue = ref('')
/** 每份文件的每个深链目标只自动尝试渲染一次。 */
const autoRenderKey = ref('')
/** 上一次渲染的一句话交代(写了几页、跳了几页、多久)。 */
const summary = ref('')
/** 当前选的分辨率。取到现状后跟磁盘上的一致 —— 打开就该显示「现在是什么」,不是「默认是什么」。 */
const dpi = ref<number>(DEFAULT_DPI)
/** 用户是否手动调过分辨率。调过之后刷新不再覆盖他的选择。 */
const dpiTouched = ref(false)
/** 正在看的那一页;null = 网格。 */
const viewing = ref<number | null>(null)
/** 深链目标还没在页图中出现时暂存;渲染成功后用它恢复定位。 */
const pendingPage = ref<number | null>(null)
/**
 * 单页视图里那个 `ImagePreview` 的实例 —— 窄屏工具栏上那组缩放按钮靠它驱动
 * (`ImagePreview` 用 `defineExpose` 露出 `zoomBy` / `fit`)。用结构类型而不是
 * `InstanceType<typeof ImagePreview>`:模板 ref 只在这两处用到,写清需要什么就够。
 */
const viewer = ref<{
  zoomBy: (factor: number) => void
  fit: () => void
  zoom: number
  /** 子预览的**有效下限** —— 判「还能不能再缩小」用它,不要用本组件的配置下限。 */
  effectiveZoomMin: number
} | null>(null)

const status = computed(() =>
  state.value ? galleryStatus(state.value, dpi.value, { dpiUnconfirmed: loadUnconfirmed.value }) : null,
)

/**
 * 徽章上的词。**失败时覆盖状态词** —— 原来失败后仍挂着「未渲染」,而红条就在它下面,
 * 两个说法打架(「未渲染」听着像还没动手,实际是试过没成)。
 */
const badgeWord = computed(() =>
  renderFailed.value ? RENDER_FAILED_WORD : (status.value?.word ?? ''),
)

/**
 * 徽章样式。**失败是这一套里唯一靠颜色的**(红 = 出错了):其余状态一律靠**线型**分
 * (虚线 = 还没坐实、次级实线 = 要留意但不是错、实线 = 已成立)—— 颜色已被称号梯度占用。
 * 「已是最新」**不挂徽章**:它旁边就是分辨率下拉与按钮,一个孤零零的词读起来像控件标签,
 * 并进结论句里就只有一个意思了(独立审查 S2)。
 */
const badge = computed<{ word: string; variant: BadgeVariants['variant'] } | null>(() => {
  if (renderFailed.value) return { word: badgeWord.value, variant: 'destructive' }
  if (!status.value || status.value.tone === 'ready') return null
  return { word: badgeWord.value, variant: TONE_BADGE[status.value.tone] }
})

/** 失败说明:翻成可执行的中文,不把引擎的英文原句直接摆给用户。 */
const failureMessage = computed(() => describeRenderFailure(renderFailure.value))

/**
 * 主按钮:文案、权重、点了做什么。
 *
 * **渲染失败后一律是「重新渲染」+ 描边**(独立审查 R2):与「已是最新」那档同一个词
 * (都是「再跑一次」的意思),并且**不用实心** —— 原因指向无效 / 损坏 PDF 时,一颗
 * 高优先级实心按钮是在诱导一次注定无效的重试。
 */
const action = computed(() => {
  if (renderFailed.value) {
    return { label: '重新渲染', variant: 'outline' as const, run: renderPages }
  }
  const s = status.value
  if (!s) return null
  return {
    label: s.actionLabel,
    variant: s.variant,
    run: s.action === 'reload' ? load : renderPages,
  }
})

const viewingCountLabel = computed(() => {
  const current = state.value
  return current ? singlePageCountLabel(current.pageCount, current.rendered) : ''
})

/**
 * 状态词 → 徽章样式,照仓库既有的语义:虚线 = 还没坐实(待办),次级实线 = 要留意但不是错,
 * 实线加粗 = 已成立。颜色在这一套里已被称号梯度占用,所以**常态一律靠线型分**;
 * **唯一的例外是渲染失败**——那是「出错了」,只能靠红(`destructive`)才读得出来,
 * 见上面的 `badge` 计算属性。
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

// Selection is a gallery location, not confirmation of an original PDF render.
watch(viewingPage, page => { if (page) emit('page-change', page.page) })

async function resolveRequestedPage(): Promise<void> {
  const target = requestedPage()
  const current = state.value
  if (target === null || !current || loading.value) return

  targetPageIssue.value = ''
  const currentIsFresh = current.upToDate && !loadUnconfirmed.value
  if (currentIsFresh && current.pages.some((page) => page.page === target)) {
    pendingPage.value = null
    viewing.value = target
    return
  }
  // A stale manifest does not establish the current PDF page count. Let the render endpoint
  // inspect the source before deciding whether the target is out of range.
  if (currentIsFresh && current.pageCount === null) {
    pendingPage.value = null
    viewing.value = null
    targetPageIssue.value = `无法确认 PDF 页数，不能定位到第 ${target} 页。`
    return
  }
  if (currentIsFresh && current.pageCount !== null && target > current.pageCount) {
    targetPageIssue.value = `第 ${target} 页不存在。该 PDF 共 ${current.pageCount} 页，请检查来源页码。`
    pendingPage.value = null
    viewing.value = null
    return
  }

  pendingPage.value = target
  viewing.value = null
  const key = `${props.file}:${target}`
  if (autoRenderKey.value === key) return
  autoRenderKey.value = key
  await renderPages()
  if (!renderFailed.value && !state.value?.pages.some((page) => page.page === target)) {
    pendingPage.value = null
    targetPageIssue.value = `页图渲染完成，但结果中没有第 ${target} 页；未打开其他页面。`
  }
}

/** 网格里给 `<img>` 的地址(带渲染版本号,免得换了 DPI 还显示浏览器缓存里的旧图)。 */
function srcOf(page: PageImageRef): string {
  return state.value ? pageImageSrc(state.value, page) : page.url
}

async function load() {
  loading.value = true
  loadError.value = ''
  loadUnconfirmed.value = false
  try {
    const loaded = await loadPageGalleryState(props.file, (query) =>
      $fetch<PdfPagesState>('/api/pdf-pages', { query }),
    )
    // 二次核对失败也算拿到了结果(第一次的清单仍有效)—— 照常铺出来,只标记未核对。
    state.value = loaded.state
    emit('pages-state', loaded.state)
    loadUnconfirmed.value = !loaded.dpiConfirmed
    if (!dpiTouched.value) dpi.value = loaded.state.dpi
  } catch (error) {
    loadError.value = describeFetchError(error, '读不到页图状态。')
  } finally {
    loading.value = false
  }
  await resolveRequestedPage()
}

/**
 * 渲染。要不要 `force` 由状态决定(见 `galleryStatus`):「最新」时点的是「重新渲染」,
 * 那就是明确要求重做;其余情况都交给幂等判据去跳。
 */
async function renderPages() {
  if (!state.value || !status.value) return
  rendering.value = true
  renderFailure.value = ''
  renderFailed.value = false
  summary.value = ''
  try {
    const out = await $fetch<RenderOutcome>('/api/pdf-pages', {
      method: 'POST',
      body: { file: props.file, dpi: dpi.value, force: status.value.force },
    })
    state.value = out
    dpi.value = out.dpi
    dpiTouched.value = false
    loadUnconfirmed.value = false
    summary.value = renderSummary(out)
    emit('pages-state', out)
  } catch (error) {
    // 空串兜底,**不垫一句中文** —— describeRenderFailure 是唯一产出最终句子的一层,
    // 垫一句会被再包装一遍(独立审查 F1 报的重复标点就是这个)。
    renderFailure.value = describeFetchError(error, '')
    renderFailed.value = true
  } finally {
    rendering.value = false
  }
}

/**
 * 换分辨率。**只认预设里的值**(`Select` 的 model 可能是 null / 数字,清空时也会回调)。
 *
 * 这是**客户端自己的约束**,不是接口的限制:接口收 **72–600** 的任意整数(`lib/pdf-page.ts` 的
 * `MIN_DPI` / `MAX_DPI`)。挡在这一层,是因为下拉只列得出预设档 —— 放一个非预设值进来,
 * 用户改不回去。
 *
 * 这条只管**用户的选择**;磁盘上的清单 DPI 若本身不在预设里(如 120),由 `dpiOptions` 多列一条
 * **只读的当前值**兜住显示,见那里。
 */
function pickDpi(value: unknown) {
  const next = Number(value)
  if (!(DPI_PRESETS as readonly number[]).includes(next)) return
  dpi.value = next
  dpiTouched.value = true
}

/** 这个值是不是可选的预设档(非预设的那条只用来显示当前值,不可选)。 */
function isDpiPreset(value: number): boolean {
  return (DPI_PRESETS as readonly number[]).includes(value)
}

/**
 * 下拉里除了预设档,是否还要多列一条**当前值**。
 *
 * 磁盘上的清单 DPI 可以是 72–600 的**任意整数**(接口只做这个区间校验;老清单或手工写的
 * 清单都可能不是预设档)。这时 `dpi.value` 是那个值,而选项只有预设档 ——
 * `SelectValue` 在选项里找不到匹配项,触发器就**空着**,用户看不到「现在是多少」。
 * 补一条同值的选项给它兜住,但不许选它:`pickDpi` 只认预设,这条只是显示。
 *
 * **不把 `dpi.value` 悄悄改成默认值** —— 那会把「磁盘上真是 120」这个事实抹掉;
 * 界面该说的是「当前 120(不是预设),你可以改成预设档之一」。
 */
const hasOffPresetDpi = computed(() => !isDpiPreset(dpi.value))

const dpiOptions = computed<number[]>(() =>
  hasOffPresetDpi.value ? [dpi.value, ...DPI_PRESETS] : [...DPI_PRESETS],
)

/** 换文件 = 换一切:丢掉上一份的视图、错误与小结,重新取现状。 */
watch(
  () => props.file,
  () => {
    // 换文件 = 换一切,但**落点照旧按入参给**(深链打开时 `page` 就是它要的那一页)。
    pendingPage.value = requestedPage()
    viewing.value = pendingPage.value
    summary.value = ''
    renderFailure.value = ''
    renderFailed.value = false
    targetPageIssue.value = ''
    autoRenderKey.value = ''
    loadError.value = ''
    loadUnconfirmed.value = false
    dpiTouched.value = false
    dpi.value = DEFAULT_DPI
    state.value = null
    void load()
  },
  { immediate: true },
)

/** 清单变化后恢复尚未渲染的深链目标,或在当前页消失时退回网格。 */
watch(
  () => state.value?.pages,
  () => {
    const pending = pendingPage.value
    if (pending !== null && state.value?.pages.some((page) => page.page === pending)) {
      viewing.value = pending
      pendingPage.value = null
      return
    }
    if (viewing.value !== null && !viewingPage.value) viewing.value = null
  },
)

/**
 * 深链的页码**变了**(同一个组件实例换 `?page=`):换到新落点,未渲染时先停在网格。
 * `file` 那条 watch 只在换文件时跑,地址栏里只改 `page` 时它不动 —— 少了这一条,
 * 「第 8 页 → 第 14 页」的第二次跳转会停在原地。
 */
watch(
  () => props.page,
  () => {
    const requested = requestedPage()
    targetPageIssue.value = ''
    autoRenderKey.value = ''
    pendingPage.value = requested
    if (requested !== null && state.value?.pages.some((page) => page.page === requested)) {
      viewing.value = requested
      pendingPage.value = null
    } else {
      viewing.value = null
      void resolveRequestedPage()
    }
  },
)
</script>

<template>
  <div class="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
    <!-- 单页视图的头部:「回网格」与页数口径。总页数未知时只报已有页图数。**当前页码不在这里重复** ——
         下面 `ImagePreview` 的工具栏标题已经写着「第 N 页」,两行都写就成了同一句话说两遍
         (旧版就是这样)。这里只补它没有的那一半:一共多少页。 -->
    <div
      v-if="viewingPage"
      class="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1"
    >
      <Button variant="ghost" size="sm" class="h-7 px-1.5 text-xs" @click="viewing = null">
        <ArrowLeft />
        返回全部页
      </Button>
      <span class="text-muted-foreground text-xs tabular-nums">
        {{ viewingCountLabel }}
      </span>

      <!-- **窄屏的缩放入口**(独立审查 R1)。`PreviewToolbar` 把 − / + / 适宽 三颗按钮
           收在 `sm:` / `lg:` 断点里(宽屏才显示),而 390px 的弹窗里那正是**唯一**能读清
           正文的手段 —— 那时「适宽」把整页缩到 **约 19%**(实测 19.5%:322px / 自然宽 1653,
           见票 13 §8.8 R1),不放大的话字是糊的。所以本行自己补
           一组,`sm:hidden` 与它错开,不会重复出现两套缩放。 -->
      <span class="ml-auto flex shrink-0 items-center gap-1 sm:hidden">
        <!-- 到下限就禁用。判据取**子预览暴露的有效下限**(`min(手动下限, fit)`),
             而不是本组件的配置下限 `PAGE_IMAGE_ZOOM_MIN`:fit 落在 10% 之下时
             (超小页 + 窄容器),能到的实际最小是 **fit**,用配置下限会把还能缩的区间**误禁**。 -->
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="缩小"
          :disabled="!viewer || viewer.zoom <= viewer.effectiveZoomMin"
          @click="viewer?.zoomBy(1 / 1.12)"
        >
          <ZoomOut />
        </Button>
        <Button variant="outline" size="sm" class="h-8 px-2 text-xs" @click="viewer?.fit()">
          适宽
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="放大"
          @click="viewer?.zoomBy(1.12)"
        >
          <ZoomIn />
        </Button>
      </span>
    </div>

    <!-- 网格视图的工具栏:左=状态,右=动作。动作永远在同一个位置。 -->
    <div
      v-else-if="state && status"
      class="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5"
    >
      <Badge v-if="badge" :variant="badge.variant">{{ badge.word }}</Badge>
      <!-- 渲染失败时不在这里解释:下面的红条已经说清了原因与下一步,同一件事不摆两遍。
           未渲染时不在这里重复一遍:那件事空态里说更完整(有图标、有解释)。 -->
      <span
        v-if="!renderFailed && status.tone !== 'empty'"
        class="min-w-0 text-table leading-relaxed"
      >
        {{ status.headline }}<span v-if="status.detail" class="text-muted-foreground">
          · {{ status.detail }}</span
        >
      </span>

      <!-- 窄屏时这一组**独占一行**(`w-full` → `sm:w-auto`):成功态有结论句、失败态没有,
           不强制换行的话两种状态的工具栏一个两行一个一行,来回切时候会跳(独立审查 S6)。 -->
      <span
        class="flex w-full shrink-0 items-center justify-end gap-2 sm:ml-auto sm:w-auto sm:justify-start"
      >
        <span class="text-muted-foreground text-xs">分辨率</span>
        <Select :model-value="String(dpi)" @update:model-value="pickDpi">
          <SelectTrigger class="bg-card h-8 w-28" aria-label="页图分辨率">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="option in dpiOptions"
              :key="option"
              :value="String(option)"
              :disabled="!isDpiPreset(option)"
            >
              {{ option }} DPI{{ isDpiPreset(option) ? '' : '(当前)' }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button v-if="action" :variant="action.variant" :disabled="rendering" @click="action.run()">
          <Loader2 v-if="rendering" class="animate-spin" />
          {{ rendering ? '渲染中…' : action.label }}
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
    <div v-if="renderFailed || summary || targetPageIssue" class="flex shrink-0 flex-col gap-2 border-b px-3 py-2">
      <Alert v-if="targetPageIssue" role="alert" variant="destructive">
        <AlertDescription class="text-destructive! font-medium">
          {{ targetPageIssue }}
        </AlertDescription>
      </Alert>
      <Alert v-if="renderFailed" variant="destructive">
        <!-- `!` 是必须的:`alertVariants` 的 destructive 给说明文字加了 90% 透明,
             深色下只剩 4.25:1(低于 4.5:1);那条规则同权重、位置更靠后,
             只有 important 压得过(与删除 / 上传弹窗同一处处理)。 -->
        <AlertDescription class="text-destructive! font-medium">
          {{ failureMessage }}
        </AlertDescription>
      </Alert>
      <p v-else class="text-muted-foreground text-table leading-relaxed tabular-nums">
        {{ summary }}
      </p>
    </div>

    <!-- 单页:复用图片预览器(滚轮缩放、适应、旋转、下载都是打磨过的)。 -->
    <ImagePreview
      v-if="viewingPage"
      ref="viewer"
      :src="srcOf(viewingPage)"
      :name="pageLabel(viewingPage.page)"
      hide-kind-label
      :zoom-min="PAGE_IMAGE_ZOOM_MIN"
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
      <span class="text-table">正在渲染页图…</span>
      <span v-if="state?.pageCount" class="text-xs tabular-nums">
        共 {{ state.pageCount }} 页,大文件要几秒
      </span>
    </div>

    <!-- 一张都没有:说清这是什么、做什么用。动作在工具栏右端,这里只解释。
         **渲染刚失败时整块不画**(独立审查 R2):徽章已写「渲染失败」、红条已写原因,
         这里再挂一句「还没有页图」是同一屏里两个结论打架(一个说失败了,一个说还没做)。
         内容的空缺由那条红条占位,不另画图标 + 标题。 -->
    <Empty v-else-if="!state?.rendered && !renderFailed" class="flex-1 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Images /></EmptyMedia>
        <EmptyTitle>{{ status?.headline ?? '还没有页图' }}</EmptyTitle>
        <EmptyDescription>{{ status?.detail }}</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <div
      v-else
      class="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-auto px-3 pt-3 pb-8"
      :class="GRID_COLS"
    >
      <button
        v-for="page in state?.pages ?? []"
        :key="page.page"
        type="button"
        class="group hover:border-primary/40 hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 active:scale-[0.97] motion-reduce:active:scale-100 flex flex-col gap-1.5 rounded-md border border-transparent bg-card p-1.5 text-left transition-[color,background-color,border-color,transform] duration-150 ease-snap focus-visible:outline-none motion-reduce:transition-none"
        :title="`${pageLabel(page.page)} · ${page.width}×${page.height}`"
        @click="viewing = page.page"
      >
        <!-- 缩略图按整页显示(contain):要认得出是「哪一页」,靠的是整页的版式,
             裁掉一半反而认不出。底色用 muted —— **静态下就这一层边**(白页压在 muted 上);
             外层按钮的 1px 边线平时是**透明的**(`border-transparent`,留着占位不跳),
             只有 hover / 键盘聚焦时才亮出来。两层静态描边叠在一起会显得糊(独立审查 S5)。 -->
        <span class="bg-muted block aspect-[210/297] overflow-hidden rounded-sm">
          <!-- `alt=""`:**有意留空**。页码就在这个按钮的可见标签里,再给图片一句
               `alt="第 N 页"`,读屏会把同一句念两遍(按钮名 = 图片 alt + 可见文字)。
               空 alt 让读屏跳过这张装饰性缩略图,按钮名就是那行可见页码。 -->
          <img
            :src="srcOf(page)"
            alt=""
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
