<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { fileNameOf, fileUrl, isPreviewable } from '#core/lib/preview'
import { evidencePageState, evidencePreviewHref } from '~~/lib/roster/evidence-page'
import { publishedNameText, type OfficialPublishedFact } from '#sme-roster/lib/roster/correspondence-view'
import { Button } from '#core/app/components/ui/button'
import { FileText, ArrowUpRight, Download } from '@lucide/vue'

const props = defineProps<{
  evidence: { publishedName?: OfficialPublishedFact; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null; inSelectedSource?: boolean }
  back: string
  previewInPlace?: boolean
}>()
const emit = defineEmits<{ preview: []; 'page-open': [event: MouseEvent] }>()
const checkAttempt = ref(0)
const availability = ref<'checking' | 'available' | 'missing' | 'unknown'>('checking')
const pageState = computed(() => evidencePageState(props.evidence.sourceFile, props.evidence.page))
const focusKey = computed(() => JSON.stringify([props.evidence.sourceFile, props.evidence.attachment, props.evidence.listNo, props.evidence.page]))
const previewHref = computed(() => evidencePreviewHref({ ...props.evidence, back: props.back }))
onMounted(() => watch([() => props.evidence.sourceFile, checkAttempt], async ([path], _previous, onCleanup) => {
  const controller = new AbortController()
  let current = true
  onCleanup(() => { current = false; controller.abort() })
  availability.value = 'checking'
  try {
    // HEAD checks availability without loading PDF/Office bytes or mutating metadata.
    const response = await fetch(fileUrl(path), { method: 'HEAD', signal: controller.signal })
    if (current) availability.value = response.ok ? 'available' : response.status === 404 ? 'missing' : 'unknown'
  } catch { if (current) availability.value = 'unknown' }
}, { immediate: true }))
</script>

<template>
  <div class="bg-muted/25 flex h-full min-w-0 flex-col gap-3 rounded-lg border p-4 text-base leading-6" data-testid="official-evidence">
    <div class="flex items-start gap-3">
      <span class="bg-card text-primary flex size-9 shrink-0 items-center justify-center rounded-md border"><FileText class="size-5" aria-hidden="true" /></span>
      <div class="min-w-0 flex-1">
        <p class="font-medium break-words [overflow-wrap:anywhere]">{{ fileNameOf(evidence.sourceFile) }}</p>
        <p v-if="evidence.publishedName" class="text-muted-foreground mt-1 text-sm break-words [overflow-wrap:anywhere]" data-testid="published-name">{{ publishedNameText(evidence.publishedName) }}</p>
      </div>
    </div>
    <dl v-if="evidence.attachment" class="grid min-w-0 gap-1 text-sm">
      <dt class="text-muted-foreground">附件 / 名单段</dt>
      <dd class="text-base break-words [overflow-wrap:anywhere]">{{ evidence.attachment }}</dd>
    </dl>
    <div class="mt-auto flex flex-wrap items-center gap-2 text-sm">
      <span v-if="evidence.listNo != null" class="bg-card rounded-md border px-2.5 py-1 tabular-nums">序号 {{ evidence.listNo }}</span>
      <Button v-if="pageState === 'assigned' && availability === 'available'" as-child variant="secondary" size="sm"><NuxtLink :to="previewHref" :data-evidence-return-focus="focusKey + 'page'" class="tabular-nums" @click="emit('page-open', $event)">第 {{ evidence.page }} 页<ArrowUpRight aria-hidden="true" /></NuxtLink></Button>
      <span v-else-if="pageState === 'assigned'">已记录第 {{ evidence.page }} 页</span>
      <span v-else-if="pageState === 'pending'">页码待核</span>
      <span v-else>这类文件没有可复核的页码</span>
      <span v-if="evidence.inSelectedSource === false"> · 未选入本次范围</span>
      <div v-if="availability === 'available'" class="flex flex-wrap items-center gap-2">
        <template v-if="isPreviewable(evidence.sourceFile)">
          <Button v-if="previewInPlace" variant="outline" size="sm" @click="emit('preview')">查看原文件<ArrowUpRight aria-hidden="true" /></Button>
          <Button v-else as-child variant="outline" size="sm"><NuxtLink :to="previewHref" :data-evidence-return-focus="focusKey + 'file'" @click="emit('page-open', $event)">查看原文件<ArrowUpRight aria-hidden="true" /></NuxtLink></Button>
        </template>
        <Button v-else as-child variant="outline" size="sm"><a :href="fileUrl(evidence.sourceFile)" target="_blank" rel="noopener">下载原文件<Download aria-hidden="true" /></a></Button>
      </div>
    </div>
    <p v-if="availability === 'checking'" role="status" class="text-muted-foreground text-sm">正在确认文件可用性…</p>
    <p v-if="availability === 'missing'" class="text-muted-foreground">文件不可用；出处与已记录页码保留。</p>
    <p v-else-if="availability === 'unknown'" class="text-muted-foreground">暂无法确认文件是否可用。</p>
    <Button v-if="availability === 'unknown'" variant="outline" size="sm" @click="checkAttempt++">重新检查文件</Button>

    <p class="text-muted-foreground border-t pt-2 text-sm break-words [overflow-wrap:anywhere]">原路径：{{ evidence.sourceFile }}</p>
  </div>
</template>
