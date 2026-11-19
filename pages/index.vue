<script setup lang="ts">
import { ArrowRight } from '@lucide/vue'
import { getAppModules } from '~~/lib/app-modules'
import { getDashboardCardComponent } from '~~/lib/dashboard-card-components'
import PageHeader from '#core/app/components/PageHeader.vue'
import { Button } from '#core/app/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#core/app/components/ui/card'

const modules = getAppModules()
  .filter(module => module.id !== 'core')
  .map(({ dashboard, ...module }) => ({
    ...module,
    homeTitle: module.nav?.flatMap(item => item.items ?? [item])
      .find(item => item.url === module.home)?.title ?? module.name,
    cards: dashboard?.map(({ id, title }) => ({
      id,
      title,
      component: getDashboardCardComponent(id),
    })) ?? [],
  }))

useHead({ title: '平台工作台' })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-5">
    <PageHeader title="平台工作台" />

    <section
      v-for="module in modules"
      :key="module.id"
      :aria-labelledby="`module-${module.id}`"
      class="flex flex-col gap-3"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <h2 :id="`module-${module.id}`" class="text-base font-semibold">{{ module.name }}</h2>
          <p v-if="module.description" class="text-muted-foreground text-sm">{{ module.description }}</p>
        </div>
        <Button v-if="module.home" as-child size="sm">
          <NuxtLink :to="module.home">
            {{ module.homeTitle }} <ArrowRight aria-hidden="true" />
          </NuxtLink>
        </Button>
      </div>

      <div v-if="module.cards.length" class="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
        <Card v-for="card in module.cards" :key="card.id" class="min-w-0 gap-3 py-4">
          <CardHeader><CardTitle>{{ card.title }}</CardTitle></CardHeader>
          <CardContent>
            <component :is="card.component" />
          </CardContent>
        </Card>
      </div>
    </section>
  </div>
</template>
