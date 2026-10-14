# 15 — 缺统代:代理联网补齐(带出处)

**What to build:** 生成**缺统代清单**,代理**联网查询**补齐,写回并**留出处**;查不到保持待确认。

**Blocked by:** 11

**Status:** done(机制已通 + 真实库跑通;136 家中种子覆盖 7 家,余下交后续批量查)

## 现状

- **136 家无统代**(重建后)。已实测:**拿工信部三份导出的名称去撞,命中 0** ⇒ 只剩**联网查**。
- 既有的「回填」只吃**原始来源**(公布文件 + 工信部);联网查是**新增的第三个来源**,必须**同样严守安全阀**:查到就写 + 留出处,**查不到不猜**。

## 要做的

1. **清单**:从库里导「无统代」的企业(名 + 区县 + 出处),成批给代理。
2. **联网查**:按名查公开工商信息,拿「确切统代 + 来源 URL」;**同名多主体/跨市同名要列出来让人定**,不自动取。
3. **写回**:只能写 `uscc_missing` 的;**已有统代不覆盖**;候选被占用 → `uscc_conflict` + 留空(与既有规则一致)。
4. **出处**:**可审计、可回退**。

## 实现(与规格的一处**有意偏离**)—— 结果落**种子文件**,不落库

**偏离**:规格第 4 条建议「记到 `record_evidence` 或专门的 `uscc_source`」。**没有采用** —— 理由是**可重放**:
导入是**追加式**的、且要**重建**(票 14 之后还会重跑)。把查到的统代直接写进 `enterprise.uscc_norm`,
**下一次重建就全没了**。所以查到的结果落在 **`src/uscc-lookups.ts`** —— 一份**提交进仓库**的种子,
由 `db:import` 作为**第三来源**读取,与 `src/name-aliases.ts` 一个路子(那份错字表也是已提交的种子)。
这也是**最简的「可回退」**:删掉种子里的那条、重跑,该企业即回到「无统代」。

| 交付 | 位置 |
| --- | --- |
| 种子模块(企业名 → 统代 + 出处 + 查得日期 + 状态 + 区县 + 备注) | `src/uscc-lookups.ts` |
| 种子索引 / 自检(缺出处、日期或校验位不过即拒) | `uscc-lookups.ts#lookupIndex` / `#validateLookups` |
| **唯一判定函数**(写与报共用) | `src/enrich.ts#judgeLookup` |
| 第三来源回填(只补缺失,不覆盖、不归并、占用打标) | `src/enrich.ts#backfillUsccFromLookups` |
| CLI:导清单 / 校种子 / 单独回填(**本身不联网**) | `scripts/lookup-uscc.ts`(`vp run lookup:uscc`) |
| 接进导入 | `scripts/import.ts`(第三来源 + 逐条审计 + `--report` 的 `lookups` 段) |
| 测试 | `tests/uscc-lookup.test.ts`(11 例) |
| 真实库核查报告 | `pipeline/reports/uscc-lookup-20261014.md` |

**CLI 不联网**:联网由代理/人在会话里做;CLI 只负责「导清单 / 校种子 / 落库」,**不假装查过**。
(本轮 7 条样本是我在会话里用搜狗/巨潮资讯网实查后手工落种子的。)

## 安全阀(逐条对齐 `data-integrity/SPEC.md`)

- **只补 `uscc_missing`**:只动 `uscc_norm is null` 的主体;**已有统代绝不覆盖**。
- **联网查是单一来源 ⇒ 不归并**:回填函数只有「`uscc_norm = ?` + 标记维护」,**没有**搬记录 / 删主体的能力。
  实测回填前后 `enterprise / record / record_event / record_evidence` 四表计数不变、记录归属不变。
- **候选被占用** → 留空 + `uscc_conflict`(不覆盖、不迁移、不归并)。
- **同名多主体 / 跨市同名 / 区县对不上 / 弱相似** → **只列出不写**,库里保持 `uscc_missing`。
- **空值优于错误值**:查不到不写。

## 测试(全绿)

