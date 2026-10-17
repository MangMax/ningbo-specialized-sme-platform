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
import OcrPageBody from './OcrPageBody.vue'
import { OCR_CHANNELS } from '~~/lib/labels'
import { pageLabel } from '~~/lib/page-gallery'

const props = defineProps<{
  row: WorkbenchRow
  filePath: string
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
  /** Refresh/error snapshots remain readable but cannot be written. */
  disabled?: boolean
  /** Confirmed write/readback; also closes the editor. */
  highlight?: boolean
}>()

const emit = defineEmits<{
  /** 保存这一页的 markdown(空串合法)。 */
  save: [page: number, markdown: string]
  /** 删掉这一页的结果(本组件已做过二次确认)。 */
  remove: [page: number]
  /** 选中这一页去看大图(宽屏进右侧对照栏,窄屏开弹窗)。 */
  preview: [page: number]
  dirty: [dirty: boolean]
}>()

const editing = ref(false)
const confirmingDelete = ref(false)
const removing = ref(false)
const draft = ref('')
watch(
  [editing, draft],
  () =>
    emit(
      'dirty',
      editing.value && draft.value !== (result.value?.markdown ?? ''),
    ),
  { flush: 'sync' },
)

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
  return props.imageVersion
    ? `${url}?v=${encodeURIComponent(props.imageVersion)}`
    : url
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
const timeText = computed(() =>
  result.value ? formatTime(result.value.createdAt) : '',
)

/** 时间:只到分钟。校对场景里精确到秒没有意义,反而占宽度。 */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

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
  void focusEl(editor)
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
  removing.value = true
  emit('remove', props.row.page)
  confirmingDelete.value = false
}

/** `Esc` = 「取消」:编辑态退编辑,确认态退确认。焦点各回原位。 */
function onEscape() {
  if (props.pending) return
  if (editing.value) cancelEdit()
  else if (confirmingDelete.value) cancelDelete()
}

/** Only confirmed write/readback closes the editor, including a no-op or empty save. */
watch([() => props.highlight, () => props.pending], ([saved, pending]) => {
  if (saved && !pending && editing.value) {
    editing.value = false
    draft.value = ''
    void focusEl(editButton)
  }
})
watch(
  () => props.pending,
  (pending, wasPending) => {
    if (!pending && wasPending && removing.value) {
      removing.value = false
      void focusEl(editButton)
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
    <div class="flex flex-col gap-3 lg:flex-row">
      <div class="flex shrink-0 flex-col gap-1.5 lg:w-1/2">
        <button
          v-if="image"
          type="button"
          class="group focus-visible:border-ring focus-visible:ring-ring/50 relative block aspect-[210/297] w-full overflow-hidden rounded-sm border bg-white focus-visible:ring-3 focus-visible:outline-none lg:w-full"
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
          class="text-muted-foreground flex aspect-[210/297] w-full flex-col items-center justify-center gap-1 rounded-sm border border-dashed px-1 text-center text-[10px] leading-tight lg:w-full"
        >
          <span>未渲染</span>
        </div>
        <span class="text-xs font-medium tabular-nums">{{
          pageLabel(row.page)
        }}</span>
      </div>

      <!-- 右:文本与操作。`min-w-0` 是必须的 —— 不写的话长表格会把这一行撑破,不再换行。 -->
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge :variant="STATE_BADGE[state]">{{ STATE_WORD[state] }}</Badge>
          <span v-if="metaParts.length" class="text-muted-foreground text-xs">
            {{ metaParts.join(' · ')
            }}<template v-if="timeText">
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
              :readonly="pending"
              :disabled="disabled"
              :aria-label="`${pageLabel(row.page)}的 OCR 文本`"
              class="max-h-[26rem] min-h-32 font-mono text-xs"
              placeholder="这一页的识别文本(markdown)。空白页留空即可 —— 空结果也会占住页号。"
            />
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" :disabled="pending || disabled" @click="submit">
                <Loader2
                  v-if="pending"
                  class="animate-spin motion-reduce:animate-none"
                />
                <Check v-else />
                {{ pending ? '保存中…' : '保存' }}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                :disabled="pending"
                @click="cancelEdit"
              >
                <X />
                取消
              </Button>
              <span class="text-muted-foreground text-xs"
                >保存会覆盖这一页原有的文本。</span
              >
            </div>
          </div>

          <div v-else key="read" class="flex flex-col gap-2">
            <!-- 原文而不是渲染后的结果:校对要看的正是 `|` 与 `#` 这些结构标记,
                 渲染一遍反而把它们藏掉。空的正文不写第二句话 —— 徽章已经写着「空结果」。 -->
            <OcrPageBody
              v-if="result"
              :markdown="result.markdown"
              :file-path="filePath"
              :page="row.page"
              class="max-h-[65vh]"
            />

            <div class="flex flex-wrap items-center gap-2">
              <Button
                ref="editButton"
                variant="outline"
                size="sm"
                :disabled="pending || disabled"
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
                  :disabled="pending || disabled"
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
                    :disabled="pending || disabled"
                    @click="confirmDelete"
                  >
                    <Loader2
                      v-if="pending"
                      class="animate-spin motion-reduce:animate-none"
                    />
                    <Trash2 v-else />
                    确认删除
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    :disabled="pending || disabled"
                    @click="cancelDelete"
                  >
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
          <AlertDescription class="text-destructive! font-medium">{{
            failure
          }}</AlertDescription>
        </Alert>
      </div>
    </div>
  </li>
</template>
