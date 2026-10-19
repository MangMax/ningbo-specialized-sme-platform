<script setup lang="ts">
import { useBoundedReviewPage } from '~/composables/useBoundedReviewPage'
import { Button } from '@/components/ui/button'
import TableFailureState from '@/components/TableFailureState.vue'
const props = defineProps<{ revisionId: number; enterpriseId: number }>()
type Event = { eventId: number; enterpriseId: number; titleCode: string }
const { displayed, loading, error, reload, restart, next, previous, canNext, canPrevious } = useBoundedReviewPage<Event>('evidence-revision-events', () => `/api/roster/evidence-impacts/revisions/${props.revisionId}/events`, () => ({ enterpriseId: props.enterpriseId }))
</script>
<template>
  <div class="flex min-w-0 flex-col gap-2">
    <p v-if="loading" role="status">正在读取关联事件…</p>
    <TableFailureState v-if="error" title="关联事件读取失败" :pending="loading" @retry="reload()" />
    <p v-if="displayed" class="text-muted-foreground">关联事件 · 修订 #{{ displayed.request.url.split('/').at(-2) }} · 第 {{ displayed.pageNumber }} 页</p>
    <p v-if="displayed && !displayed.rows.length">本页没有关联事件，不据此推断其他范围。</p>
    <NuxtLink v-for="event in displayed?.rows ?? []" :key="event.eventId" :to="`/enterprises/${event.enterpriseId}?eventId=${event.eventId}&titleCode=${event.titleCode}`" data-testid="revision-event-link" class="break-words text-primary hover:underline">定位企业 #{{ event.enterpriseId }} · 事件 #{{ event.eventId }}</NuxtLink>
    <div class="flex flex-wrap gap-2"><Button size="sm" variant="outline" :disabled="!canPrevious" @click="previous">上一页事件</Button><Button size="sm" variant="outline" :disabled="!canNext" @click="next">下一页事件</Button><Button size="sm" variant="ghost" :disabled="loading" @click="restart">重新读取事件</Button></div>
  </div>
</template>