`vp check` ✅ · `vp test` ✅ **7 文件 / 109 例** · app `pnpm typecheck && pnpm test` ✅ **17 文件 / 308 例**

- [x] fixture:种子里有 → **补上**(`SeedCoversMissingUscc_FillsIt`)
- [x] fixture:种子那条**已属他人** → **不覆盖、不迁移、打 `uscc_conflict`**(`UsccAlreadyOwned_NoOverwriteNoMigration_FlagsConflict`)
- [x] fixture:种子**没有**的 → 保持 `uscc_missing`,不进任何推断结果(`NotInSeed_StaysUsccMissing_NotInFilled`)
- [x] 同名多主体 → 列待人工、一个都不动(`SameNameMultipleSubjects_ListedForHuman`)
- [x] 跨市同名(文本口径,`district` 给出)→ 不写(`CrossCitySameName_NotWritten`)
- [x] **跨市同名(机器口径)**:`district` 留空,靠**统代区划码**拦下外地统代(`OutOfTownDivisionCode_NotWritten_EvenWithoutDistrict`)
- [x] 「查过、查不到」与「没查过」分开,不进 `inferred`(`NotFoundEntry_StaysUsccMissing_ListedAsSearched`)
- [x] 种子自检:缺出处/日期/校验位不过 → 拒(`ConfirmedWithBadChecksum_FailsSeedValidation`、`SeedPassesOwnValidation_AndEveryCodeIsLegal`)
- [x] **重建可重放**:全新空库再跑一次,同样的统代回来(`RealSeed_ReplaysAfterRebuild`)

## 独立评审(`code-review` 技能)后的加固

评审报了 5 条,已逐条处理:

1. **CLI 的 `--check` 与实际落库可能不一致**(两处各写一份 guard)⇒ 抽出**唯一判定函数**
   `src/enrich.ts#judgeLookup`,`db:import` 的**写**与 `--check` 的**报**共用它。
2. **跨市判定在 `district` 留空时被跳过**(可能写进外地统代)⇒ 加**机器口径硬判据**:统代区划码不在 `3302*` 即拦
   (`normalize.ts#usccInNingbo`);`district` 降级为**软判据**。
3. **种子自检没接进 `db:import`** ⇒ `db:import` 读种子前先自检,不合格条目**显式告警且不采用**。
4. **「查不到」与「没查过」分不开** ⇒ 加 `status: "not_found"`,并进待确认清单(不进 `filled`)。
5. 「待人工」无固定存放处 ⇒ 本轮落 `pipeline/reports/uscc-lookup-20261014.md`(见「已知缺口」)。

另清掉一处死表达式(`appRoot === "" ? "" : ""`)与逐行重复的 `index.get`。


## 验收(真实库实测)

`NUXT_DB_PATH=<正式库> vp run lookup:uscc --check` → **缺统代 136 家;种子命中 7;可补 3;待人工 3;占用 1**。

**可补(3)—— 写回的统代全部带出处:**

| 企业 | 统代 | 出处 |
| --- | --- | --- |
| 宁波德诚工具有限公司 | `9133021276454960X8` | https://wenku.baidu.com/view/d23c709fc381e53a580216fc700abb68a982ada1.html |
| 宁波容百新能源科技股份有限公司 | `91330281316800928L` | https://www.cninfo.com.cn/data20/companyOverview/getCompanyIntroduction?scode=688005 |
| 锦浪科技股份有限公司 | `91330200778244188M` | https://www.cninfo.com.cn/data20/companyOverview/getCompanyIntroduction?scode=300763 |

**被占用(1)—— 留空 + `uscc_conflict`,不归并:** 宁波海尔施基因科技有限公司
(查得 `9133020158051033XQ` 已属库内另一主体「宁波海尔施基因科技**股份**有限公司」;改名不改统代是强证据,
但随之而来的是「两个主体同法人」⇒ 归并动作只能由原始双来源触发,**联网查不得归并** ⇒ 留空待人工)。

