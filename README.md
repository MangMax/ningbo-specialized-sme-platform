# 专精特新企业称号台账 · 查阅看板

宁波市「专精特新」培育名录的**只读查阅看板**。Nuxt SPA(不启用 SSR)+ Drizzle + SQLite + shadcn-vue + Pinia Colada + VueUse。

- 领域词汇:[GLOSSARY.md](./GLOSSARY.md)
- 数据模型:[docs/data-model.md](./docs/data-model.md)
- 决策记录:[docs/adr/](./docs/adr)
- 规格与工单:[.scratch/roster-board/](./.scratch/roster-board/)

## 开发

```bash
pnpm install
pnpm db:generate   # 由 db/schema.ts 生成迁移
pnpm db:migrate    # 应用到 data/roster.db
pnpm dev           # http://localhost:3000
```

数据库文件默认在 `data/roster.db`,可用 `NUXT_DB_PATH` 覆盖。

## 数据来源

| 来源 | 路径 |
|---|---|
| 经信局 · 公布文件 | `../经信局名单/{省专,创新型}/**` |
| 工信部 · 三份导出 | `../工信部名单/*.xlsx` |

> `../经信局名单/公布文件名单全部整理版.xlsx` 仅作交叉校验,不作为看板输入(见 ADR-0004)。
