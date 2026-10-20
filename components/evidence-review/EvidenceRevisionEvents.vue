<script setup lang="ts">
import { useBoundedReviewPage } from '~/composables/useBoundedReviewPage'
import { Button } from '@/components/ui/button'
import TableFailureState from '@/components/TableFailureState.vue'
import { TITLES } from '~~/lib/labels'
import DisclosurePanel from '@/components/DisclosurePanel.vue'

const props = defineProps<{ revisionId: number; enterpriseId: number }>()
type Event = { eventId: number; enterpriseId: number; titleCode: string }
const { displayed, cursorExpired, loading, error, reload, restart, next, previous, canNext, canPrevious } = useBoundedReviewPage<Event>('evidence-revision-events', () => `/api/roster/evidence-impacts/revisions/${props.revisionId}/events`, () => ({ enterpriseId: props.enterpriseId }))
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2 border-t pt-2">
    <p v-if="loading" role="status" class="text-muted-foreground text-[13px]">正在读取关联事件…</p>
    <TableFailureState
      v-if="error"
      title="关联事件读取失败"
      :description="`读取目标：修订 #${revisionId} · 事件第 ${displayed?.pageNumber ?? 1} 页。上次成功页仍保留。`"
      :pending="loading"
      @retry="reload()"
    />
    <p v-if="cursorExpired" role="alert" class="text-[13px] leading-5">
      分页快照已过期或失效。上次成功页仍保留；请点击“重新读取事件”获取当前结果。
    </p>
    <p v-if="displayed" class="text-muted-foreground text-[13px] leading-5">
      关联事件 · 修订 #{{ revisionId }} · 第 {{ displayed.pageNumber }} 页
    </p>
    <p v-if="displayed && !displayed.rows.length" class="text-muted-foreground text-[13px] leading-5">
      本页没有关联事件，不据此推断其他范围。
    </p>

    <ul v-if="displayed?.rows.length" class="flex flex-col gap-1">
      <li v-for="event in displayed.rows" :key="event.eventId" class="min-w-0">
        <NuxtLink
          :to="`/enterprises/${event.enterpriseId}?tab=records&eventId=${event.eventId}&titleCode=${event.titleCode}`"
          data-testid="revision-event-link"
          class="text-primary text-[13px] leading-5 break-words hover:underline"
        >
          定位「{{ TITLES[event.titleCode] ?? '正式事件' }}」的正式事件
        </NuxtLink>
        <DisclosurePanel compact keep-mounted content-class="pb-0" class="text-muted-foreground text-[13px] leading-5">
          <template #trigger><span>技术详情</span></template>
          <p>企业 #{{ event.enterpriseId }} · 事件 #{{ event.eventId }} · 称号键 {{ event.titleCode }}</p>
        </DisclosurePanel>
      </li>
    </ul>

    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" :disabled="!canPrevious" @click="previous">上一页事件</Button>
      <Button size="sm" variant="outline" :disabled="!canNext" @click="next">下一页事件</Button>
      <Button size="sm" variant="ghost" :disabled="loading" @click="restart">重新读取事件</Button>
    </div>
  </div>
</template>
