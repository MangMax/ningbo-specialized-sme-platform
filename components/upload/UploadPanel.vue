<script setup lang="ts">
import { formatBytes } from '@/lib/core/file-size'
import { computed, inject, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Upload } from 'tus-js-client'
import type { HttpResponse } from 'tus-js-client'
import { withTusLogging } from '~~/lib/client-logging/tus'
import { clientLibraryReporterKey, ignoreClientLibrarySignal } from '~~/lib/client-logging/library-reporter'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import UploadDropzone from './UploadDropzone.vue'
import UploadItem from './UploadItem.vue'
import MetadataFields from './MetadataFields.vue'
import type { BatchMeta, UploadFailure, UploadMetadata, UploadPhase } from '@/lib/upload'
import type { UploadedFile } from '@/lib/upload-register'
import {
  TUS_ENDPOINT,
  baseName,
  buildMetadata,
  emptyBatchMeta,
  formatEta,
  isBatchComplete,
  isFilenameSafe,
  landingPath,
  matchPreviousUpload,
  metadataPayload,
  resumeKey,
  toUploadFailure,
  validateBatch,
} from '@/lib/upload'

/**
 * 上传面板:拖入文件 → 填落位信息 → 传 → 看结果落在哪个路径,断了能接着传。
 *
 * 两件事分得很开,别混:
 *  - **落位信息**(来源/类别/年份/批次)是**一批文件**共用的声明,面板顶部一份;
 *  - **文件名**由每个文件自带,不是手填的字段 —— 手填的和实际文件对不上,是错的来源。
 *
 * 队列**顺序上传一次一个**:文件库是单机磁盘,并发抢同一块盘没有收益,反而更难看清进度。
 * 传完一个自动开下一个。
 *
 * **只管传字节**:传完之后怎么登记进库由外面的容器决定(见 `lib/upload-register.ts`),
 * 面板通过 `uploaded` 事件把结果交出去 —— 所以这里既不写库,也不假设自己摆在哪种容器里,
 * 不带卡片外壳(容器负责排版;卡片套进弹窗会变成「卡片里套卡片」,DESIGN.md 明确不要)。
 */
const props = withDefaults(
  defineProps<{
    /** 整个面板不可用时(如无权限)的开关。 */
    disabled?: boolean
    /** tus 端点。默认与 `server/utils/tus.ts` 的 `TUS_PATH` 一致。 */
    endpoint?: string
  }>(),
  { disabled: false, endpoint: TUS_ENDPOINT },
)

const emit = defineEmits<{
  /**
   * 一份文件**已传完并落位**。交给外面的容器去登记(见 `lib/upload-register.ts`)——
   * 面板只管传字节,不管「登记进库」这件事怎么做。
   */
  (e: 'uploaded', file: UploadedFile): void
  (e: 'error', payload: { name: string; failure: UploadFailure }): void
}>()

/** 队列里的一条。`file` 只在这里持有,不进响应式深层(File 是宿主对象)。 */
interface UploadTask {
  id: number
  file: File
  name: string
  size: number
  phase: UploadPhase
  /** 已发字节。 */
  offset: number
  /** 0–100。 */
  progress: number
  /** 服务端回报的实际落位路径(相对文件库根);拿不到时退回落位预览。 */
  destination: string | null
  /** 仅本地兜底:本次请求声明的落位路径。 */
  declaredPath: string
  /** 本次请求**实际声明**的元数据(发出瞬间的快照)—— 完成登记时要用它,不是当下的 `meta`。 */
  declaredMeta: UploadMetadata | null
  failure: UploadFailure | null
  /** 平滑后的速度,字节/秒。 */
  speed: number
  eta?: string
  /** 历史里存在可续的上传。 */
  resumable: boolean
  upload: Upload | null
  // —— 速度采样(不进模板)——
  lastAt: number
  lastBytes: number
  /** 用户主动暂停/移除时,忽略 abort 触发的那次 onError。 */
  ignoreNextError: boolean
}

let idSeq = 0
const reportLibrary = inject(clientLibraryReporterKey, ignoreClientLibrarySignal)

const meta = ref<BatchMeta>(emptyBatchMeta())
const queue = ref<UploadTask[]>([])
/** 当前在传的那一条;null 表示空闲。 */
const activeId = ref<number | null>(null)
/** 已发现的可续上传数(页面加载时扫一次)。 */
const resumableCount = ref(0)

// —— 加文件的对话框 ——
const dialogOpen = ref(false)
const pendingFiles = ref<File[]>([])
const pendingName = ref('')

const problems = computed(() => validateBatch(meta.value))
/** 可以开始传了:两项必需声明齐了,且没有别的错。 */
const canStart = computed(() => isBatchComplete(meta.value) && problems.value.length === 0)
/** 队列里还有等着的、且落位信息还没填全 —— 提示用户去填。 */
const waitingForMeta = computed(
  () => queue.value.some((t) => t.phase === 'queued') && !canStart.value,
)

