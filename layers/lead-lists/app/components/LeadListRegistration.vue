<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery } from '@pinia/colada'
import { useDebounce } from '@vueuse/core'
import { Button } from '#core/app/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#core/app/components/ui/dialog'
import { Input } from '#core/app/components/ui/input'
import { Label } from '#core/app/components/ui/label'
import { Textarea } from '#core/app/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { describeFetchError } from '#core/lib/file-content-status'
import { versionInput, type LeadCatalog } from '../../lib/contracts'

const props = defineProps<{ catalog: LeadCatalog }>()
const emit = defineEmits<{ registered: [id: number] }>()
const open = defineModel<boolean>('open', { required: true })
const series = ref(''), channel = ref(''), listType = ref(''), acquiredOn = ref('')
const search = ref(''), fileId = ref(''), lines = ref(''), token = ref('')
const saving = ref(false), error = ref('')
const query = useDebounce(search, 250)
const files = useQuery({
  key: () => ['lead-lists', 'source-files', query.value.trim()],
  query: () => $fetch<{ rows: { id: number; displayName: string; relPath: string }[] }>('/api/files', { query: { q: query.value.trim(), pageSize: 50 } }),
  enabled: () => open.value,
})
const availableFiles = computed(() => files.data.value?.rows ?? [])

async function save() {
  if (saving.value) return
  const rows = lines.value.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const [name, uscc, district, note, ...extra] = line.split('\t').map(value => value.trim())
    return { rowNumber: index + 1, name, uscc: uscc || undefined, district: district || undefined, note: note || undefined, ...(extra.length ? { extra } : {}) }
  })
  const result = versionInput.safeParse({ series: series.value, channel: channel.value, listType: listType.value,
    acquiredOn: acquiredOn.value, fileId: Number(fileId.value), rows })
  if (!result.success) {
    const issue = result.error.issues[0]
    error.value = issue?.path[0] === 'rows' ? '请核对粘贴的名单，每行应包含企业名称，最多四列。' : '请填完整系列、来源、类型、日期和原文件。'
    return
  }
  error.value = ''
  saving.value = true
  try {
    const response = await $fetch<{ id: number }>('/api/lead-lists/versions', {
      method: 'POST', headers: { authorization: `Bearer ${token.value.trim()}` }, body: result.data,
    })
    open.value = false
    series.value = channel.value = listType.value = acquiredOn.value = search.value = fileId.value = lines.value = token.value = ''
    emit('registered', response.id)
  } catch (cause) {
    error.value = describeFetchError(cause)
  } finally {
    saving.value = false
  }
}
function changeSearch(value: string | number) {
  search.value = String(value)
  fileId.value = ''
}
</script>

<template>
  <Dialog :open="open" @update:open="value => { if (!saving) { if (!value) token = ''; open = value } }">
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>登记名单版本</DialogTitle>
        <DialogDescription>选择文件库中的原件，再粘贴核对后的名单。</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="save">
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5"><Label for="lead-series">所属系列</Label><Input id="lead-series" v-model="series" maxlength="120" required /></div>
          <div class="space-y-1.5"><Label for="lead-date">获取日期</Label><Input id="lead-date" v-model="acquiredOn" type="date" required /></div>
          <div class="space-y-1.5"><Label for="lead-channel">来源</Label>
            <Select v-model="channel"><SelectTrigger id="lead-channel" class="w-full"><SelectValue placeholder="选择来源" /></SelectTrigger>
              <SelectContent><SelectItem v-for="item in props.catalog.channels" :key="item.code" :value="item.code">{{ item.name }}</SelectItem></SelectContent>
            </Select>
          </div>
          <div class="space-y-1.5"><Label for="lead-type">名单类型</Label>
            <Select v-model="listType"><SelectTrigger id="lead-type" class="w-full"><SelectValue placeholder="选择名单类型" /></SelectTrigger>
              <SelectContent><SelectItem v-for="item in props.catalog.listTypes" :key="item.code" :value="item.code">{{ item.name }}</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
        <div class="space-y-1.5">
          <Label for="lead-file-search">原文件</Label>
          <div class="flex flex-wrap items-center gap-2">
            <Input id="lead-file-search" :model-value="search" class="min-w-36 flex-1" placeholder="搜索文件名" @update:model-value="changeSearch" />
            <Button as-child variant="link" size="sm"><NuxtLink to="/files" target="_blank" rel="noopener">打开文件库上传</NuxtLink></Button>
          </div>
          <Select v-model="fileId">
            <SelectTrigger class="w-full min-w-0" aria-label="选择原文件"><SelectValue :placeholder="files.isLoading.value ? '读取文件中…' : '选择原文件'" /></SelectTrigger>
            <SelectContent><SelectItem v-for="file in availableFiles" :key="file.id" :value="String(file.id)">{{ file.displayName }} · {{ file.relPath }}</SelectItem></SelectContent>
          </Select>
          <div v-if="files.error.value || (!files.isLoading.value && !availableFiles.length)" class="flex items-center gap-2 text-sm" role="status">
            <span>{{ files.error.value ? '文件列表加载失败' : '没有匹配的文件' }}</span>
            <Button type="button" variant="outline" size="sm" @click="files.refetch()">重新加载</Button>
          </div>
        </div>
        <div class="space-y-1.5">
          <Label for="lead-rows">名单数据</Label>
          <Textarea id="lead-rows" v-model="lines" rows="5" placeholder="从工作表粘贴：企业名称、信用代码、区县、备注。每行一家，无表头。" required />
        </div>
        <div class="space-y-1.5"><Label for="lead-write-token">写入令牌</Label><Input id="lead-write-token" v-model="token" type="password" autocomplete="off" required /></div>
        <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
        <DialogFooter><Button type="submit" :disabled="saving">{{ saving ? '正在登记…' : '登记版本' }}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
