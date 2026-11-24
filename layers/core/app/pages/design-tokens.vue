<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Copy, Play } from '@lucide/vue'
import ActiveFilterBar from '#core/app/components/ActiveFilterBar.vue'
import DataTableCard from '#core/app/components/DataTableCard.vue'
import DetailDrawer from '#core/app/components/DetailDrawer.vue'
import MultiSelectFilter from '#core/app/components/MultiSelectFilter.vue'
import SectionCard from '#core/app/components/SectionCard.vue'
import SingleSelectFilter from '#core/app/components/SingleSelectFilter.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import { Badge } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import { Input } from '#core/app/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#core/app/components/ui/table'
import { useAppColorMode } from '#core/app/composables/useAppColorMode'
import {
  designTokenCategories,
  type DesignToken,
} from '#core/lib/design-tokens'

// 开发态专用:这是给设计/前端自查 token 的预览页,不进入生产路由。
// 直接用 404 而不是隐藏入口 —— 生产里它就不该存在。
if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
}

useHead({ title: 'Design Tokens' })

const colorMode = useAppColorMode()
const isDark = computed(() => colorMode.value === 'dark')

/** 当前色板下的取值(明暗联动顶栏 ThemeToggle)。 */
function tokenValue(token: DesignToken) {
  return token.scope === 'palette'
    ? (isDark.value ? token.darkValue : token.lightValue)
    : token.value
}

/** 与主题无关的刻度值(层级、尺寸、时长)。 */
function staticValue(token: DesignToken) {
  return token.scope === 'palette' ? '' : token.value
}

/* ── 复制变量名 ─────────────────────────────────────────────────────── */
const copied = ref<string | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | undefined

async function copyToken(token: DesignToken) {
  try {
    await navigator.clipboard?.writeText(token.cssVar)
  } catch {
    // 剪贴板受浏览器策略限制;复制失败也照常给出「已复制」的视觉反馈,
    // 变量名本身仍然显示在按钮上,可以手动选取。
  }
  copied.value = token.name
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copied.value = null }, 1500)
}

/* ── 阴影与层级 ─────────────────────────────────────────────────────── */
const shadowCategory = computed(
  () => designTokenCategories.find((category) => category.id === 'shadow-z')!,
)
const shadowTokens = computed(() =>
  shadowCategory.value.tokens.filter((token) => token.name.startsWith('--shadow')),
)
const zTokens = computed(() =>
  shadowCategory.value.tokens.filter((token) => token.name.startsWith('--z-')),
)

/* ── 布局样例状态 ───────────────────────────────────────────────────── */
const toolbarSearch = ref('')
const titleFilter = ref('all')
const titleOptions = [
  { value: 'tier-1', label: '小巨人' },
  { value: 'tier-2', label: '专精特新中小企业' },
  { value: 'tier-3', label: '创新型中小企业' },
]
const sourceFilter = ref<string[]>([])
const sourceOptions = [
  { value: 'national', label: '国家级' },
  { value: 'municipal', label: '市级' },
]
const chips = ref([{ key: 'district', label: '区县：鄞州区' }])
function removeChip(key: string) {
  chips.value = chips.value.filter((chip) => chip.key !== key)
}
function clearChips() {
  chips.value = []
}

const sampleRows = [
  { name: '宁波甲合成材料有限公司', title: '小巨人', tier: 'tier-1' as const, year: 2024 },
  { name: '宁波乙精密制造有限公司', title: '专精特新', tier: 'tier-2' as const, year: 2023 },
  { name: '宁波丙智能装备有限公司', title: '创新型', tier: 'tier-3' as const, year: 2022 },
]

const drawerOpen = ref(false)

/* ── 动效样例 ───────────────────────────────────────────────────────── */
const motionDurations = [
  { label: '100ms · fast', value: 'var(--duration-fast)' },
  { label: '200ms · mid', value: 'var(--duration-mid)' },
  { label: '300ms · slow', value: 'var(--duration-slow)' },
] as const
const motionDuration = ref<string>(motionDurations[1]!.value)
const motionOn = ref(false)
function playMotion(duration: string) {
  motionDuration.value = duration
  motionOn.value = !motionOn.value
}
</script>

