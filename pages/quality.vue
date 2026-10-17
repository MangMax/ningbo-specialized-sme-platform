<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed } from 'vue'
import { orderBy, sumBy } from 'es-toolkit'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { CheckCircle2 } from '@lucide/vue'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

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
  opts?: { query?: Record<string, unknown> },
) => Promise<T>

const { data, isLoading } = useQuery({
  key: () => ['quality'],
  query: () => apiGet<QualityGroup[]>('/api/quality'),
})

/** 条数多的排前面:先看影响面最大的那一类。 */
const groups = computed<QualityGroup[]>(() => orderBy(data.value ?? [], [(g) => g.n], ['desc']))
const totalFlagged = computed(() => sumBy(groups.value, (g) => g.n))

const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-10 h-9 text-xs font-medium'
</script>

<template>
  <div class="flex flex-col gap-5" :aria-busy="isLoading">
    <PageHeader title="数据质量">
      <template #description>
        导入时自动判定的待核对项,共
        <span class="text-foreground font-medium tabular-nums">{{ totalFlagged }}</span> 家,
        供人工复核。
      </template>
    </PageHeader>

    <div class="relative h-6 shrink-0" aria-live="polite" data-testid="quality-loading-status">
      <template v-if="isLoading">
        <span class="text-muted-foreground absolute top-0.5 left-0 text-[13px]">正在加载质量清单…</span>
        <span class="bg-muted absolute inset-x-0 bottom-0 block h-0.5 rounded-full">
          <span class="bg-primary block h-0.5 w-1/3 rounded-full" />
        </span>
      </template>
    </div>

    <!-- 索引:点一条跳到下面的清单。清单本身重复一遍数字,这里只做导航。 -->
    <div
      v-if="groups.length"
      class="bg-card flex flex-wrap items-center gap-1.5 rounded-lg border p-2"
    >
      <a
        v-for="g in groups"
        :key="g.kind"
        :href="`#q-${g.kind}`"
        class="hover:bg-accent focus-visible:ring-ring flex items-center gap-2 rounded-sm px-2 py-1 text-xs transition-colors focus-visible:ring-3 focus-visible:outline-none"
      >
        <span class="text-foreground">{{ g.label }}</span>
        <span
          class="text-xs font-medium tabular-nums"
          :class="g.n > 0 ? 'text-primary' : 'text-muted-foreground'"
        >
          {{ g.n.toLocaleString('zh-CN') }}
        </span>
      </a>
    </div>

    <Card v-if="isLoading && !groups.length" class="gap-0 py-0">
      <CardContent class="flex flex-col gap-3 p-5">
        <Skeleton class="h-5 w-48" />
        <Skeleton class="h-40 w-full" />
      </CardContent>
    </Card>

    <Empty v-else-if="!groups.length">
      <EmptyHeader>
        <EmptyMedia variant="icon"><CheckCircle2 /></EmptyMedia>
        <EmptyTitle>没有待核对项</EmptyTitle>
        <EmptyDescription>本次导入没有自动判定出需要人工复核的问题。</EmptyDescription>
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
          <CardTitle class="text-base font-medium">{{ g.label }}</CardTitle>
          <span
            class="text-sm font-medium tabular-nums"
            :class="g.n > 0 ? 'text-primary' : 'text-muted-foreground'"
          >
            {{ g.n.toLocaleString('zh-CN') }} 家
          </span>
        </div>
        <!-- 只在样本被截断时说一次;没截断的类目不必写这句。 -->
        <p v-if="g.samples.length < g.n" class="text-muted-foreground text-xs">
          下面是前 {{ g.samples.length }} 家样本。
        </p>
      </CardHeader>
      <CardContent class="p-0">
        <Table>
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead :class="TH_CLASS">企业名称</TableHead>
              <TableHead :class="[TH_CLASS, 'w-40']">统一社会信用代码</TableHead>
              <TableHead :class="[TH_CLASS, 'w-20']">区县</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="s in g.samples"
              :key="s.enterpriseId"
              class="hover:bg-accent/70 cursor-pointer"
            >
              <TableCell class="max-w-0 truncate">
                <NuxtLink
                  :to="`/enterprises/${s.enterpriseId}`"
                  class="hover:text-primary font-medium hover:underline"
                >
                  {{ s.name }}
                </NuxtLink>
              </TableCell>
              <TableCell
                class="font-mono text-xs"
                :class="s.uscc ? 'text-muted-foreground' : 'text-destructive'"
              >
                {{ s.uscc ?? '缺失' }}
              </TableCell>
              <TableCell class="text-muted-foreground text-xs">{{ s.district ?? '—' }}</TableCell>
            </TableRow>
            <TableRow v-if="g.samples.length === 0" class="hover:bg-transparent">
              <TableCell :colspan="3" class="text-muted-foreground py-8 text-center text-xs">
                这一类名下没有样本企业。
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  </div>
</template>
