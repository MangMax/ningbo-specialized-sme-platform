<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Check, Expand, Loader2, Pencil, Trash2, X } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { WorkbenchRow } from '~~/lib/ocr-workbench'
import {
  pageReviewState,
  STATE_BADGE,
  STATE_WORD,
  type PageReviewState,
} from '~~/lib/ocr-workbench'
import { OCR_CHANNELS } from '~~/lib/labels'
import { pageLabel } from '~~/lib/page-gallery'

/**
 * 工作台的一行 = **一页**:左页图、右 OCR 文本,下面是这一页的操作。
 *
 * 一行的主张很简单:**图与文本必须并排**。校对 OCR 就是把文本对着页面看,
 * 两个东西分屏或分页摆,人就得在脑子里对地址 —— 那正是这类工具最容易做得没用的地方。
 *
 * ── 三档状态,靠**线型与线重**分(不靠颜色)──────────────────────────────
 * 独立评审指出原来的两档不够用:「空结果」和「有文本」共用一个「已识别」徽章,
 * 徽章与紧挨着的正文互相拆台。现在三档对应三种线型 ——
 * **有文本**(实线加粗)/ **空结果**(次级实线)/ **未识别**(虚线),
 * 与 DESIGN.md 的「用线型与线重表达是不是已成立」同一套语汇,灰度打印也读得出。
 *
 * 未识别的页**另外**在缩略图左上角挂一枚**金色方标**:金色是本仓「国家级」那套
 * 图形标记的第三色,只做图形、不写金色文字。这一枚让「哪几页还没做」在缩到
 * 480px 的缩略图上、以及转灰度之后,都还看得出来。
 *
 * ── 三种状态,同一行里切换 ───────────────────────────────────────────
 *  - **读**:已有结果的 markdown 原文(不渲染 —— 仓里没有 markdown 渲染器,
 *    而「原文」恰是校对时要看的:表格与标题的结构都在,渲染反而会藏掉 `|` 与 `#`);
 *  - **改**:`Textarea` + 保存 / 取消。**允许存空文本**(空白页也要占一行,页号不能断),
 *    所以不做「空内容不许保存」这种校验;
 *  - **删**:二次确认(`确认删除` / `取消`)。删除是不可逆的(重做要花 API 额度),
 *    所以不弹系统对话框、也不一点就删,而是就地把按钮换成一对确认键。
 *
 * ── 键盘(独立评审 P3)──────────────────────────────────────────────────
 * 「可键盘操作」不能只是「每个控件都能 Tab 到」:确认条一出现焦点掉到 `body`,
 * 键盘用户想取消就得从页顶重走一遍几十行。所以这里**自己搬焦点** ——
 * 确认条出现时焦点落在「确认删除」,取消 / `Esc` 之后回到原来那颗按钮;
 * 编辑态里 `Esc` 与「取消」等价,回焦到「编辑 / 手工录入」。
 *
 * 每个动作的 pending / 失败由父页面给(`pending` / `failure`):这一行不自己发请求,
 * 所以「正在保存哪一页」「哪一页失败了」是**同一份状态**在管,不会各行其是。
 */
const props = defineProps<{
  row: WorkbenchRow
  /**
   * 页图地址的**版本号**(票 13 清单里的渲染时间)。
   *
   * 页图路径不随 DPI 变(原地覆盖),而 `/api/files/**` 给的是 `max-age=3600` ——
   * 刚按 300 DPI 重渲染完,浏览器还能拿一小时前那张 200 DPI 的缓存图。
   * 与 `lib/page-gallery.ts` 的 `pageImageSrc` 同一条理由,这里只是把版本号当参数收进来。
   */
  imageVersion?: string | null
  /** 这一行的写入/删除请求正在飞。 */
  pending?: boolean
  /** 这一行最近一次失败的说明(空串 = 没有)。 */
  failure?: string
  /** 刚刚写入成功 —— 给一次短促的描边,让「变的是这一行」落在这行上。 */
  highlight?: boolean
}>()

