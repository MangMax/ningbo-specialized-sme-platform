import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Badge } from "./Badge.vue"

/**
 * 徽章 = 一行的语义标签。全站只有这一种标签语法。
 *
 * 相对官方默认改了两处(见 .scratch/ui-redesign/DESIGN.md):
 *  - 圆角 rounded-full → rounded-sm(4px)。全圆胶囊是消费级 App 的语言;
 *    政务台账用方标,和侧栏、表格的直角节奏一致。
 *  - 增加称号梯度 tier-1/2/3、quiet、dashed 三族变体。
 *    分级是这套台账的核心语义,梯度和线型都收进这里,页面不再各写一遍。
 */
export const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-sm border px-1.5 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,background-color,border-color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",

        /* 称号梯度:小巨人 → 专精特新中小企业 → 创新型中小企业。
           实心 → 浅底描边 → 中性描边,由高到低一路退下去。 */
        "tier-1": "border-transparent bg-tier-1-surface text-tier-1-on",
        "tier-2": "border-tier-2-line bg-tier-2-surface text-tier-2-on",
        "tier-3": "border-tier-3-line bg-tier-3-surface text-tier-3-on",

        /* 次级标签:比正文轻,不抢注意力 */
        quiet: "border-border bg-transparent text-muted-foreground",
        /* 虚线 = 尚未构成称号(入库培育) */
        dashed: "border-dashed border-border bg-transparent text-muted-foreground",
        /* 实线加粗 = 已成立、且是这条记录的由来的那一次(认定)。
           复核/维护 用普通描边,入库培育 用虚线 —— 三档靠**线型与线重**分开,
           不靠颜色,因为颜色已经被称号梯度占用。 */
        solid: "border-foreground/35 bg-transparent font-medium text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
