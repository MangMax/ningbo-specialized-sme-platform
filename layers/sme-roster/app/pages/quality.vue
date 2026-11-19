<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed } from 'vue'
import { orderBy } from 'es-toolkit'
import { Button } from '#core/app/components/ui/button'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'
import { Card, CardContent, CardHeader, CardTitle } from '#core/app/components/ui/card'
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#core/app/components/ui/empty'
import { CheckCircle2 } from '@lucide/vue'
import { Skeleton } from '#core/app/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#core/app/components/ui/table'

interface QualitySample {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
}
interface QualityGroup {
  kind: string
  label: string
  n: number
  samples: QualitySample[]
}

const apiGet = $fetch as unknown as <T>(
  url: string,
  opts?: { retry?: number },
) => Promise<T>

const { data, error, isLoading, refetch } = useQuery({
  key: () => ['quality'],
  query: () => apiGet<QualityGroup[]>('/api/quality', { retry: 0 }),
})

const categoryLabels: Record<string, string> = {
  uscc_missing: '缺少统一社会信用代码',
  name_ambiguous: '同名企业',
  district_off_city: '属地不在宁波',
}
const groups = computed(() => orderBy((data.value ?? []).filter(group => group.n > 0), [group => group.n], ['desc']))

const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-10 h-9 text-xs font-medium'
</script>

<template>
  <div class="flex flex-col gap-5" :aria-busy="isLoading">
    <PageHeader title="数据质量" />

    <div v-if="isLoading || error" class="relative">
      <TableLoadingStatus kind="ledger" :loading="isLoading" label="正在加载质量清单…" />
      <TableFailureState
        v-if="error"
        title="质量清单加载失败"
        :compact="Boolean(data)"
        :description="data ? '显示上次加载的质量清单。' : '暂时无法确认是否有待核对项。'"
        :pending="isLoading"
        @retry="refetch()"
      />
    </div>

    <nav v-if="groups.length > 1" aria-label="待核对类别" class="flex flex-wrap gap-2">
      <Button v-for="group in groups" :key="group.kind" as-child variant="outline" size="sm">
        <a :href="`#q-${group.kind}`">{{ categoryLabels[group.kind] ?? group.label }}</a>
      </Button>
    </nav>

    <Card v-if="isLoading && !data" class="gap-0 py-0">
      <CardContent class="flex flex-col gap-3 p-5">
        <Skeleton class="h-5 w-48" />
        <Skeleton class="h-40 w-full" />
      </CardContent>
    </Card>

    <Empty v-else-if="data && !groups.length">
      <EmptyHeader>
        <EmptyMedia variant="icon"><CheckCircle2 /></EmptyMedia>
        <EmptyTitle>没有待核对项</EmptyTitle>
      </EmptyHeader>
    </Empty>

    <Card
      v-for="g in groups"
      :id="`q-${g.kind}`"
      :key="g.kind"
      class="scroll-mt-20 gap-0 overflow-hidden py-0"
    >
      <CardHeader class="gap-1 border-b px-5 py-4">
        <div class="flex items-baseline justify-between gap-3">
          <CardTitle class="text-base font-medium">{{ categoryLabels[g.kind] ?? g.label }}</CardTitle>
          <span class="text-primary shrink-0 text-sm font-medium whitespace-nowrap tabular-nums">
            {{ g.n.toLocaleString('zh-CN') }} 家
          </span>
        </div>
        <p v-if="g.samples.length < g.n" class="text-muted-foreground text-sm">
          显示前 {{ g.samples.length }} 家
        </p>
      </CardHeader>
      <CardContent class="p-0">
        <Table class="data-table">
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead :class="TH_CLASS">企业名称</TableHead>
              <TableHead :class="[TH_CLASS, 'hidden w-40 sm:table-cell']">统一社会信用代码</TableHead>
              <TableHead :class="[TH_CLASS, 'w-20']">区县</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="s in g.samples"
              :key="s.enterpriseId"
            >
              <TableCell class="min-w-0 whitespace-normal">
                <NuxtLink
                  :to="`/enterprises/${s.enterpriseId}`"
                  class="hover:text-primary font-medium break-words hover:underline"
                >
                  {{ s.name }}
                </NuxtLink>
                <span v-if="s.uscc" class="text-muted-foreground block font-mono text-xs wrap-anywhere sm:hidden">
                  {{ s.uscc }}
                </span>
              </TableCell>
              <TableCell
                class="hidden font-mono text-xs sm:table-cell"
                :class="s.uscc ? 'text-muted-foreground' : 'text-destructive'"
              >
                {{ s.uscc ?? '缺失' }}
              </TableCell>
              <TableCell class="text-muted-foreground text-xs">{{ s.district ?? '—' }}</TableCell>
            </TableRow>
            <TableRow v-if="g.samples.length === 0" class="hover:bg-transparent">
              <TableCell :colspan="3" class="text-muted-foreground py-8 text-center text-xs">
                暂无企业样本
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  </div>
</template>