const doneCount = computed(() => queue.value.filter((t) => t.phase === 'done').length)
const totalBytes = computed(() => queue.value.reduce((sum, t) => sum + t.size, 0))
const sentBytes = computed(() =>
  queue.value.reduce((sum, t) => sum + (t.phase === 'done' ? t.size : t.offset), 0),
)

const dropHint = computed(() => {
  if (resumableCount.value > 0)
    return `有 ${resumableCount.value} 个未传完;重新选入同一个文件会从断点接着传`
  return '或点击选择文件'
})

/** 预览用:队列里第一条还没传的文件名(表单的建议值与落位预览都按它算)。 */
const previewFilename = computed(() => queue.value.find((t) => t.phase !== 'done')?.name ?? '')

// ─────────────────────────────────────────────────────────────
// 文件进入队列
// ─────────────────────────────────────────────────────────────

function openAddDialog(files: File[]) {
  if (props.disabled || files.length === 0) return
  pendingFiles.value = files
  pendingName.value = files[0] ? baseName(files[0].name) : ''
  // 不再从文件名**自动回填**落位信息:建议值由 `MetadataFields` 摆出来、由用户点「采纳」
  // 才写入(票 10「最终以用户填写为准」)。自动填死会替用户拍板,而文件名里的年份常常
  // 是复核的原始认定年份(见 lib/stored-file.ts 的同名告诫)—— 猜错就是错的落位。
  dialogOpen.value = true
}

function confirmAdd() {
  dialogOpen.value = false
  addToQueue(pendingFiles.value)
  pendingFiles.value = []
}

/** 直接入队(对话框之外的程序化入口)。 */
function addToQueue(files: File[]) {
  for (const file of files) {
    const name = baseName(file.name)
    // 同一个文件还在队列里没传完,不重复入队;传完了的可以再传(服务端会落 ` (n)`)。
    const duplicated = queue.value.some(
      (t) => t.name === name && t.size === file.size && t.phase !== 'done',
    )
    if (duplicated) continue
    queue.value.push({
      id: (idSeq += 1),
      file,
      name,
      size: file.size,
      phase: 'queued',
      offset: 0,
      progress: 0,
      destination: null,
      declaredPath: '',
      declaredMeta: null,
      failure: null,
      speed: 0,
      eta: undefined,
      resumable: false,
      upload: null,
      lastAt: 0,
      lastBytes: 0,
      ignoreNextError: false,
    })
  }
  void nextTick(() => maybeStart())
}

// ─────────────────────────────────────────────────────────────
// 上传编排:一次一个,传完自动开下一个
// ─────────────────────────────────────────────────────────────

function maybeStart() {
  if (props.disabled) return
  if (activeId.value !== null) return
  if (!canStart.value) return
  const next = queue.value.find((t) => t.phase === 'queued')
  if (next) startTask(next)
}

/** 松手:清掉「在传」的标记,让队列能继续。 */
function release(task: UploadTask) {
  if (activeId.value === task.id) activeId.value = null
  task.upload = null
  void nextTick(() => maybeStart())
}

/** 从响应头取服务端回报的落位路径(服务端做了百分号编码,中文才能进 HTTP 头)。 */
function readUploadPath(response: HttpResponse | null | undefined): string | null {
  const header = response?.getHeader?.('X-Upload-Path')
  if (!header) return null
  try {
    return decodeURIComponent(header)
  } catch {
    return header
  }
}

function startTask(task: UploadTask) {
  if (props.disabled || task.phase === 'uploading' || task.phase === 'done') return
  if (!canStart.value) return

  // 这一次请求声明的落位:在发出的瞬间快照下来,之后的预览改动不影响它。
  const declared: UploadMetadata = buildMetadata(meta.value, task.name)
  task.declaredPath = landingPath(declared)
  task.declaredMeta = declared
  task.failure = null
  task.resumable = false
  task.phase = 'uploading'
  if (task.offset === 0) task.progress = 0
  activeId.value = task.id

  const upload = new Upload(task.file, withTusLogging({
    endpoint: props.endpoint,
    // 6MiB 一段:网断了重传的代价和进度颗粒度之间取平衡,不再往上加。
    chunkSize: 6 * 1024 * 1024,
    // 有限次自动重试;用完了交给用户点「重试」,而不是无声地永远转下去。
    retryDelays: [0, 1000, 3000, 5000],
    metadata: metadataPayload(declared),
    // **自定义指纹**:默认指纹只有「文件名 + 大小 + 类型 + 最后修改时间 + 端点」,
    // 不含元数据 —— 换一个批次重传同一份文件会被认成同一个上传,续到旧的落位上。
    // 把落位声明并进指纹,续传就只在「文件与声明都一致」时成立。
    fingerprint: (file) => Promise.resolve(resumeKey(file as File, meta.value, props.endpoint)),
    storeFingerprintForResuming: true,
    // 成功后清掉指纹,断点记录不留垃圾,也让「可续上传」的计数就是真的未完成数。
    removeFingerprintOnSuccess: true,
    onProgress: (sent, total) => onProgress(task, sent, total),
    onSuccess: (payload) => onSuccess(task, payload.lastResponse),
    onError: (error) => onError(task, error),
  }, reportLibrary, () => !task.ignoreNextError))

  task.upload = upload

  // 先问存储里有没有能续的。指纹已经把元数据算进去了,这里再核一遍字段。
  upload
    .findPreviousUploads()
    .then((previous) => {
      const match = matchPreviousUpload(
        previous,
        { name: task.name, size: task.size },
        declared,
        props.endpoint,
      )
      if (!match) return
      // `match` 已经是按创建时间取最新的那一条(见 lib/upload.ts)。
      upload.resumeFromPreviousUpload(match)
      task.resumable = true
      if (match.size) task.size = match.size
    })
    .catch(() => {
      // 读不到历史就当成新上传,不该因此挡住上传本身。
    })
    .finally(() => {
      upload.start()
    })
}

