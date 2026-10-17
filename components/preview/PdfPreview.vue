<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch, onBeforeUnmount } from 'vue'
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Download, Maximize, Minimize, SlidersHorizontal } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import PdfEngine from './PdfEngine.vue'
import type { PdfReadingPosition, PdfPositionEvent, PdfReadyEvent, PdfNavigationRequest } from '~~/lib/pdf-reader'

const props = withDefaults(defineProps<{ src: string; name?: string; targetPage?: number; targetPosition?: PdfReadingPosition }>(), { name: '' })
const emit = defineEmits<{ ready: [event: PdfReadyEvent]; 'position-change': [event: PdfPositionEvent]; error: [message: string]; 'navigation-request': [event: PdfNavigationRequest] }>()
const engine = useTemplateRef('engine')
const shell = useTemplateRef<HTMLElement>('shell')
const title = computed(() => props.name || props.src.split('/').pop() || 'PDF 文档')
const status = shallowRef<'loading' | 'ready' | 'error'>('loading')
const total = shallowRef(0)
const current = shallowRef<PdfReadingPosition | null>(null)
const input = shallowRef('')
const message = shallowRef('')
const tools = shallowRef(false)
const retry = shallowRef(0)
const fullscreen = shallowRef(false)
const pending = shallowRef<PdfReadingPosition | null>(null)
const past = shallowRef<PdfReadingPosition[]>([])
const future = shallowRef<PdfReadingPosition[]>([])
type Navigation = { position: PdfReadingPosition; reason: 'external' | 'explicit' | 'history'; direction?: 'back' | 'forward'; from: PdfReadingPosition | null }
let flight: Navigation | null = null
let queued: Navigation | null = null
let lastTarget: PdfReadingPosition | null = null
// Every document/retry owns its callbacks. Late events from a destroyed engine are inert.
const session = computed(() => ({ src: props.src, retry: retry.value }))
const handlers = computed(() => {
  const owner = session.value
  return {
    ready: ({ totalPages }: { totalPages: number }) => {
      if (owner !== session.value || status.value === 'error') return
      total.value = totalPages
      status.value = 'ready'
      emit('ready', { src: owner.src, totalPages })
      if (pending.value) send(pending.value)
    },
    position: (position: PdfReadingPosition) => {
      if (owner !== session.value || status.value !== 'ready') return
      // A request is not a visit until the engine reports its rendered destination.
      if (flight?.position.page === position.page) {
        if (flight.reason === 'explicit' && flight.from &&
          JSON.stringify(flight.from) !== JSON.stringify(position)) {
          past.value = [...past.value, flight.from].slice(-100)
          future.value = []
        } else if (flight.reason === 'history' && flight.from) {
          if (flight.direction === 'back') {
            past.value = past.value.slice(0, -1)
            future.value = [...future.value, flight.from]
          } else {
            future.value = future.value.slice(0, -1)
            past.value = [...past.value, flight.from]
          }
        }
        flight = null
      }
      current.value = position
      input.value = String(position.page)
      emit('position-change', { src: owner.src, ...position })
    },
    error: (error: string) => { if (owner === session.value) fail(error) },
  }
})
watch(session, (value, previous) => {
  status.value = 'loading'; total.value = 0; current.value = null; input.value = ''; message.value = ''
  if (!previous || value.src !== previous.src) lastTarget = props.targetPosition ?? (props.targetPage === undefined ? null : { page: props.targetPage })
  flight = null; queued = null
  if (!previous || value.src !== previous.src) { past.value = []; future.value = [] }
  pending.value = lastTarget
}, { immediate: true, flush: 'sync' })
watch(() => [props.targetPage, props.targetPosition] as const, () => {
  const target = props.targetPosition ?? (props.targetPage === undefined ? null : { page: props.targetPage })
  if (target) navigate(target)
}, { flush: 'post' })
function fail(error: string) { status.value = 'error'; message.value = error; emit('error', error) }
function valid(position: PdfReadingPosition) {
  if (!Number.isInteger(position.page) || position.page < 1 || position.page > total.value) {
    message.value = `请输入 1 至 ${total.value} 的整数页码。`
    emit('error', message.value)
    return false
  }
  return true
}
function send(position: PdfReadingPosition) {
  pending.value = null
  const request = queued
  queued = null
  if (valid(position)) {
    lastTarget = position; message.value = ''
    flight = request ?? { position, reason: 'external', from: current.value }
    if (flight.reason !== 'external') emit('navigation-request', { src: props.src, ...position, reason: flight.reason })
    engine.value?.navigate(position)
  } else flight = null
}
function navigate(position: PdfReadingPosition, reason: Navigation['reason'] = 'external', direction?: Navigation['direction']) {
  queued = { position, reason, direction, from: current.value }
  lastTarget = position
  pending.value = position
  if (status.value === 'ready') send(position)
}
function explicitNavigate(position: PdfReadingPosition) { navigate(position, 'explicit') }
function revisit(direction: 'back' | 'forward') {
  const position = (direction === 'back' ? past.value : future.value).at(-1)
  if (position) navigate(position, 'history', direction)
}
function submit() {
  if (!/^\d+$/.test(input.value)) { message.value = `请输入 1 至 ${total.value} 的整数页码。`; return }
  explicitNavigate({ page: Number(input.value) })
}
function keydown(event: KeyboardEvent) {
  if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"],button,[role="tab"]') || event.ctrlKey || event.metaKey || event.altKey) return
  const page = current.value?.page ?? 1
  const target = { ArrowLeft: page - 1, ArrowRight: page + 1, Home: 1, End: total.value }[event.key]
  if (target !== undefined && status.value === 'ready') { event.preventDefault(); explicitNavigate({ page: target }) }
}
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await shell.value?.requestFullscreen()
  } catch { message.value = '浏览器未允许全屏，可继续阅读。' }
}
function fullscreenChanged() { fullscreen.value = document.fullscreenElement === shell.value }
document.addEventListener('fullscreenchange', fullscreenChanged)
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', fullscreenChanged))
defineExpose({ navigate })
</script>

