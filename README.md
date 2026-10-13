# 专精特新企业称号台账 · 查阅看板

宁波市「专精特新」培育名录的**只读查阅看板**。Nuxt SPA(不启用 SSR)+ Drizzle + SQLite + shadcn-vue + Pinia Colada + VueUse。

**只读**:不做数据录入、不做比对、不做导入。台账数据的解析与入库是**项目外的前期工作**(见下)。

- 领域词汇:[GLOSSARY.md](./GLOSSARY.md)
- 数据模型:[docs/data-model.md](./docs/data-model.md)
- 决策记录:[docs/adr/](./docs/adr)
- 规格与工单:[.scratch/roster-board/](./.scratch/roster-board/)

## 数据从哪来

```
../pipeline/  ──写──▶  ./data/roster.db  ◀──读──  本 app
 解析 · 清洗 · 导入(项目外)                        只读查阅
```

- 本 app 只**读** `data/roster.db`。库由项目外的 **`../pipeline/`** 解析 `../经信局名单/` 与 `../工信部名单/` 后写入。
- app 的依赖里**没有**任何解析库(mammoth/tinyglobby/docx 等);这些属于 pipeline。
- 边界与理由见 [ADR-数据入库是项目外的前期工作](./docs/adr/2026-10-13-ingestion-is-outside-the-app.md)。

## 开发

```bash
# 1) 先由项目外的前期工作建库(见 ../pipeline/README.md)
#    cd ../pipeline && pnpm install && pnpm db:import --root ..

# 2) 再跑只读看板
pnpm install
pnpm dev          # http://localhost:3000
```

- 库默认在 `data/roster.db`;可用 `NUXT_DB_PATH` 指向别处。缺库时页面为空。
- `pnpm typecheck` / `pnpm test`(app 自身测试;不经过导入管道)。

## 页面

| 路由 | 内容 |
|---|---|
| `/` | 台账:按称号/来源/事件/年份/快照筛选、搜索、导出当前结果 |
| `/stats` | 统计概览,可下钻 |
| `/quality` | 数据质量清单 |
| `/enterprises/:id` | 企业详情:全部记录、事件与出处 |