<template>
  <WorkspacePage
    mode="scroll"
    title="Design Tokens"
    description="12 类设计变量的实时预览：色板、层级、圆角、排版、动效与布局刻度。"
  >
    <template #actions>
      <Badge :variant="isDark ? 'quiet' : 'outline'">
        {{ isDark ? '当前：深色' : '当前：浅色' }}
      </Badge>
    </template>

    <nav aria-label="Design Tokens 目录" class="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
      <a
        v-for="(category, index) in designTokenCategories"
        :key="category.id"
        :href="`#token-${category.id}`"
        class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-sm hover:underline focus-visible:outline-ring focus-visible:outline-2"
      >
        <span class="tabular-nums text-xs">{{ String(index + 1).padStart(2, '0') }}</span>
        {{ category.title }}
      </a>
    </nav>

    <SectionCard
      v-for="category in designTokenCategories"
      :id="`token-${category.id}`"
      :key="category.id"
      :title="category.title"
      :description="category.summary"
      data-token-category
      class="scroll-mt-4"
      :body-class="category.preview === 'layout' ? 'p-0' : undefined"
    >
      <!-- 色板 / 文字：真实渲染色块 + 变量名 + Tailwind 类 + 用途 -->
      <div
        v-if="category.preview === 'swatch' || category.preview === 'text'"
        class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        <article
          v-for="token in category.tokens"
          :key="token.name"
          class="flex min-w-0 flex-col gap-2 rounded-md border p-3"
        >
          <div class="flex min-w-0 items-center gap-2">
            <span
              class="size-9 shrink-0 rounded-sm border"
              :style="{ background: token.cssVar }"
              aria-hidden="true"
            />
            <button
              type="button"
              class="min-w-0 flex-1 text-left focus-visible:outline-ring focus-visible:outline-2"
              :aria-label="`复制 ${token.name}`"
              @click="copyToken(token)"
            >
              <code class="block truncate font-mono text-xs">{{ token.name }}</code>
              <span class="text-muted-foreground flex items-center gap-1 text-xs">
                <component :is="copied === token.name ? Check : Copy" class="size-3" aria-hidden="true" />
                {{ copied === token.name ? '已复制' : token.cssVar }}
              </span>
            </button>
          </div>
          <p class="text-sm">{{ token.role }}</p>
          <p class="text-muted-foreground text-xs">{{ token.usage }}</p>
          <p v-if="token.tailwindClass" class="text-muted-foreground truncate font-mono text-xs">
            {{ token.tailwindClass }}
          </p>
          <p
            v-if="category.preview === 'text'"
            class="truncate text-sm"
            :style="{ color: token.cssVar }"
          >
            企业基础库 · 正文样例 Aa 0123
          </p>
          <p class="text-muted-foreground truncate font-mono text-[11px]" :title="tokenValue(token)">
            {{ tokenValue(token) }}
          </p>
        </article>
      </div>

      <!-- 阴影与层级 -->
      <div v-else-if="category.preview === 'shadow'" class="flex flex-col gap-5">
        <div class="grid gap-4 sm:grid-cols-3">
          <div
            v-for="token in shadowTokens"
            :key="token.name"
            class="bg-card rounded-md border p-4"
            :style="{ boxShadow: token.cssVar }"
          >
            <code class="font-mono text-xs">{{ token.name }}</code>
            <p class="text-muted-foreground mt-2 text-xs">{{ token.role }}</p>
            <p class="text-muted-foreground mt-1 font-mono text-[11px]">{{ tokenValue(token) }}</p>
          </div>
        </div>
        <div>
          <h3 class="mb-1 text-sm font-semibold">Z-Index 阶梯</h3>
          <dl class="divide-y text-sm">
            <div
              v-for="token in zTokens"
              :key="token.name"
              class="flex items-center justify-between gap-3 py-2"
            >
              <dt class="min-w-0">
                <code class="font-mono text-xs">{{ token.name }}</code>
                <span class="text-muted-foreground ml-2 text-xs">{{ token.role }}</span>
              </dt>
              <dd class="tabular-nums shrink-0 text-xs">{{ staticValue(token) }}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div v-else-if="category.preview === 'radius'" class="flex flex-col gap-4">
        <div class="grid gap-3 sm:grid-cols-4">
          <div v-for="item in [
            { label: 'rounded-sm · 4px', cls: 'rounded-sm' },
            { label: 'rounded-md · 6px', cls: 'rounded-md' },
            { label: 'rounded-lg · 8px', cls: 'rounded-lg' },
            { label: 'rounded-xl · 12px', cls: 'rounded-xl' },
          ]" :key="item.cls" class="flex flex-col gap-2">
            <div class="bg-accent h-16 border" :class="item.cls" />
            <code class="text-muted-foreground font-mono text-xs">{{ item.label }}</code>
          </div>
        </div>
        <p class="text-muted-foreground text-xs">
          基准 <code class="font-mono">--radius: 0.375rem</code>；徽章/标签用 sm，按钮与输入用 md，小卡片用 lg，抽屉与大方块用 xl。
        </p>
      </div>

      <!-- 排版 -->
      <div v-else-if="category.preview === 'type'" class="flex flex-col gap-4">
        <div class="flex flex-col divide-y">
          <div class="flex items-baseline justify-between gap-4 py-2">
            <span class="text-xl leading-tight font-semibold tracking-tight">页标题 20px / text-xl</span>
            <code class="text-muted-foreground shrink-0 font-mono text-xs">20px</code>
          </div>
          <div class="flex items-baseline justify-between gap-4 py-2">
            <span class="text-base leading-tight font-semibold">分区标题 16px / text-base</span>
            <code class="text-muted-foreground shrink-0 font-mono text-xs">16px</code>
          </div>
          <div class="flex items-baseline justify-between gap-4 py-2">
            <span class="text-sm">正文 14px / text-sm</span>
            <code class="text-muted-foreground shrink-0 font-mono text-xs">14px</code>
          </div>
          <div class="flex items-baseline justify-between gap-4 py-2">
            <span class="text-table">表体 13px / text-table</span>
            <code class="text-muted-foreground shrink-0 font-mono text-xs">13px</code>
          </div>
          <div class="flex items-baseline justify-between gap-4 py-2">
            <span class="text-muted-foreground text-xs">元信息 12px / text-xs</span>
            <code class="text-muted-foreground shrink-0 font-mono text-xs">12px</code>
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-md border p-3">
            <p class="mb-1 text-sm font-medium">tabular-nums 对比</p>
            <p class="tabular text-xs">信用代码 91330211255994457P</p>
            <p class="text-xs">信用代码 91330211255994457P</p>
            <p class="text-muted-foreground mt-1 text-xs">表格与 `.tabular` 容器统一等宽数字，标识码纵向对齐。</p>
          </div>
          <div class="rounded-md border p-3">
            <p class="mb-1 text-sm font-medium">OCR 专用字号</p>
            <p class="text-xs" :style="{ fontSize: 'var(--ocr-prose-size)', lineHeight: 'var(--ocr-prose-leading)' }">
              校对正文 15px / 1.65 —— 只被 `.ocr-workbench` 引用。
            </p>
            <p class="text-xs" :style="{ fontSize: 'var(--ocr-code-size)' }">代码片段 14px</p>
          </div>
        </div>
        <div>
          <h3 class="mb-1 text-sm font-semibold">字号与行高 token</h3>
          <dl class="divide-y text-sm">
            <div
              v-for="token in category.tokens"
              :key="token.name"
              class="flex items-center justify-between gap-3 py-2"
            >
              <dt class="min-w-0">
                <code class="font-mono text-xs">{{ token.name }}</code>
                <span class="text-muted-foreground ml-2 text-xs">{{ token.role }}</span>
              </dt>
              <dd class="tabular-nums shrink-0 font-mono text-xs">{{ staticValue(token) }}</dd>
            </div>
          </dl>
        </div>
      </div>

      <!-- 动效 -->
      <div v-else-if="category.preview === 'motion'" class="flex flex-col gap-4">
        <div class="rounded-md border p-4">
          <div class="bg-muted/40 relative h-12 overflow-hidden rounded-sm">
            <span
              class="bg-primary absolute top-1/2 size-6 -translate-y-1/2 rounded-full transition-[left] ease-snap motion-reduce:transition-none"
              :style="{
                left: motionOn ? 'calc(100% - 2rem)' : '0.5rem',
                transitionDuration: motionDuration,
              }"
              aria-hidden="true"
            />
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <Button
              v-for="duration in motionDurations"
              :key="duration.value"
              size="sm"
              :variant="motionDuration === duration.value ? 'default' : 'outline'"
              @click="playMotion(duration.value)"
            >
              <Play class="size-3.5" aria-hidden="true" />
              {{ duration.label }}
            </Button>
          </div>
          <p class="text-muted-foreground mt-2 text-xs">
            同一段位移、同一 `--ease-snap`，只换时长就能比较手感。偏好减少动效时过渡关闭，元素直接到位。
          </p>
        </div>
        <div>
          <h3 class="mb-1 text-sm font-semibold">动效 token</h3>
          <dl class="divide-y text-sm">
            <div
              v-for="token in category.tokens"
              :key="token.name"
              class="flex items-center justify-between gap-3 py-2"
            >
              <dt class="min-w-0">
                <code class="font-mono text-xs">{{ token.name }}</code>
                <span class="text-muted-foreground ml-2 text-xs">{{ token.role }}</span>
              </dt>
              <dd class="shrink-0 font-mono text-xs">{{ staticValue(token) }}</dd>
            </div>
          </dl>
        </div>
      </div>

      <!-- 布局与骨架组件实时样例 -->
      <div v-else-if="category.preview === 'layout'" class="flex flex-col gap-0">
        <DataTableCard toolbar-label="工具栏与表格尺寸样例">
          <template #toolbar>
            <div class="flex flex-wrap items-center gap-2">
              <Input
                v-model="toolbarSearch"
                size="sm"
                class="w-48"
                placeholder="搜索企业"
                aria-label="搜索企业（示例）"
              />
              <SingleSelectFilter
                v-model="titleFilter"
                :options="titleOptions"
                placeholder="全部称号"
                :ariaLabel="'称号（示例）'"
                summary-prefix="称号"
              />              <MultiSelectFilter
                v-model="sourceFilter"
                :options="sourceOptions"
                placeholder="全部来源"
                summary-prefix="来源"
              />
              <Button size="sm" variant="outline">刷新</Button>
              <span class="text-muted-foreground text-xs">控件统一 32px（h-8）</span>
            </div>
            <ActiveFilterBar :items="chips" @remove="removeChip" @clear="clearChips" />
          </template>

          <div class="grid gap-4 p-4 xl:grid-cols-2">
            <div class="min-w-0">
              <p class="mb-2 text-sm font-medium">默认表格 · 行最小高 44px</p>
              <div class="data-table-scroll rounded-md border">
                <Table class="data-table">
                  <caption class="sr-only">默认表格样例</caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>企业</TableHead>
                      <TableHead>称号</TableHead>
                      <TableHead class="text-right">年度</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow v-for="row in sampleRows" :key="row.name">
                      <TableCell class="wrap-anywhere whitespace-normal">{{ row.name }}</TableCell>
                      <TableCell><Badge :variant="row.tier">{{ row.title }}</Badge></TableCell>
                      <TableCell class="tabular-nums text-right">{{ row.year }}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </div>
            <div class="min-w-0">
              <p class="mb-2 text-sm font-medium">紧凑表格 · 行高 36px（弹窗内核对表）</p>
              <!-- `data-density` 与 `.data-table` 必须落在同一个 table 元素上,
                   故这里直接写 table 标签;内部单元格仍用共享表格组件。 -->
              <table class="data-table w-full rounded-md border" data-density="compact">
                <caption class="sr-only">紧凑表格样例</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>核对项</TableHead>
                    <TableHead>原文</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>统一社会信用代码</TableCell>
                    <TableCell class="tabular-nums">91330211255994457P</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>认定年度</TableCell>
                    <TableCell class="tabular-nums">2024</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>批次</TableCell>
                    <TableCell>第三批</TableCell>
                  </TableRow>
                </TableBody>
              </table>
            </div>
          </div>

          <template #footer>
            <div class="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
              <p class="text-muted-foreground text-xs">
                工具栏 32px · 表单/抽屉内控件 36px · 抽屉档位 360 / 448 / 560px。
              </p>
              <Button size="sm" @click="drawerOpen = true">打开抽屉示例</Button>
            </div>
          </template>
        </DataTableCard>

        <dl class="divide-y border-t px-4 text-sm">
          <div
            v-for="token in category.tokens"
            :key="token.name"
            class="flex items-center justify-between gap-3 py-2"
          >
            <dt class="min-w-0">
              <code class="font-mono text-xs">{{ token.name }}</code>
              <span class="text-muted-foreground ml-2 text-xs">{{ token.role }}</span>
            </dt>
            <dd class="tabular-nums shrink-0 font-mono text-xs">{{ staticValue(token) }}</dd>
          </div>
        </dl>
      </div>

      <!-- 状态语义的 Badge 落地样例 -->
      <div v-if="category.id === 'status'" class="mt-3 flex flex-wrap gap-2">
        <Badge variant="success">已完成</Badge>
        <Badge variant="warning">需要核对</Badge>
        <Badge variant="error">加载失败</Badge>
        <Badge variant="info">进行中</Badge>
        <Badge variant="quiet">无状态</Badge>
      </div>

      <!-- 领域强调色附加的 Badge 落地样例 -->
      <div v-if="category.id === 'domain'" class="mt-3 flex flex-wrap items-center gap-2">
        <Badge variant="tier-1">小巨人</Badge>
        <Badge variant="tier-2">专精特新中小企业</Badge>
        <Badge variant="tier-3">创新型中小企业</Badge>
        <span class="text-muted-foreground flex items-center gap-1 text-xs">
          <span class="bg-mark-national size-1.5 rounded-full" aria-hidden="true" />
          <span class="bg-mark-municipal size-1.5 rounded-sm" aria-hidden="true" />
          金 / 藏青只做图形标记，不写文字
        </span>
      </div>
    </SectionCard>

    <DetailDrawer
      :open="drawerOpen"
      title="抽屉示例"
      description="宽度只选 floatingSize 档位，结构统一由 DetailDrawer 提供。"
      floating-size="standard"
      @update:open="drawerOpen = $event"
    >
      <div class="flex flex-col gap-3 text-sm">
        <p>固定头部 + 独立滚动主体 + 可选固定底栏。业务侧抽屉经 `[data-floating-drawer]` opt-in，三档宽度共用 `--shadow-drawer`。</p>
        <ul class="text-muted-foreground flex flex-col gap-1 text-xs">
          <li><code class="font-mono">compact</code> · 360px —— 简短说明与确认。</li>
          <li><code class="font-mono">standard</code> · 448px —— 默认档。</li>
          <li><code class="font-mono">detail</code> · 560px —— 完整资料与来源。</li>
        </ul>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <Button variant="outline" @click="drawerOpen = false">取消</Button>
          <Button @click="drawerOpen = false">保存</Button>
        </div>
      </template>
    </DetailDrawer>
  </WorkspacePage>
</template>