const emit = defineEmits<{
  /** 保存这一页的 markdown(空串合法)。 */
  save: [page: number, markdown: string]
  /** 删掉这一页的结果(本组件已做过二次确认)。 */
  remove: [page: number]
  /** 选中这一页去看大图(宽屏进右侧对照栏,窄屏开弹窗)。 */
  preview: [page: number]
}>()

const editing = ref(false)
const confirmingDelete = ref(false)
const draft = ref('')

/** 几处要自己搬焦点的位置(见组件头部「键盘」一节):编辑框,以及三颗互为锚点的按钮。 */
const editor = ref<{ $el?: HTMLTextAreaElement } | null>(null)
const editButton = ref<{ $el?: HTMLButtonElement } | null>(null)
const deleteButton = ref<{ $el?: HTMLButtonElement } | null>(null)
const confirmButton = ref<{ $el?: HTMLButtonElement } | null>(null)

const result = computed(() => props.row.result)
const image = computed(() => props.row.image)
const state = computed<PageReviewState>(() => pageReviewState(result.value))

/** 页图的最终地址:带版本号,免得换了 DPI 还显示缓存里的旧图。 */
const imageSrc = computed(() => {
  const url = image.value?.url
  if (!url) return ''
  return props.imageVersion ? `${url}?v=${encodeURIComponent(props.imageVersion)}` : url
})

/**
 * 通路 + 引擎/模型 + 时间。校对时「这条是谁写的」和文本本身一样要看得见。
 *
 * **引擎与模型只写一个**:`PaddleOCR-VL-1.6` 已经把这个引擎说全了,再并列一个
 * `paddleocr` 是同一件事写两遍(独立评审点了这条)。有模型名就用模型名,
 * 没有(上传通路的 model 可空)才退回引擎名。
 */
const metaParts = computed(() => {
  const r = result.value
  if (!r) return []
  return [OCR_CHANNELS[r.channel] ?? r.channel, r.model || r.engine].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  )
})

/** 时间单独一段,`whitespace-nowrap` —— 窄屏下日期不能被拆到两行。 */
const timeText = computed(() => (result.value ? formatTime(result.value.createdAt) : ''))

/** 时间:只到分钟。校对场景里精确到秒没有意义,反而占宽度。 */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 把焦点搬到某个模板 ref 上,**等它真的接住为止**。
 *
 * 收 ref 而不是收元素:调用点写的都是 `focusEl(deleteButton)` 这种「那颗按钮」的意思,
 * 取值这一步在这里一次做掉。
 *
 * 为什么要重试:「读 / 改」两个分支套在 `Transition` 里,换分支时目标元素**不是**
 * 一次 `nextTick` 之后就挂上的(`mode="out-in"` 要先把旧分支的离开走完)。只等一次
 * `nextTick` 会落空,焦点掉回 `body` —— 键盘用户想取消就得从页顶重走一遍几十行,
 * 而独立评审实测到的正是这一幕。与其猜要等几帧,不如**每帧试一次、接住就停**:
 * 上限 4 帧(约 66ms)是兜底,正常一两帧就命中。
 */
async function focusEl(target: { value: { $el?: HTMLElement } | null }) {
  for (let frame = 0; frame < 4; frame += 1) {
    await nextTick()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const el = target.value?.$el
    if (!el || typeof el.focus !== 'function') continue
    el.focus()
    if (document.activeElement === el) return
  }
}

function startEdit() {
  draft.value = result.value?.markdown ?? ''
  confirmingDelete.value = false
  editing.value = true
  // 打开编辑器就把光标放进正文:校对是「一边看图一边改字」,多一次点击都是摩擦。
  void focusEl(editor)
}

function cancelEdit() {
  editing.value = false
  draft.value = ''
  // 回到**进编辑的那颗按钮**,而不是「删除」:焦点该回到出发点,不然键盘用户接着往下走
  // 会从「删除」开始,把「编辑」跳过去。
  void focusEl(editButton)
}

