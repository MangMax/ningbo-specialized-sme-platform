<script setup lang="ts">
import { useQuery, useQueryCache } from '@pinia/colada'
import { ExternalLink } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { EnterpriseLibraryDetails, EnterpriseLibraryRow, EnterpriseLibrarySource } from '#core/lib/core/enterprise-library'
import type { DictionaryEntry } from '#core/lib/dictionaries'
import { fileUrl } from '#core/lib/preview'
import EnterpriseDetailsForm from './EnterpriseDetailsForm.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import { Button } from '#core/app/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#core/app/components/ui/sheet'

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
  const groups = new Map<string, (EnterpriseLibrarySource & { detail: string })[]>()
  for (const source of sources.value ?? []) {
    const label = source.listType
    const group = groups.get(label) ?? []
    const detail = [...new Set([source.series, source.channel, source.acquiredOn])]
      .filter(value => value && value !== label).join(' · ')
    if (detail || source.filePath) group.push({ ...source, detail })
    groups.set(label, group)
  }
  return [...groups].map(([label, items]) => ({ label, items }))
})

const displayed = computed(() => details.value ?? props.enterprise)
const district = computed(() => props.regions?.find(item => item.code === displayed.value?.districtCode)?.name
  ?? displayed.value?.district ?? displayed.value?.districtCode)
const township = computed(() => props.regions?.find(item => item.code === displayed.value?.townshipCode)?.name ?? displayed.value?.townshipCode)
const industry = computed(() => industries.value?.find(item => item.code === displayed.value?.industryCode)?.name ?? displayed.value?.industryCode)
</script>

<template>
  <Sheet :open="Boolean(enterprise)" @update:open="!$event && !saving && emit('close')">
    <SheetContent
      floating-size="detail"
      class="gap-0"
      @close-auto-focus="event => { event.preventDefault(); emit('restoreFocus') }"
    >
      <SheetHeader class="border-b px-5 py-5 pr-12 sm:px-6">
        <SheetTitle class="wrap-anywhere text-lg">{{ enterprise?.name }}</SheetTitle>
        <SheetDescription class="sr-only">企业资料与入库来源</SheetDescription>
      </SheetHeader>
      <EnterpriseDetailsForm
        v-if="editing && details && regions && industries"
        :key="details.id" v-model:saving="saving" :enterprise="details" :regions="regions" :industries="industries"
        @cancel="stopEditing" @saved="saveDetails"
      />
      <div v-else-if="enterprise" class="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
        <section aria-labelledby="enterprise-details-heading" :aria-busy="detailsLoading">
          <div class="mb-4 flex items-center justify-between gap-3">
            <h2 id="enterprise-details-heading" class="text-base font-semibold">企业资料</h2>
            <Button
              id="edit-enterprise-details" type="button" size="sm" variant="outline"
              :disabled="!details || !regions || !industries" @click="editDetails"
            >编辑资料</Button>
          </div>
          <TableFailureState v-if="detailsError" class="mb-3" title="企业资料暂时无法加载" compact :pending="detailsLoading" @retry="retryDetails()" />
          <TableFailureState v-if="industriesError" class="mb-3" title="行业字典暂时无法加载" compact @retry="retryIndustries()" />
          <dl class="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
            <div class="col-span-2">
              <dt class="text-muted-foreground">统一社会信用代码</dt>
              <dd class="mt-1 font-medium tabular-nums">{{ enterprise.uscc ?? '未登记' }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">区县</dt>
              <dd class="mt-1">{{ district ?? '未登记' }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">乡镇（街道）</dt>
              <dd class="mt-1">{{ township ?? '未登记' }}</dd>
            </div>
            <div class="col-span-2">
              <dt class="text-muted-foreground">行业</dt>
              <dd class="mt-1">{{ industry ?? '未登记' }}</dd>
            </div>
            <div v-if="details" class="col-span-2">
              <dt class="text-muted-foreground">注册地址</dt>
              <dd class="mt-1 wrap-anywhere whitespace-pre-line">{{ details.registeredAddress ?? '未登记' }}</dd>
            </div>
            <div v-if="details" class="col-span-2">
              <dt class="text-muted-foreground">经营地址</dt>
              <dd class="mt-1 wrap-anywhere whitespace-pre-line">{{ details.operatingAddress ?? '未登记' }}</dd>
            </div>
          </dl>
        </section>

        <section class="mt-6 border-t pt-5" aria-labelledby="enterprise-sources-heading" :aria-busy="isLoading">
          <h2 id="enterprise-sources-heading" class="text-base font-semibold">入库来源</h2>
          <TableFailureState v-if="error" class="mt-3" title="来源暂时无法加载" :compact="Boolean(sources)" :pending="isLoading" @retry="refetch()" />
          <p v-if="isLoading && !sources" class="text-muted-foreground mt-3 text-sm" role="status">正在加载来源…</p>
          <p v-else-if="!error && sources?.length === 0" class="text-muted-foreground mt-3 text-sm">暂无来源记录</p>
          <div v-if="sourceGroups.length" class="mt-1 divide-y">
            <section v-for="{ label, items } in sourceGroups" :key="label" class="py-3">
              <h3 class="text-sm font-medium">{{ label }}</h3>
              <ul v-if="items.length" class="mt-2 space-y-2">
                <li v-for="source in items" :key="source.id" class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p v-if="source.detail" class="min-w-0 flex-1 wrap-anywhere text-sm text-muted-foreground">{{ source.detail }}</p>
                  <Button v-if="source.filePath" as-child variant="outline" size="sm">
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
    </SheetContent>
  </Sheet>
</template>