<template>
  <section ref="shell" data-preview-shell tabindex="0" aria-label="PDF 阅读器" class="bg-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border" @keydown="keydown">
    <div role="toolbar" aria-label="PDF 查阅" class="flex flex-wrap items-center gap-1 border-b p-2">
      <span :title="title" class="min-w-0 flex-1 truncate px-1 text-sm font-medium">{{ title }}</span>
      <Button variant="ghost" size="icon-sm" aria-label="阅读工具" :aria-expanded="tools" @click="tools = !tools"><SlidersHorizontal /></Button>
      <Button variant="ghost" size="icon-sm" as-child><a :href="src" :download="title" aria-label="下载原文"><Download /></a></Button>
      <Button variant="ghost" size="icon-sm" :aria-label="fullscreen ? '退出全屏' : '全屏阅读'" @click="toggleFullscreen"><Minimize v-if="fullscreen" /><Maximize v-else /></Button>
      <div role="group" aria-label="文档内阅读位置" class="flex shrink-0 items-center gap-1 border-l pl-2">
        <span class="text-muted-foreground text-xs">位置历史</span>
        <Button variant="ghost" size="icon-sm" aria-label="阅读位置后退" title="阅读位置后退" :disabled="status !== 'ready' || !past.length" @click="revisit('back')"><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="阅读位置前进" title="阅读位置前进" :disabled="status !== 'ready' || !future.length" @click="revisit('forward')"><ChevronRight /></Button>
      </div>
      <div class="flex w-full items-center justify-center gap-1 sm:w-auto" role="group" aria-label="实际 PDF 页码">
        <Button variant="ghost" size="icon-sm" aria-label="首页" :disabled="status !== 'ready' || current?.page === 1" @click="explicitNavigate({ page: 1 })"><ChevronFirst /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="上一页" :disabled="status !== 'ready' || !current || current.page <= 1" @click="explicitNavigate({ page: (current?.page ?? 1) - 1 })"><ChevronLeft /></Button>
        <form class="flex items-center gap-1" @submit.prevent="submit">
          <Input v-model="input" aria-label="跳转页码" inputmode="numeric" :aria-invalid="!!message" :disabled="status !== 'ready'" class="w-14 text-center tabular-nums" />
          <output aria-label="当前实际页" class="text-muted-foreground whitespace-nowrap text-sm tabular-nums">{{ current?.page ?? '—' }} / {{ total || '—' }}</output>
          <Button variant="ghost" size="sm" :disabled="status !== 'ready'" type="submit">跳转</Button>
        </form>
        <Button variant="ghost" size="icon-sm" aria-label="下一页" :disabled="status !== 'ready' || !current || current.page >= total" @click="explicitNavigate({ page: (current?.page ?? 1) + 1 })"><ChevronRight /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="末页" :disabled="status !== 'ready' || current?.page === total" @click="explicitNavigate({ page: total })"><ChevronLast /></Button>
      </div>
    </div>
    <div v-if="message" role="alert" class="text-destructive px-3 py-2 text-sm">{{ message }}</div>
    <div v-if="status === 'error'" class="flex flex-1 flex-col items-center justify-center gap-3"><Button variant="outline" @click="retry++">重试读取 PDF</Button></div>
    <template v-else>
      <p v-if="status === 'loading'" role="status" class="text-muted-foreground px-3 py-2 text-sm">正在读取 PDF…</p>
      <PdfEngine :key="`${session.src}:${session.retry}`" ref="engine" :src="src" :tools="tools" @ready="handlers.ready" @position="handlers.position" @navigate="explicitNavigate" @error="handlers.error" />
    </template>
  </section>
</template>