function submit() {
  emit('save', props.row.page, draft.value)
}

function askDelete() {
  confirmingDelete.value = true
  void focusEl(confirmButton)
}

function cancelDelete() {
  confirmingDelete.value = false
  void focusEl(deleteButton)
}

function confirmDelete() {
  emit('remove', props.row.page)
  confirmingDelete.value = false
}

/** `Esc` = 「取消」:编辑态退编辑,确认态退确认。焦点各回原位。 */
function onEscape() {
  if (editing.value) cancelEdit()
  else if (confirmingDelete.value) cancelDelete()
}

/**
 * 保存成功、父页面刷新后关掉编辑器。判据是「这一页的结果变了」——
 * 而不是「父页面说成功了」:失败时编辑器必须留着,让人能接着改
 * (关掉就等于把刚写的正文丢了)。
 */
watch(
  () => result.value?.createdAt,
  (next, previous) => {
    if (next && next !== previous) {
      editing.value = false
      draft.value = ''
    }
  },
)
</script>

<template>
  <li
    class="bg-card rounded-lg border p-2.5 transition-[box-shadow,border-color] duration-500 ease-snap motion-reduce:transition-none sm:p-3"
    :class="highlight ? 'border-primary/40 ring-primary/20 ring-2' : ''"
    @keydown.esc="onEscape"
  >
    <div class="flex flex-col gap-3 sm:flex-row">
      <!-- 左:页图。**只是定位用的索引**,不指望在这儿读正文 ——
           要读字走右边那颗「放大看」。所以它比一屏能放下的行数更值得让步:窄一点、矮一点,
           同屏多出两三行。宽屏另有常驻的对照栏(见 pages/ocr.vue)。 -->
      <div class="flex shrink-0 flex-col gap-1.5 sm:w-20">
        <button
          v-if="image"
          type="button"
          class="group focus-visible:border-ring focus-visible:ring-ring/50 relative block aspect-[210/297] w-16 overflow-hidden rounded-sm border bg-white focus-visible:ring-3 focus-visible:outline-none sm:w-full"
          :aria-label="`放大看${pageLabel(row.page)}`"
          @click="emit('preview', row.page)"
        >
          <!-- `alt=""`:**有意留空**。可访问名由按钮的 `aria-label` 给,图片再来一句
               alt 会让读屏把同一个意思念两遍。 -->
          <img
            :src="imageSrc"
            alt=""
            loading="lazy"
            decoding="async"
            class="size-full object-contain"
          />
          <!-- 待校对的金色方标:金色是本仓「国家级」那套图形标记的第三色(见
               `TitleBadge` / `SourceChip` 的 `bg-mark-national size-1.5 rounded-[1px]`),
               这里借它做**唯一一处品牌色落点**,只画图形、不写金色文字。
               放在角上而不是整条边 —— 单侧色条是模型默认做法,一角方标是这套台账自己的语言。 -->
          <span
            v-if="state === 'none'"
            aria-hidden="true"
            class="bg-mark-national absolute top-1 left-1 size-1.5 rounded-[1px]"
          />
          <!-- 放大提示只在 hover / 聚焦时浮出来,静态下不添第二层描边。 -->
          <span
            class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
          >
            <Expand class="size-4 text-white" />
          </span>
        </button>
        <!-- 没渲染过:说清这一页现在缺什么,而不是留一块空白。 -->
        <div
          v-else
          class="text-muted-foreground flex aspect-[210/297] w-16 flex-col items-center justify-center gap-1 rounded-sm border border-dashed px-1 text-center text-[10px] leading-tight sm:w-full"
        >
          <span>未渲染</span>
        </div>
        <span class="text-xs font-medium tabular-nums">{{ pageLabel(row.page) }}</span>
      </div>

      <!-- 右:文本与操作。`min-w-0` 是必须的 —— 不写的话长表格会把这一行撑破,不再换行。 -->
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge :variant="STATE_BADGE[state]">{{ STATE_WORD[state] }}</Badge>
          <span v-if="metaParts.length" class="text-muted-foreground text-xs">
            {{ metaParts.join(' · ') }}<template v-if="timeText">
              · <span class="whitespace-nowrap">{{ timeText }}</span></template
            >
          </span>
        </div>

        <!-- 改 / 读 之间来一次短淡入:状态切换看得出来路,不「啪」地换掉。 -->
        <Transition
          enter-active-class="transition-opacity duration-150 ease-snap motion-reduce:transition-none"
          enter-from-class="opacity-0"
          leave-active-class="hidden"
          mode="out-in"
        >
          <div v-if="editing" key="edit" class="flex flex-col gap-2">
            <Textarea
              ref="editor"
              v-model="draft"
              :aria-label="`${pageLabel(row.page)}的 OCR 文本`"
              class="max-h-[26rem] min-h-32 font-mono text-xs"
              placeholder="这一页的识别文本(markdown)。空白页留空即可 —— 空结果也会占住页号。"
            />
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" :disabled="pending" @click="submit">
                <Loader2 v-if="pending" class="animate-spin" />
                <Check v-else />
                {{ pending ? '保存中…' : '保存' }}
              </Button>
              <Button variant="ghost" size="sm" :disabled="pending" @click="cancelEdit">
                <X />
                取消
              </Button>
              <span class="text-muted-foreground text-xs">保存会覆盖这一页原有的文本。</span>
            </div>
          </div>

          <div v-else key="read" class="flex flex-col gap-2">
            <!-- 原文而不是渲染后的结果:校对要看的正是 `|` 与 `#` 这些结构标记,
                 渲染一遍反而把它们藏掉。空的正文不写第二句话 —— 徽章已经写着「空结果」。 -->
            <pre
              v-if="result"
              class="bg-muted/40 max-h-[13rem] overflow-auto rounded-sm p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap"
            >{{ result.markdown || '(空)' }}</pre>

            <div class="flex flex-wrap items-center gap-2">
              <Button
                ref="editButton"
                variant="outline"
                size="sm"
                :disabled="pending"
                @click="startEdit"
              >
                <Pencil />
                {{ result ? '编辑' : '手工录入' }}
              </Button>
              <template v-if="result">
                <Button
                  v-if="!confirmingDelete"
                  ref="deleteButton"
                  variant="outline"
                  size="sm"
                  :disabled="pending"
                  @click="askDelete"
                >
                  <Trash2 />
                  删除
                </Button>
                <!-- 二次确认就地把按钮换一对:不弹系统框、不一点就删,键盘也能一路走完。
                     这句话把页底那段长说明里真正有用的半句挪过来了(只删这一页的结果)。 -->
                <template v-else>
                  <span class="text-destructive text-xs font-medium">
                    删除后重做要重新识别,确定?(只删这一页的文本,不动页图与台账)
                  </span>
                  <Button
                    ref="confirmButton"
                    variant="destructive"
                    size="sm"
                    :disabled="pending"
                    @click="confirmDelete"
                  >
                    <Loader2 v-if="pending" class="animate-spin" />
                    <Trash2 v-else />
                    确认删除
                  </Button>
                  <Button variant="ghost" size="sm" :disabled="pending" @click="cancelDelete">
                    取消
                  </Button>
                </template>
              </template>
            </div>
          </div>
        </Transition>

        <Alert v-if="failure" variant="destructive">
          <!-- `!` 是必须的:destructive 的说明文字默认带 90% 透明,深色下对比度不足
               (与文件页、页图库同一处处理)。 -->
          <AlertDescription class="text-destructive! font-medium">{{ failure }}</AlertDescription>
        </Alert>
      </div>
    </div>
  </li>
</template>