function onProgress(task: UploadTask, sent: number, total: number) {
  if (task.phase !== 'uploading') return
  task.offset = sent
  const size = total || task.size
  task.progress = size ? (sent / size) * 100 : 0

  // 速度用指数平滑,免得数字乱跳;每 300ms 采一次。
  const now = performance.now()
  if (task.lastAt === 0) {
    task.lastAt = now
    task.lastBytes = sent
    return
  }
  const dt = (now - task.lastAt) / 1000
  if (dt < 0.3) return
  const instant = Math.max(0, sent - task.lastBytes) / dt
  task.speed = task.speed > 0 ? task.speed * 0.7 + instant * 0.3 : instant
  task.lastAt = now
  task.lastBytes = sent
  task.eta = task.speed > 0 ? formatEta((size - sent) / task.speed) : undefined
}

function onSuccess(task: UploadTask, response: HttpResponse) {
  task.progress = 100
  task.offset = task.size
  task.speed = 0
  task.eta = undefined
  task.phase = 'done'
  // 落位路径以**服务端回报**为准(同名会加 ` (n)`,预览算不出那个后缀)。
  task.destination = readUploadPath(response) ?? task.declaredPath
  const relPath = task.destination ?? task.declaredPath
  // 声明用**发出那次请求的快照**:`startTask` 在 `upload.start()` 之前就赋了值,
  // 而 `onSuccess` 只可能在它之后触发 —— 所以这里必非空(断言而非兜底,兜底会
  // 退回读当下表单,反而把后加入文件的落位信息按到这一条的登记上)。
  const declared = task.declaredMeta!
  emit('uploaded', { name: task.name, relPath, size: task.size, meta: declared })
  release(task)
}

function onError(task: UploadTask, error: unknown) {
  // 用户按了暂停/移除而中止的那次,不是错误。
  if (task.ignoreNextError) {
    task.ignoreNextError = false
    return
  }
  task.phase = 'error'
  task.failure = toUploadFailure(error)
  task.speed = 0
  task.eta = undefined
  // 网络/服务端问题都还留着服务端的断点,可以续;元数据错了就得先改再传。
  task.resumable = task.offset > 0 && task.failure.kind !== 'invalid'
  emit('error', { name: task.name, failure: task.failure })
  release(task)
}

// ─────────────────────────────────────────────────────────────
// 行内动作
// ─────────────────────────────────────────────────────────────

async function pauseTask(task: UploadTask) {
  task.phase = 'paused'
  task.speed = 0
  task.eta = undefined
  if (task.upload) {
    task.ignoreNextError = true
    const upload = task.upload
    task.upload = null
    if (activeId.value === task.id) activeId.value = null
    // `false` = 只中断本次请求,**不**删服务端的进度 —— 这正是「断点」。
    try {
      await upload.abort(false)
    } catch {
      // 中止失败无所谓:服务端那边的 offset 就是下次续传的起点。
    }
  }
  release(task)
}

function resumeTask(task: UploadTask) {
  task.failure = null
  task.phase = 'queued'
  // 用户点的是这一条,让它插到前面直接开始,而不是排在队尾。
  if (activeId.value === null && canStart.value) startTask(task)
  else void nextTick(() => maybeStart())
}

function retryTask(task: UploadTask) {
  resumeTask(task)
}

