<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed } from 'vue'

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

const apiGet = $fetch as unknown as <T>(url: string, opts?: { query?: Record<string, unknown> }) => Promise<T>

const { data, isLoading } = useQuery({
  key: () => ['quality'],
  query: () => apiGet<QualityGroup[]>('/api/quality'),
})

const groups = computed<QualityGroup[]>(() => data.value ?? [])
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="text-xl font-semibold">数据质量</h1>
      <p class="text-muted-foreground text-sm">
        导入时可判定的待核对项 · 共 {{ groups.length }} 类
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <Badge v-for="g in groups" :key="g.kind" :variant="g.n > 0 ? 'secondary' : 'outline'">
        {{ g.label }} · {{ g.n }}
      </Badge>
      <Skeleton v-if="isLoading && groups.length === 0" class="h-5 w-24" />
    </div>

    <p class="text-muted-foreground text-xs">
      说明:非宁波(漂移)、已注销 / 吊销等标记需接入登记状态等外部富化数据,本期不实现——本页仅呈现可由公布文件与工信部名单直接推出的质量项(见
      <span class="font-mono">docs/adr/2026-10-13-announcements-as-input.md</span>)。
    </p>

    <Card v-for="g in groups" :key="g.kind">
      <CardHeader>
        <div class="flex items-center justify-between gap-3">
          <CardTitle class="text-base">{{ g.label }}</CardTitle>
          <Badge variant="outline">{{ g.n }}</Badge>
        </div>
        <CardDescription v-if="g.samples.length < g.n">
          显示前 {{ g.samples.length }} 条样本(共 {{ g.n }} 条)
        </CardDescription>
      </CardHeader>
      <CardContent class="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企业名称</TableHead>
              <TableHead>统一社会信用代码</TableHead>
              <TableHead>区县</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="s in g.samples" :key="s.enterpriseId">
              <TableCell class="font-medium">
                <NuxtLink :to="`/enterprises/${s.enterpriseId}`" class="hover:underline">
                  {{ s.name }}
                </NuxtLink>
              </TableCell>
              <TableCell class="text-muted-foreground font-mono text-xs">{{ s.uscc ?? '—' }}</TableCell>
              <TableCell>{{ s.district ?? '—' }}</TableCell>
            </TableRow>
            <TableRow v-if="g.samples.length === 0">
              <TableCell :colspan="3" class="text-muted-foreground h-20 text-center">
                该类暂无样本企业
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Card v-if="isLoading && groups.length === 0">
      <CardContent class="p-6">
        <Skeleton class="h-16 w-full" />
      </CardContent>
    </Card>
  </div>
</template>
