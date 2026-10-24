<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { fileNameOf, fileUrl, isPreviewable } from '~~/lib/preview'
import { evidencePageState, evidencePreviewHref } from '~~/lib/roster/evidence-page'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  evidence: { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null; inSelectedSource?: boolean }
  back: string
  previewInPlace?: boolean
}>()
const emit = defineEmits<{ preview: []; 'page-open': [event: MouseEvent] }>()
const availability = ref<'checking' | 'available' | 'missing' | 'unknown'>('checking')
const pageState = computed(() => evidencePageState(props.evidence.sourceFile, props.evidence.page))
const previewHref = computed(() => evidencePreviewHref({ ...props.evidence, back: props.back }))
onMounted(() => watch(() => props.evidence.sourceFile, async (path, _previous, onCleanup) => {
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
  <div class="flex min-w-0 flex-col gap-1 text-[13px] leading-5" data-testid="official-evidence">
    <p class="font-medium break-words [overflow-wrap:anywhere]">{{ fileNameOf(evidence.sourceFile) }}</p>
    <p class="text-muted-foreground break-words [overflow-wrap:anywhere]">原路径：{{ evidence.sourceFile }}</p>
    <p v-if="evidence.attachment" class="break-words [overflow-wrap:anywhere]">附件 / 名单段：{{ evidence.attachment }}</p>
    <p class="text-muted-foreground">
      <span v-if="evidence.listNo != null">序号 {{ evidence.listNo }} · </span>
      <NuxtLink v-if="pageState === 'assigned' && availability !== 'missing'" :to="previewHref" class="text-primary tabular-nums underline underline-offset-2" @click="emit('page-open', $event)">第 {{ evidence.page }} 页</NuxtLink>
      <span v-else-if="pageState === 'assigned'">已记录第 {{ evidence.page }} 页</span>
      <span v-else-if="pageState === 'pending'">页码待核</span>
      <span v-else>这类文件没有可复核的页码</span>
      <span v-if="evidence.inSelectedSource === false"> · 未选入本次范围</span>
    </p>
    <p v-if="availability === 'missing'" class="text-muted-foreground">文件不可用；出处与已记录页码保留。</p>
    <p v-else-if="availability === 'unknown'" class="text-muted-foreground">暂无法确认文件是否可用。</p>
    <div v-if="availability !== 'missing'" class="flex flex-wrap items-center gap-2">
      <template v-if="isPreviewable(evidence.sourceFile)">
        <Button v-if="previewInPlace" variant="outline" size="sm" @click="emit('preview')">查看原文件</Button>
        <NuxtLink v-else :to="previewHref" class="text-primary underline underline-offset-2" @click="emit('page-open', $event)">查看原文件</NuxtLink>
      </template>
      <a v-else :href="fileUrl(evidence.sourceFile)" target="_blank" rel="noopener" class="text-primary underline underline-offset-2">下载原文件</a>
    </div>
  </div>
</template>
