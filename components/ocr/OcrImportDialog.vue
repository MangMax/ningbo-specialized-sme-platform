<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Loader2, Upload } from '@lucide/vue'
import { Alert, AlertDescription } from '#core/app/components/ui/alert'
import { Button } from '#core/app/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#core/app/components/ui/dialog'
import { Label } from '#core/app/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#core/app/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'
import { Textarea } from '#core/app/components/ui/textarea'
import { JSONL_IMPORT_HINT, MARKDOWN_IMPORT_HINT } from '~~/lib/ocr-workbench'
import { pageLabel } from '~~/lib/page-gallery'

/**
 * 导入人工在 PaddleOCR 官网跑好的结果(通路 b 在页面上的入口)。
 *
 * ── 两种装法,页号来源不同 ──────────────────────────────────────────────
 *  - **JSONL**:官网下载的结果文件全文。页号按**行序**对齐(第 i 段就是第 i 页),
 *    所以**必须**与这份 PDF 的页数核对 —— 服务端核,对不上不写
 *    (`lib/ocr-workbench.ts` 的 `guardImportedPageCount`)。
 *  - **markdown**:整份就自带页标记(`<!-- page: N -->`,也认 `## 第 N 页`);
 *    只贴一页的正文时在下拉里指明是**哪一页**。
 *
 * 两种都不从正文内容里读页号。理由见 `lib/ocr-workbench.ts` 顶部。
 *
 * ── 为什么不做客户端预解析 ──────────────────────────────────────────────
 * JSONL 一行的 `layoutParsingResults` 可以有**多项**(服务端分批),所以「非空行数」
 * 不等于页数。在客户端数一遍会给出一个与服务端不一致的数字,而那个数字正是这次
 * 导入唯一要保住的东西 —— 宁可不在本地猜,让服务端核完把结论说出来。
 *
 * 本组件**不发请求**(与 `EditFileDialog` 同一分法):它只收集输入并 emit,
 * 成败、进度、结果都由父页面管。这样弹窗里不会出现第二份「谁在飞」的状态。
 */
const open = defineModel<boolean>('open', { default: false })

const props = withDefaults(
  defineProps<{
    /** 正在往哪份文件上导(页号核对靠它的页数)。 */
    filename?: string
    /** 可选的页号清单(界面上的「第 N 页」下拉;来自页图清单/源页数)。 */
    pageNumbers?: number[]
    /** 源 PDF 页数;读不出来时为 null。只用于把规则说清。 */
    pageCount?: number | null
    pending?: boolean
    /** 上一次导入的失败说明(空串 = 没有)。 */
    failure?: string
    /** 上一次导入成功的一句话(读回核对的结果);空串 = 还没成功过。 */
    result?: string
  }>(),
  { filename: '', pageNumbers: () => [], pageCount: null, pending: false, failure: '', result: '' },
)

const emit = defineEmits<{
  submit: [{ jsonl: string } | { markdown: string; page: number | null }]
}>()

/** 下拉里表示「整份(按页标记切)」的哨兵值(reka-ui 的 SelectItem 不收空串 value)。 */
const WHOLE = '__whole__'

const mode = ref<'jsonl' | 'markdown'>('jsonl')
const jsonlText = ref('')
const markdownText = ref('')
const targetPage = ref<string>(WHOLE)

const canSubmit = computed(() =>
  mode.value === 'jsonl' ? jsonlText.value.trim().length > 0 : markdownText.value.trim().length > 0,
)

/** 只贴一页时正文**不该**再带页标记 —— 那是两种页号语义打架(服务端会拒)。 */
const singlePageHint = computed(() =>
  targetPage.value === WHOLE
    ? MARKDOWN_IMPORT_HINT
    : `这段正文会被写成${pageLabel(Number(targetPage.value))} —— 所以正文里不要再写页标记。`,
)