**待人工(3)—— 只列出不写:** 宁波市三个阿姨信息科技有限公司(跨市同名:宁波/深圳)、
宁波欧陆创意家居有限公司(弱相似:「有限」→「**股份**有限」无曾用名证据)、
爱芯元智半导体(宁波)有限公司(地区对不上:统代属上海青浦,法人迁址不换码)。

**仍缺 129 家**:本轮**只做通机制**,不为凑数瞎填 —— 余下交后续批量查。

**重建重放(本票核心断言):** 见下「重放证据」一节。✅

## 重放证据(真实库)

```
$ cp 正式库 /tmp/.../subset.db
$ sqlite3 subset.db "UPDATE enterprise SET uscc_norm=NULL,… WHERE uscc_norm IN (三个种子里已补上的码);"
   → missing=136                      # 回到「查之前」
$ NUXT_DB_PATH=subset.db vp run lookup:uscc --apply
   扫描无统代 136 家;补上 3;被占用 1;待人工 3;种子无记录 129
   无统代 136 → 133(减少 3)
$ sqlite3 subset.db "select name,uscc_norm from enterprise where name in (三家);"
   宁波德诚工具有限公司|9133021276454960X8
   宁波容百新能源科技股份有限公司|91330281316800928L
   锦浪科技股份有限公司|91330200778244188M   # 同样的统代回来了,且都带出处
# 记录层未被动过(与原始库逐表相等):
   enterprise 7352/7352 · record 19729/19729 · record_event 21189/21189 · record_evidence 21189/21189
```

> **一次**全量文件库重建(空身份层 + 24 份 `stored_file` 重跑 `db:import`)也跑通了,**没有报错、
> 没有出现幻影企业**;但那不是忠实重建 —— 19 份扫描 PDF 仍无解析通路(票 14 的 OCR),
> 输入面缺一半,所以上面的**等输入重放**才是本票的证明。全量重建待输入面补齐后再做。

## 已完成 / 未完成 / 已知缺口

**已完成**
- 种子模块 + 索引/自检、**唯一判定函数**、第三来源回填、CLI(导清单/校种子/单独回填)、
  接进 `db:import`(含种子自检告警)、README、「联网补齐」一节、11 例测试、真实库核查报告。
- 真实库跑通:补 3 / 占用 1 / 待人工 3 / 仍缺 129,逐条带出处;独立评审 5 条已逐条加固;**等输入重放**验证通过。

**未完成**
- **129 家仍无统代** —— 本票只做通机制,未批量查(按票面要求「不要为了凑数批量瞎填」)。
- 票面「136 家**逐条**给出三档」:本轮**逐条只在种子覆盖的 7 家里成立**;余 129 家还没有档位。

**已知缺口**
- **只动 `enterprise`,不落 `record_evidence` / 不建 `uscc_source`**:出处活在**种子文件**里(见上「有意偏离」)。
  好处是可重放、可回退;代价是**出处不出现在 app 的页面上**(app 只读库)。若后续要在页面上展示「来源」,
  需另开一票(且要在**不破坏可重放**的前提下)。
- **「占用 / 待人工」只在终端与 `--report` 里,没有固定存放文件** —— 本轮固化在
  `pipeline/reports/uscc-lookup-20261014.md`(快照)。批量查时应做成**可更新的待确认清单**。
  (`pipeline/reports/pending-issues.md` 是 `spztx-data-cleaning` 技能的固定产物,**本轮未动它**。)
- 种子的**名称键**依赖 `nameKeys`(「宁波X / X」等价写法),该表来自**原始来源互证**;若某企业只有联网一条证据,
  其名称键不会被 `nameKeys` 归一 —— 即**种子的键必须与库里 `name_norm` 逐字对齐**,否则命中不了(CLI 的
  「种子未被库内缺统代名单命中」一栏就是防这个)。
- **Sogou/DDG 会反爬**:本轮 8 家里只有 3 家拿到可用结果(其余为限流空页),批量查需要退避与多引擎轮换。
  **巨潮资讯网(cninfo)公司资料接口对上市公司稳定可查**,是上市主体的首选出处。

**分支**:`feat/uscc-lookup`。
