<script setup lang="ts">
import { useQuery, useQueryCache } from '@pinia/colada'
import { ExternalLink } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { EnterpriseLibraryDetails, EnterpriseLibraryRow, EnterpriseLibrarySource } from '#core/lib/core/enterprise-library'
import type { DictionaryEntry } from '#core/lib/dictionaries'
import { fileUrl } from '#core/lib/preview'
import EnterpriseDetailsForm from './EnterpriseDetailsForm.vue'
import DetailDrawer from '#core/app/components/DetailDrawer.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import { Button } from '#core/app/components/ui/button'

const props = defineProps<{
  enterprise: EnterpriseLibraryRow | null
  regions?: DictionaryEntry[]
}>()
const emit = defineEmits<{ close: []; restoreFocus: []; saved: [details: EnterpriseLibraryDetails] }>()
const id = computed(() => props.enterprise?.id)
const { data: sources, isLoading, error, refetch } = useQuery({
  key: () => ['enterprise-library', 'sources', id.value ?? 0],
  enabled: () => id.value !== undefined,
  query: ({ entry }) => ($fetch as unknown as <T>(path: string) => Promise<T>)<EnterpriseLibrarySource[]>(
    `/api/core/enterprises/${entry.key[2]}/sources`,
  ),
})

const queryCache = useQueryCache()
const editing = ref(false)
const saving = ref(false)
const detailsKey = (enterpriseId: number) => ['enterprise-library', 'details', enterpriseId] as const
const { data: details, isLoading: detailsLoading, error: detailsError, refetch: retryDetails } = useQuery({
  key: () => detailsKey(id.value ?? 0),
  enabled: () => id.value !== undefined,
  query: ({ entry }) => $fetch<EnterpriseLibraryDetails>(`/api/core/enterprises/${entry.key[2]}/details`),
})
const { data: industries, error: industriesError, refetch: retryIndustries } = useQuery({
  key: ['enterprise-library', 'industries'],
  enabled: () => id.value !== undefined,
  query: () => $fetch<DictionaryEntry[]>('/api/core/dictionaries/industries'),
})
watch(id, () => { editing.value = false }, { flush: 'sync' })

function editDetails() {
  editing.value = true
  void nextTick(() => document.getElementById('directory-district')?.focus())
}

function stopEditing() {
  editing.value = false
  void nextTick(() => document.getElementById('edit-enterprise-details')?.focus())
}

function saveDetails(saved: EnterpriseLibraryDetails) {
  queryCache.setQueryData(detailsKey(saved.id), saved)
  emit('saved', saved)
  stopEditing()
}

const sourceGroups = computed(() => {
  const groups = new Map<string, (EnterpriseLibrarySource & { title: string; meta: string })[]>()
  for (const source of sources.value ?? []) {
    const label = source.listType
    const group = groups.get(label) ?? []
    const parts = [...new Set([source.series, source.channel, source.acquiredOn])]
      .filter((value): value is string => Boolean(value && value !== label))
    const title = parts[0] ?? ''
    const meta = parts.slice(1).join(' · ')
    if (title || source.filePath) group.push({ ...source, title, meta })
    groups.set(label, group)
  }
  return [...groups].map(([label, items]) => ({ label, items }))
})

const totalSourceCount = computed(() => sourceGroups.value.reduce((sum, group) => sum + group.items.length, 0))

const displayed = computed(() => details.value ?? props.enterprise)
const district = computed(() => props.regions?.find(item => item.code === displayed.value?.districtCode)?.name
  ?? displayed.value?.district ?? displayed.value?.districtCode)
const township = computed(() => props.regions?.find(item => item.code === displayed.value?.townshipCode)?.name ?? displayed.value?.townshipCode)
const industry = computed(() => industries.value?.find(item => item.code === displayed.value?.industryCode)?.name ?? displayed.value?.industryCode)
</script>

