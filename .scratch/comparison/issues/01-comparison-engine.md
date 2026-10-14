# 01 — 比对口径与计算纯函数

**What to build:** 在 app 侧新增一个**不含 IO 的纯函数** `getComparison(db, opts)`(建议落在 `lib/comparison.ts`),按 `(enterprise_id, title_code)` 算出两个方向的差异集合与计数。这是本模块的**口径唯一落点**,后续接口与页面都调它;不得把口径散到接口或页面里。

**Blocked by:** —(现有 `lib/query.ts` 已提供全部所需记录,schema 无需改动)

**Status:** ready

## 口径(照 SPEC「口径」节实现,不自行发挥)

- **单位**:`(enterprise_id, title_code)`。
- **`J(T)`**:在经信局该称号下有**任意记录**的企业(含 `nurture` 入库培育、含 `review`,**不限年份**)。
- **`M(T)`**:在工信部该称号下有记录的企业。
- **判据 = `uscc_norm`**:`key(e) ∈ 另一侧的统代集合` 即视为命中;**不做名称回退**。`uscc_norm` 为 null 者按「另一侧无匹配」计入差异。
- **应纳未纳** `missing_in_miit` = `J(T)` 中 `uscc_norm` 不在 `M(T)` 统代集合者。
- **应出未出** `extra_in_miit` = `M(T)` 中 `uscc_norm` 不在 `J(T)` 统代集合者。
- **小巨人** `little_giant`:**恒返回空**(经信局无此来源)。
- **漂移 / 注销不排除**,但在结论里带上 `currentCity` / `regStatus` 供标注。

## 交付物

- [ ] `lib/comparison.ts`:导出 `getComparison(db, opts)` 纯函数 + 结果类型。
- [ ] 结果含 `{ rows, counts }`;`counts` 按 `称号 × 方向` 分组(**不依赖 rows 的当前页**)。
- [ ] 每行含:企业名 / 统代 / 区县 / 称号 / 方向 / `curated`(本期恒 false)/ `evidence`。
- [ ] `evidence` 至少含 `{ matchedBy, otherSideUscc, currentCity, regStatus }`(本期 `matchedBy` 恒为统代未命中或命中)。
- [ ] 复用 `lib/labels.ts` 的牌面文案(`TITLES` 等),不在本层另起中文名。

## 测试(必须)

`tests/comparison.test.ts`,直接 drizzle 插桩 fixture 库(**不经导入管道**),断言**外部行为**:

- [ ] 双侧各有、统代相同的企业 → **不**出现在任一方向。
- [ ] 仅经信局有的企业 → 只出现于 `missing_in_miit`。
- [ ] 仅工信部有的企业 → 只出现于 `extra_in_miit`。
- [ ] **口径回归(锁死)**:一个企业在经信局该称号下**只有 `nurture` 记录** → 仍计入 `J(T)`,即若工信部无匹配则出现在 `missing_in_miit`。**若这条测试红了,说明口径被改错。**
- [ ] **假阳性回归(设计意图)**:同一法人、两来源**统代不同** → **同时**出现在两个方向(如真实案例 `宁波市鄞州区规划设计院`)。
- [ ] `little_giant` → 两方向皆空。
- [ ] `counts` 与 rows 成员数一致(同口径)。

## 验收

- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 全绿(含上述新用例)。
- [ ] 在**真实库**上单测外跑一遍,断言 市专 `337 / 13`、创新型 `543 / 28`(SPEC「口径复算」),把数字写进票的完成记录。
- [ ] 未改 `db/schema.ts`、未新增迁移。

**分支**:`feat/tus-uploads`。**只提交本票涉及的文件。**