async function removeTask(task: UploadTask) {
  const at = queue.value.findIndex((t) => t.id === task.id)
  if (at >= 0) queue.value.splice(at, 1)
  if (task.upload) {
    task.ignoreNextError = true
    const upload = task.upload
    task.upload = null
    if (activeId.value === task.id) activeId.value = null
    // `true` = 连服务端的进度一起删掉,别在 `.incoming/` 里留孤儿分片。
    try {
      await upload.abort(true)
    } catch {
      // 服务端可能已经清过;删不掉就算了。
    }
  }
  release(task)
}

function clearFinished() {
  queue.value = queue.value.filter((t) => t.phase !== 'done')
}

// ─────────────────────────────────────────────────────────────
// 页面加载:看看有没有上次剩下的
// ─────────────────────────────────────────────────────────────

/**
 * 数一数上次会话留下的未完成上传。
 *
 * 真正的续传发生在**用户重新选入同一个文件**的那一刻(见 `startTask` 里的
 * `findPreviousUploads`):只有拿到文件才算得出指纹,页面加载时还不知道用户要传哪个。
 * 这里只做一件事 —— 让用户知道「有东西没传完,重选一次就能接着传」。
 *
 * `removeFingerprintOnSuccess: true` 保证成功的上传不会留在存储里,
 * 所以留下来的条目就是真的没传完的。
 */
function scanResumable() {
  try {
    if (typeof localStorage === 'undefined') return
    let count = 0
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith('tus::')) count += 1
    }
    resumableCount.value = count
  } catch {
    // 隐私模式等取不到存储,直接不提示。
  }
}

onMounted(scanResumable)

// 落位信息填全了,等在队列里的就可以动起来。
watch(canStart, (ready) => {
  if (ready) void nextTick(() => maybeStart())
})

onBeforeUnmount(() => {
  // 离开页面时把在传的中止掉,保留服务端进度 —— 下次重选同一文件即可续。
  for (const task of queue.value) {
    if (task.upload) {
      task.ignoreNextError = true
      void task.upload.abort(false).catch(() => {})
    }
  }
})

defineExpose({ addFiles: addToQueue })
</script>

<template>
  <div class="flex flex-col">
    <div class="flex flex-col gap-5">
      <UploadDropzone :disabled="disabled" :hint="dropHint" @files="openAddDialog" />

      <MetadataFields
        v-model:meta="meta"
        :filename="previewFilename"
        :problems="problems"
        :disabled="disabled"
      />

      <p v-if="waitingForMeta" class="text-muted-foreground text-xs">
        上面四项填好后,队列会自动开始上传。
      </p>
    </div>

    <!-- 队列:有东西才出现。 -->
    <template v-if="queue.length">
      <div class="bg-muted/40 mt-5 flex items-center justify-between gap-3 border-y px-2 py-2.5">
        <div class="flex items-baseline gap-2">
          <span class="text-sm font-medium">队列</span>
          <span class="text-muted-foreground text-xs tabular-nums">
            {{ doneCount }}/{{ queue.length }} 已完成
            <template v-if="sentBytes > 0">
              · {{ formatBytes(sentBytes) }} / {{ formatBytes(totalBytes) }}
            </template>
          </span>
        </div>
        <Button
          v-if="doneCount > 0"
          variant="ghost"
          size="xs"
          class="text-muted-foreground"
          @click="clearFinished"
        >
          清掉已完成
        </Button>
      </div>

      <ul class="divide-border divide-y">
        <li v-for="task in queue" :key="task.id">
          <UploadItem
            :name="task.name"
            :size="task.size"
            :phase="task.phase"
            :progress="task.progress"
            :offset="task.offset"
            :destination="task.destination"
            :failure="task.failure"
            :speed="task.speed"
            :eta="task.eta"
            :resumable="task.resumable"
            @pause="pauseTask(task)"
            @resume="resumeTask(task)"
            @retry="retryTask(task)"
            @remove="removeTask(task)"
          />
        </li>
      </ul>
    </template>
  </div>

  <!-- 入队前先把落位信息确认掉:确认框里就能看见东西会落到哪。 -->
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>这份文件放到哪里</DialogTitle>
        <DialogDescription>
          落位由服务端按文件库规则裁决;下面填的是声明,填错了会被服务端挡回来。
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <div class="bg-muted/60 rounded-md border px-3 py-2">
          <p class="truncate text-sm font-medium" :title="pendingName">{{ pendingName }}</p>
          <p class="text-muted-foreground mt-0.5 text-xs">
            {{
              pendingFiles.length > 1
                ? `共 ${pendingFiles.length} 份文件,以下声明对它们一起生效`
                : '文件名取自所选文件,原样保留'
            }}
          </p>
        </div>

        <MetadataFields v-model:meta="meta" :filename="pendingName" :problems="problems" />
      </div>

      <DialogFooter>
        <Button variant="outline" @click="dialogOpen = false">取消</Button>
        <Button
          :disabled="!canStart || pendingFiles.some((f) => !isFilenameSafe(f.name))"
          @click="confirmAdd"
        >
          加入队列
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