<template>
  <DetailDrawer
    :open="Boolean(enterprise)"
    :title="enterprise?.name ?? ''"
    description="企业资料与入库来源"
    hide-description
    floating-size="detail"
    :prevent-close="saving"
    @update:open="!$event && emit('close')"
    @close-auto-focus="event => { event.preventDefault(); emit('restoreFocus') }"
  >
    <div
      v-if="editing && details && regions && industries"
      class="-mx-5 -my-4 flex min-h-[calc(100%+2rem)] flex-col sm:-mx-6"
    >
      <EnterpriseDetailsForm
        :key="details.id" v-model:saving="saving" :enterprise="details" :regions="regions" :industries="industries"
        @cancel="stopEditing" @saved="saveDetails"
      />
    </div>
    <div v-else-if="enterprise" class="space-y-6">
      <section aria-labelledby="enterprise-details-heading" :aria-busy="detailsLoading">
        <div class="mb-3 flex items-center justify-between gap-3">
          <h2 id="enterprise-details-heading" class="text-sm font-semibold">企业资料</h2>
          <Button
            id="edit-enterprise-details" type="button" size="sm" variant="outline"
            :disabled="!details || !regions || !industries" @click="editDetails"
          >编辑资料</Button>
        </div>
        <TableFailureState v-if="detailsError" class="mb-3" title="企业资料暂时无法加载" compact :pending="detailsLoading" @retry="retryDetails()" />
        <TableFailureState v-if="industriesError" class="mb-3" title="行业字典暂时无法加载" compact @retry="retryIndustries()" />

        <dl class="border-border bg-card divide-border-secondary divide-y overflow-hidden rounded-lg border text-sm">
          <!-- 核心标识：统一社会信用代码置于独立浅底抬头，一眼可读 -->
          <div class="bg-surface-sunken px-3.5 py-2.5">
            <dt class="text-muted-foreground text-xs">统一社会信用代码</dt>
            <dd
              class="mt-0.5 font-mono text-sm font-semibold tracking-tight tabular-nums"
              :class="enterprise.uscc ? 'text-foreground' : 'text-text-tertiary font-normal'"
            >
              {{ enterprise.uscc ?? '未登记' }}
            </dd>
          </div>

          <div class="grid grid-cols-2 gap-x-4 gap-y-3 px-3.5 py-3">
              <div class="min-w-0">
                <dt class="text-muted-foreground text-xs">区县</dt>
                <dd class="mt-0.5" :class="district ? 'text-foreground font-medium' : 'text-text-tertiary'">
                  {{ district ?? '未登记' }}
                </dd>
              </div>
              <div class="min-w-0">
                <dt class="text-muted-foreground text-xs">乡镇（街道）</dt>
                <dd class="mt-0.5" :class="township ? 'text-foreground font-medium' : 'text-text-tertiary'">
                  {{ township ?? '未登记' }}
                </dd>
              </div>
              <div class="col-span-2 min-w-0">
                <dt class="text-muted-foreground text-xs">行业</dt>
                <dd class="mt-0.5" :class="industry ? 'text-foreground font-medium' : 'text-text-tertiary'">
                  {{ industry ?? '未登记' }}
                </dd>
              </div>
            </div>

            <div v-if="details" class="space-y-3 px-3.5 py-3">
              <div class="min-w-0">
                <dt class="text-muted-foreground text-xs">注册地址</dt>
                <dd
                  class="mt-0.5 wrap-anywhere whitespace-pre-line leading-5"
                  :class="details.registeredAddress ? 'text-foreground' : 'text-text-tertiary'"
                >
                  {{ details.registeredAddress ?? '未登记' }}
                </dd>
              </div>
              <div class="min-w-0">
                <dt class="text-muted-foreground text-xs">经营地址</dt>
                <dd
                  class="mt-0.5 wrap-anywhere whitespace-pre-line leading-5"
                  :class="details.operatingAddress ? 'text-foreground' : 'text-text-tertiary'"
                >
                  {{ details.operatingAddress ?? '未登记' }}
                </dd>
              </div>
            </div>
        </dl>
      </section>

      <section aria-labelledby="enterprise-sources-heading" :aria-busy="isLoading">
        <div class="mb-3 flex items-center gap-2">
          <h2 id="enterprise-sources-heading" class="text-sm font-semibold">入库来源</h2>
          <span
            v-if="totalSourceCount > 0"
            class="bg-muted text-muted-foreground rounded-sm px-1.5 py-0.5 text-xs font-medium tabular-nums"
          >
            {{ totalSourceCount }}
          </span>
        </div>
        <TableFailureState v-if="error" class="mt-3" title="来源暂时无法加载" :compact="Boolean(sources)" :pending="isLoading" @retry="refetch()" />
        <p v-if="isLoading && !sources" class="text-muted-foreground mt-3 text-sm" role="status">正在加载来源…</p>
        <p v-else-if="!error && sources?.length === 0" class="text-muted-foreground mt-3 text-sm">暂无来源记录</p>
        <div v-if="sourceGroups.length" class="space-y-4">
          <section v-for="{ label, items } in sourceGroups" :key="label">
            <div class="mb-2 flex items-center justify-between gap-2">
              <h3 class="text-muted-foreground text-xs font-medium">{{ label }}</h3>
              <span class="text-text-tertiary text-xs tabular-nums">{{ items.length }} 项</span>
            </div>
            <ul v-if="items.length" class="border-border bg-card divide-border-secondary divide-y overflow-hidden rounded-lg border">
              <li
                v-for="source in items"
                :key="source.id"
                class="hover:bg-muted/40 flex items-center justify-between gap-3 px-3.5 py-2.5 transition-colors"
              >
                <div class="min-w-0 flex-1">
                  <p v-if="source.title" class="text-foreground text-table leading-5 font-medium wrap-anywhere">
                    {{ source.title }}
                  </p>
                  <p v-if="source.meta" class="text-muted-foreground mt-0.5 text-xs">
                    {{ source.meta }}
                  </p>
                </div>
                <Button
                  v-if="source.filePath"
                  as-child
                  variant="ghost"
                  size="sm"
                  class="text-primary hover:text-primary h-7 shrink-0 px-2 text-xs"
                >
                  <a :href="fileUrl(source.filePath)" target="_blank" rel="noopener">
                    查看原文件 <ExternalLink class="size-3.5" aria-hidden="true" />
                  </a>
                </Button>
              </li>
            </ul>
          </section>
        </div>
      </section>
    </div>
  </DetailDrawer>
</template>
