<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { fileNameOf, fileUrl, isPreviewable } from '#core/lib/preview'
import { evidencePageState, evidencePreviewHref } from '#sme-roster/lib/roster/evidence-page'
import { publishedNameText, type OfficialPublishedFact } from '#sme-roster/lib/roster/official-evidence-display'
import { Button } from '#core/app/components/ui/button'
import { FileText, ArrowUpRight, Download } from '@lucide/vue'

const props = defineProps<{
  evidence: { publishedName?: OfficialPublishedFact; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }
  back: string
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
  <div class="bg-muted/25 flex h-full min-w-0 flex-col gap-2 rounded-md border border-border/60 px-3.5 py-3 text-sm leading-5" data-testid="official-evidence">
    <div class="flex items-start gap-2.5">
      <FileText class="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="font-medium break-words [overflow-wrap:anywhere]">{{ fileNameOf(evidence.sourceFile) }}</p>
        <p v-if="evidence.publishedName" class="text-muted-foreground mt-0.5 text-xs break-words [overflow-wrap:anywhere]" data-testid="published-name">{{ publishedNameText(evidence.publishedName) }}</p>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
      <span v-if="evidence.attachment" class="text-muted-foreground wrap-anywhere">附件：{{ evidence.attachment }}</span>
      <span v-if="evidence.listNo != null" class="bg-card rounded-sm border px-1.5 py-0.5 font-medium tabular-nums">序号 {{ evidence.listNo }}</span>
      <Button v-if="pageState === 'assigned' && availability === 'available'" as-child variant="secondary" size="xs"><NuxtLink :to="previewHref" :data-evidence-return-focus="focusKey + 'page'" class="tabular-nums" @click="emit('page-open', $event)">第 {{ evidence.page }} 页<ArrowUpRight aria-hidden="true" /></NuxtLink></Button>
      <span v-else-if="pageState === 'assigned'" class="text-muted-foreground tabular-nums">已记录第 {{ evidence.page }} 页</span>
      <span v-else-if="pageState === 'pending'" class="text-muted-foreground">页码待核</span>
      <span v-else class="text-muted-foreground">这类文件没有可复核的页码</span>
      <template v-if="availability === 'available'">
        <Button v-if="isPreviewable(evidence.sourceFile)" variant="outline" size="xs" @click="emit('preview')">查看原文件<ArrowUpRight aria-hidden="true" /></Button>
        <Button v-else as-child variant="outline" size="xs"><a :href="fileUrl(evidence.sourceFile)" target="_blank" rel="noopener">下载原文件<Download aria-hidden="true" /></a></Button>
      </template>
    </div>

    <p v-if="availability === 'checking'" role="status" class="text-muted-foreground text-xs">正在确认文件可用性…</p>
    <p v-else-if="availability === 'missing'" class="text-muted-foreground text-xs">文件不可用；出处与已记录页码保留。</p>
    <div v-else-if="availability === 'unknown'" class="flex flex-wrap items-center gap-2 text-xs">
      <span class="text-muted-foreground">暂无法确认文件是否可用。</span>
      <Button variant="outline" size="xs" @click="checkAttempt++">重新检查文件</Button>
    </div>

    <p class="text-muted-foreground mt-auto truncate font-mono text-xs" :title="evidence.sourceFile">原路径：{{ evidence.sourceFile }}</p>
  </div>
</template>
