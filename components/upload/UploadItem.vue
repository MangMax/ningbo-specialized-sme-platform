<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Check, CircleAlert, Copy, FileText, Pause, Play, RotateCw, X } from '@lucide/vue'
import { Badge } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import { Progress } from '#core/app/components/ui/progress'
import type { UploadFailure, UploadPhase } from '@/lib/upload'
import { formatBytes } from '@/lib/core/file-size'

/**
 * 队列里的一行。整行的重心只有一个 —— **这件事现在到了哪一步**:
 * 状态标签在右上,进度条在中段,文件名最大。
 *
 * 状态用**形状**分开,不只靠颜色:完成是浅色方标 + 一条满格的进度条;
 * 失败才出现红色文字。一行只有一个红点,不叠容器。
 */
const props = withDefaults(
  defineProps<{
    name: string
    size: number
    phase: UploadPhase
    /** 0–100。 */
    progress?: number
    /** 已发字节,用于「12.3 / 48.0 MB」。 */
    offset?: number
    /** 服务端回报的落位路径(相对文件库根)。 */
    destination?: string | null
    failure?: UploadFailure | null
    /** 平均速度,字节/秒。拿不到时 0。 */
    speed?: number
    /** 「约 1 分 20 秒」。 */
    eta?: string
    /** 该文件在上次会话里留下过未完成的上传。 */
    resumable?: boolean
  }>(),
  {
    progress: 0,
    offset: 0,
    destination: null,
    failure: null,
    speed: 0,
    eta: undefined,
    resumable: false,
  },
)

const emit = defineEmits<{
  (e: 'pause'): void
  (e: 'resume'): void
  (e: 'retry'): void
  (e: 'remove'): void
}>()

/** 状态标签的文案与变体。变体取自 `badgeVariants`,不自造颜色。 */
const badge = computed<{ label: string; variant: 'default' | 'outline' | 'quiet' | 'destructive' }>(
  () => {
    switch (props.phase) {
      case 'uploading':
        return { label: '上传中', variant: 'default' }
      case 'paused':
        return { label: '已暂停', variant: 'outline' }
      case 'done':
        return { label: '已完成', variant: 'quiet' }
      case 'error':
        return { label: '未完成', variant: 'destructive' }
      default:
        return { label: '排队中', variant: 'outline' }
    }
  },
)

const percent = computed(() => Math.max(0, Math.min(100, Math.round(props.progress))))
const showBar = computed(
  () => props.phase === 'uploading' || props.phase === 'paused' || props.phase === 'queued',
)

/** 速度与剩余时间:只在真正在传、且样本够了才显示,免得闪。 */
const pace = computed(() => {
  if (props.phase !== 'uploading') return undefined
  const parts: string[] = []
  if (props.speed > 0) parts.push(`${formatBytes(props.speed)}/s`)
  if (props.eta) parts.push(props.eta)
  return parts.length ? parts.join(' · ') : undefined
})

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

/** 复制落位路径:方便直接贴进 pipeline 或记录里。 */
async function copyPath() {
  if (!props.destination) return
  try {
    await navigator.clipboard.writeText(props.destination)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1500)
  } catch {
    // 剪贴板被拒(非安全上下文 / 无权限)时不弹错:路径本身摆在眼前,可以手选。
  }
}

onBeforeUnmount(() => clearTimeout(copiedTimer))
</script>

<template>
  <div class="flex flex-col gap-2.5 px-4 py-3.5">
    <!-- 头部:文件名占满左边,状态标签钉在右上。 -->
    <div class="flex items-start gap-3">
      <FileText aria-hidden="true" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <p class="truncate text-sm font-medium" :title="name">{{ name }}</p>
        <p class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span class="tabular-nums">{{ formatBytes(size) }}</span>
          <!-- 在传/暂停时补上百分比与速度;完成、出错时大小已经在上一个字里,不再重复。 -->
          <template v-if="showBar">
            <span aria-hidden="true">·</span>
            <span class="tabular-nums">{{ percent }}%</span>
            <template v-if="pace">
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">{{ pace }}</span>
            </template>
          </template>
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <Badge :variant="badge.variant" class="shrink-0">{{ badge.label }}</Badge>

        <Button
          v-if="phase === 'uploading'"
          variant="ghost"
          size="icon-xs"
          aria-label="暂停上传"
          title="暂停上传"
          @click="emit('pause')"
        >
          <Pause />
        </Button>
        <Button
          v-else-if="phase === 'paused'"
          variant="ghost"
          size="icon-xs"
          aria-label="继续上传"
          title="继续上传"
          @click="emit('resume')"
        >
          <Play />
        </Button>
        <Button
          v-else-if="phase === 'error'"
          variant="ghost"
          size="icon-xs"
          aria-label="重试"
          title="重试"
          @click="emit('retry')"
        >
          <RotateCw />
        </Button>
        <Button
          v-else
          variant="ghost"
          size="icon-xs"
          :aria-label="phase === 'queued' ? '移出队列' : '从队列移除'"
          :title="phase === 'queued' ? '移出队列' : '从队列移除'"
          @click="emit('remove')"
        >
          <X />
        </Button>
      </div>
    </div>

    <!-- 进度条:排队时是空槽,传起来才填。 -->
    <Progress v-if="showBar" :model-value="percent" class="h-1.5" />

    <!-- 落位路径:传成功后告诉用户「东西放哪了」。等宽字体,便于核对。 -->
    <div
      v-if="phase === 'done' && destination"
      class="bg-muted/60 flex items-center gap-2 rounded-md border px-2.5 py-1.5"
    >
      <span class="text-muted-foreground shrink-0 text-xs">落位</span>
      <code class="min-w-0 flex-1 truncate font-mono text-xs" :title="destination">
        {{ destination }}
      </code>
      <Button
        variant="ghost"
        size="icon-xs"
        :aria-label="copied ? '已复制' : '复制路径'"
        :title="copied ? '已复制' : '复制路径'"
        @click="copyPath"
      >
        <Check v-if="copied" class="text-primary" />
        <Copy v-else />
      </Button>
    </div>

    <!-- 断点续传的提示:只在真的能续时说一句,不喊第二次。 -->
    <p
      v-if="resumable && (phase === 'paused' || phase === 'error')"
      class="text-muted-foreground text-xs"
    >
      上次传到 {{ percent }}%,点「{{ phase === 'error' ? '重试' : '继续' }}」会从断点接着传。
    </p>

    <!--
      错误态:一块**没有边框、没有底色**的行内说明。这一行已经有一枚「未完成」标签和
      一个重试按钮在交代状态,再套一个告警盒子就把它变成卡片里套卡片 —— 红色本身就够
      引人,不必再加一层容器。主次靠字重分开,不靠颜色深浅(深色下 /90 会掉到 4.25:1)。
    -->
    <div v-if="phase === 'error' && failure" class="text-destructive flex items-start gap-2">
      <CircleAlert aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
      <div class="flex min-w-0 flex-col gap-0.5 text-xs">
        <p class="font-medium">{{ failure.message }}</p>
        <p v-if="failure.detail">{{ failure.detail }}</p>
      </div>
    </div>
  </div>
</template>