const scopeHint = computed(() =>
  props.pageCount === null || props.pageCount <= 0
    ? '读不出这份 PDF 的页数;整份结果需要页数才能核对页码,所以不写入。'
    : `这份 PDF 共 ${props.pageCount} 页;整份结果的行数必须与它一致,否则不写入。`,
)

// 每次打开都从空状态起:上一次的正文留在框里,很容易被误当成这次要导的东西。
watch(open, (value) => {
  if (!value) return
  mode.value = 'jsonl'
  jsonlText.value = ''
  markdownText.value = ''
  targetPage.value = WHOLE
})

function submit() {
  if (!canSubmit.value || props.pending) return
  if (mode.value === 'jsonl') emit('submit', { jsonl: jsonlText.value })
  else {
    emit('submit', {
      markdown: markdownText.value,
      page: targetPage.value === WHOLE ? null : Number(targetPage.value),
    })
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>导入识别结果</DialogTitle>
        <DialogDescription>
          把人工在 PaddleOCR 跑好的结果导回<template v-if="filename">「{{ filename }}」</template>。
          已有结果的页会被<span class="text-foreground font-medium">覆盖</span>,没列出的页不动。
        </DialogDescription>
      </DialogHeader>

      <Tabs v-model="mode" class="min-w-0">
        <TabsList aria-label="结果文件的装法">
          <TabsTrigger value="jsonl">结果文件 (JSONL)</TabsTrigger>
          <TabsTrigger value="markdown">Markdown</TabsTrigger>
        </TabsList>

        <TabsContent value="jsonl" class="flex flex-col gap-2 pt-2">
          <Label for="ocr-import-jsonl">结果文件全文</Label>
          <Textarea
            id="ocr-import-jsonl"
            v-model="jsonlText"
            class="max-h-72 min-h-40 overflow-auto font-mono text-xs"
            placeholder='{"result":{"layoutParsingResults":[{"markdown":{"text":"第一页…"}}]}}'
          />
          <p class="text-muted-foreground text-xs leading-relaxed">{{ JSONL_IMPORT_HINT }}</p>
        </TabsContent>

        <TabsContent value="markdown" class="flex flex-col gap-2 pt-2">
          <div class="flex flex-col gap-1.5">
            <Label for="ocr-import-page">写到哪一页</Label>
            <Select v-model="targetPage">
              <SelectTrigger id="ocr-import-page" class="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="WHOLE">整份(按正文里的页标记)</SelectItem>
                <SelectItem v-for="num in pageNumbers" :key="num" :value="String(num)">
                  {{ pageLabel(num) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Label for="ocr-import-markdown">识别结果正文</Label>
          <Textarea
            id="ocr-import-markdown"
            v-model="markdownText"
            class="max-h-72 min-h-40 overflow-auto font-mono text-xs"
            placeholder="<!-- page: 1 -->&#10;&#10;### 附件1&#10;&#10;| 序号 | 属地 | 企业名称 |"
          />
          <p class="text-muted-foreground text-xs leading-relaxed">{{ singlePageHint }}</p>
        </TabsContent>
      </Tabs>

      <p class="text-muted-foreground text-xs leading-relaxed">{{ scopeHint }}</p>

      <Alert v-if="failure" variant="destructive">
        <AlertDescription class="text-destructive! font-medium">{{ failure }}</AlertDescription>
      </Alert>
      <!-- 成功结果就地留在弹窗里:「读回一致」是这次导入的结论,关掉弹窗之前该看得见。 -->
      <Alert v-else-if="result">
        <AlertDescription>{{ result }}</AlertDescription>
      </Alert>

      <DialogFooter>
        <Button variant="ghost" :disabled="pending" @click="open = false">关闭</Button>
        <Button :disabled="!canSubmit || pending" @click="submit">
          <Loader2 v-if="pending" class="animate-spin" />
          <Upload v-else />
          {{ pending ? '导入中…' : '导入' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
