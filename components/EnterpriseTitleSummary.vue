<script setup lang="ts">
import { computed, ref } from 'vue'
import { TITLES, TITLE_SHORT, TITLE_RANK } from '~~/lib/labels'
import { Badge, type BadgeVariants } from '@/components/ui/badge'
import { HoverCard, HoverCardTrigger } from '@/components/ui/hover-card'
import TableHoverCardContent from './TableHoverCardContent.vue'

const props = defineProps<{
  titles: string[]
  firstRecognition: { titleCode: string; year: number }[]
  awards?: { titleCode: string; year: number | null; batchSeq: number | null }[]
}>()
const open = ref(false)
const items = computed(() => props.titles.flatMap((code) => {
  const awards = props.awards?.filter((item) => item.titleCode === code) ?? []
  return awards.length ? awards : [{ titleCode: code, year: props.firstRecognition.find((item) => item.titleCode === code)?.year ?? null, batchSeq: null }]
}))
const batch = (item: typeof items.value[number]) => `${item.year ?? '年待核'}${item.batchSeq == null ? '' : `-${item.batchSeq}`}`
const variant = (code: string): BadgeVariants['variant'] => {
  const rank = TITLE_RANK[code]
  return rank != null && rank <= 3 ? `tier-${rank}` as BadgeVariants['variant'] : 'quiet'
}
</script>

<template>
  <span v-if="!items.length" class="text-muted-foreground">—</span>
  <HoverCard v-else v-model:open="open" :open-delay="120" :close-delay="120">
    <HoverCardTrigger as-child>
      <button
        type="button"
        class="focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 flex max-w-full flex-wrap items-center gap-1 rounded-sm text-left transition-[color,background-color,transform] duration-150 ease-snap hover:opacity-80"
        data-testid="title-recognition-list"
        aria-label="查看全部称号年份批次"
        @click.stop="open = true"
      >
        <Badge :variant="variant(items[0]!.titleCode)" class="inline-flex max-w-full whitespace-nowrap px-1 py-0 text-table leading-[18px] font-normal" data-testid="title-recognition-pair" :data-title-code="items[0]!.titleCode">
          {{ TITLE_SHORT[items[0]!.titleCode] ?? items[0]!.titleCode }}
          <span class="tabular-nums">{{ batch(items[0]!) }}</span>
        </Badge>
        <Badge v-if="items.length > 1" variant="quiet" class="py-0 text-table leading-[18px] tabular-nums" data-testid="title-overflow-trigger">+{{ items.length - 1 }}</Badge>
      </button>
    </HoverCardTrigger>
    <TableHoverCardContent @click.stop>
      <div class="mb-2 text-sm font-medium">称号 · 年份批次</div>
      <div class="flex flex-wrap gap-1.5" data-testid="all-title-awards">
        <Badge v-for="(item, index) in items" :key="index" :variant="variant(item.titleCode)" class="whitespace-normal text-table font-normal">
          {{ TITLES[item.titleCode] ?? item.titleCode }} {{ batch(item) }}
        </Badge>
      </div>
    </TableHoverCardContent>
  </HoverCard>
</template>
