<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '#core/app/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '#core/app/components/ui/field'
import EnterpriseDictionaryCascade from './EnterpriseDictionaryCascade.vue'
import { Textarea } from '#core/app/components/ui/textarea'
import type { EnterpriseLibraryDetails } from '#core/lib/core/enterprise-library'
import type { DictionaryEntry } from '#core/lib/dictionaries'
import { describeFetchError } from '#core/lib/file-content-status'

const props = defineProps<{
  enterprise: EnterpriseLibraryDetails
  regions: DictionaryEntry[]
  industries: DictionaryEntry[]
}>()
const emit = defineEmits<{ cancel: []; saved: [details: EnterpriseLibraryDetails] }>()

const region = ref<{ parent?: string; child?: string }>({
  parent: props.enterprise.districtCode ?? undefined,
  child: props.enterprise.townshipCode ?? undefined,
})
const industry = ref<{ parent?: string; child?: string }>({ child: props.enterprise.industryCode ?? undefined })
const registeredAddress = ref(props.enterprise.registeredAddress ?? '')
const operatingAddress = ref(props.enterprise.operatingAddress ?? '')
const endpoint = `/api/core/enterprises/${props.enterprise.id}/details`
const saving = defineModel<boolean>('saving', { required: true })
const error = ref('')

async function save() {
  if (saving.value) return
  error.value = ''
  saving.value = true
  try {
    const details = await $fetch<EnterpriseLibraryDetails>(endpoint, {
      method: 'POST',
      headers: { 'X-Enterprise-Library-Browser': '1' },
      body: {
        expectedRevision: props.enterprise.revision,
        districtCode: region.value.parent ?? null,
        townshipCode: region.value.child ?? null,
        industryCode: industry.value.child ?? null,
        registeredAddress: registeredAddress.value.trim() || null,
        operatingAddress: operatingAddress.value.trim() || null,
      },
    })
    emit('saved', details)
  } catch (cause) {
    error.value = describeFetchError(cause, '企业资料保存失败，请重试。')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form :action="endpoint" method="post" aria-labelledby="enterprise-details-form-title" class="flex min-h-0 flex-1 flex-col" @submit.prevent="save">
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
      <h3 id="enterprise-details-form-title" class="mb-4 text-sm font-semibold">编辑企业资料</h3>
      <FieldGroup class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field class="min-w-0">
          <FieldLabel for="directory-district">区划</FieldLabel>
          <EnterpriseDictionaryCascade
            id="directory-district" v-model="region" label="区划" kind="region" :entries="regions"
            empty-label="未登记" parent-label="仅选此区县" :disabled="saving"
          />
        </Field>
        <Field class="min-w-0">
          <FieldLabel for="directory-industry">行业</FieldLabel>
          <EnterpriseDictionaryCascade
            id="directory-industry" v-model="industry" label="行业" kind="industry" :entries="industries"
            empty-label="未登记" :disabled="saving"
          />
        </Field>
        <Field class="col-span-full">
          <FieldLabel for="directory-registered-address">注册地址</FieldLabel>
          <Textarea id="directory-registered-address" v-model="registeredAddress" name="registeredAddress" rows="2" :maxlength="500" :disabled="saving" />
        </Field>
        <Field class="col-span-full">
          <FieldLabel for="directory-operating-address">经营地址</FieldLabel>
          <Textarea id="directory-operating-address" v-model="operatingAddress" name="operatingAddress" rows="2" :maxlength="500" :disabled="saving" />
        </Field>
        <FieldError v-if="error" role="alert" class="col-span-full">{{ error }}</FieldError>
      </FieldGroup>
    </div>
    <div class="flex shrink-0 justify-end gap-2 border-t px-5 py-3 sm:px-6">
      <Button type="button" variant="outline" :disabled="saving" @click="emit('cancel')">取消</Button>
      <Button type="submit" :disabled="saving">{{ saving ? '正在保存…' : '保存资料' }}</Button>
    </div>
  </form>
</template>
