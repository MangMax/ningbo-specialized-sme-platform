# 15 — 缺统代:代理联网补齐(带出处)

**What to build:** 生成**缺统代清单**,代理**联网查询**补齐,写回并**留出处**;查不到保持待确认。

**Blocked by:** 11

**Status:** done(机制已通 + **真实库 136 家逐条查完**;种子覆盖 136:补 38 / 占用 21 / 待人工 70 / 查不到 4)

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

> ⚠️ **更正(评审整改后)**:CLI 已**不接受** `NUXT_DB_PATH`,也不允许打开正式库 —— 现在必须
> `vp run lookup:uscc --db <隔离副本> --check`(且 `--check` 只读、不设 WAL、不迁移)。上面这条是首轮当时的记录。

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

## 收尾(2026-10-15)—— 余 129 家逐条查完 + 评审整改

### 数字闭合(两套口径分开列)

**A. 本轮种子分类(129 家逐条核验)**:`confirmed` **58** · `ambiguous` **67** · `not_found` **4** = **129** ✅
**B. 真实库 133 家缺统代的分档**(隔离 WAL 副本 `--check`):可补 **38** · 占用 **21** · 待人工 **70** · 查不到 **4**;
等式 **38 + 21 + 70 + 4 = 133** ✅
**C. 种子总量 136 条** = 前轮 7(4 confirmed + 3 ambiguous)+ 本轮 129(58/67/4)。
`待人工 70` = 本轮 ambiguous 67 + 前轮 ambiguous 3;`占用 21` = 码已被库内**改名主体**占用的 confirmed。

**清单基准核对(不沿用旧数字)**:当前真实库 `uscc_norm is null` = **133** = 余 129 + 种子覆盖的 4;
133 + 前轮已落库 3 = **136**(初始基准)。名字与库内 `name_norm` **逐条比对一致(0 处漂移)**。

### 证据门槛(可离线核对,已落成机器闸)

`confirmed` 必须**实际打开内容页**,正文里企业名与**完整 18 位统代同片配对**;退而「单企业页:
标题含企业名 + 全页恰一个合法统代」。**片段里必须同时含名与完整码**。`source` 必须是**内容页 URL** ——
拒绝搜索结果/跳转页(`/s` `/web` `/search` `/link`)、登录/验证码路径、渠道占位。
闸门在 `src/uscc-lookups.ts#validateLookups`(note 须含名 + 完整码 + 出处形态),并由
`#assertLookupsValid` **fail closed**:**两条写路径**(`db:import`、`lookup:uscc --apply`)都在
**任何写库前**执行它,不合格就**整次终止(非零退出)** —— 不再「打印 warning 后照写」。
`--check` 用写入方的**干跑**(`dryRun`),报的与写的**逐条一致**。
逐条证据片段另存 `pipeline/reports/uscc-lookup-evidence-20261015.json`。

### 评审整改(独立复核判 BLOCKED 的 7 条)

核心问题:7 条 confirmed 的 note **不含其统代**(190 字前缀把码截断了)。逐条重取可离线复核的原文片段:

| 企业 | 处置 | 证据来源(换源后) |
| --- | --- | --- |
| 宁波韵升汽车电机系统有限公司 | confirmed | `baike.shuidi.cn` 内容页(换源) |
| 宁波伊斯特通风工程有限公司 | confirmed | `likuso.com` 内容页(换源) |
| 宁波安可新光源照明有限公司 | confirmed | `likuso.com` 内容页(换源) |
| 宁波雪路登智能科技有限公司 | confirmed | `zk71.com` 内容页(换源) |
| 宁波山迪光能技术有限公司 | confirmed | `baike.so.com` 内容页(换源) |
| 宁波首耐特金属制品有限公司 | **ambiguous(降级)** | 水滴信用原页现为**验证码墙**、保存片段**不含企业名**、另寻无源 |
| 浙江备得福食品有限公司 | **ambiguous(降级)** | 同上 |

同批复核另降级:**宁波哥爱帮科技**(来源页主体现名为「宁波立志夹持科技有限公司」,清单名仅其**曾用名**)、
**浙江朗维网络科技**(来源页主体现名为「宁波朗维网络科技有限公司」,清单名仅其曾用名);
**宁波德诚工具**(原 wenku 文档页现为「百度安全验证」)另据 likuso 内容页**补证保留**。

- **区划码口径更正**:先前用「区县→区划码表」把朗维按「区划不符」降级 —— 该表只在 scratch、**无仓库内依据**,
  且与来源页自述的「行政区划:海曙区」冲突。已**撤掉该主张**:朗维改按「主体名不一致(曾用名)/须人工」降级,
  不再引用区划映射。
- **低证据来源逐条复核**:`zhidao.baidu.com` 8 条等 UGC/聚合页**逐条**核对,均为**页面正文内**「企业名 + 完整统代」
  同现(非搜索片段)⇒ 保留;无此证据的一律降级。

### 未命中边界(不得声称全查完的地方)

- **67 家 `ambiguous`** —— 候选页挡在企查查/天眼查/启信宝**登录墙**、爱企查移动版 **JS 空壳**、
  `ai.so.com` **空结果页**、`1688/51sole` 0 字页;或主体名不一致/曾用名。库里保持 `uscc_missing`;
  精确名单见 `reports/uscc-lookup-20261015.md`。
- **4 家 `not_found`** —— 象山县时利模塑、象山县刻铭热流道、象山县百斯特机械制造、
  灵峰矿山机械(象山县);360 检索**无任何候选页**。
- 本轮**未用**搜狗/必应(反爬限流);检索只用 360 一引擎 ⇒ 「未找到」是**单引擎**口径,不等于全网无。

### 复核(只对隔离副本;WAL 安全)

```bash
sqlite3 正式库 "VACUUM INTO '/tmp/uscc2-audit/vac.db'"   # 或 .backup —— 不要 cp(WAL 未并入)
cp /tmp/uscc2-audit/vac.db /tmp/uscc2-audit/vac2.db
vp run lookup:uscc --db /tmp/uscc2-audit/vac.db  --check   # **只读**打开:不迁移/不写种子/不设 WAL
vp run lookup:uscc --db /tmp/uscc2-audit/vac2.db --apply    # 只写该副本
```

- 不变量:`enterprise/record/record_event/record_evidence` 计数**逐表不变**(7352/19729/21189/21189);
- `--apply`:无统代 **133 → 95**(补 **38**);`uscc_conflict` **21**;
- **正式库全程未写**(mtime 与缺统代数 133 操作前后不变)。

**三档全表 / 逐条来源 URL / 证据片段**:`pipeline/reports/uscc-lookup-20261015.md` +
`pipeline/reports/uscc-lookup-evidence-20261015.json`。

## 重放证据(真实库)

```
$ cp 正式库 /tmp/.../subset.db
$ sqlite3 subset.db "UPDATE enterprise SET uscc_norm=NULL,… WHERE uscc_norm IN (三个种子里已补上的码);"
   → missing=136                      # 回到「查之前」
$ NUXT_DB_PATH=subset.db vp run lookup:uscc --apply      # (首轮写法;现须 `--db subset.db`)
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
- 真实库跑通:补 3 / 占用 1 / 待人工 3,逐条带出处;独立评审 5 条已逐条加固;**等输入重放**验证通过。
- **余 129 家逐条查完(2026-10-15)**:种子补到 **136** 条,覆盖全部缺统代主体;
  真实库 `--check` / 隔离 `--apply` 双跑,三档精确闭合(见上「收尾」一节)。

**未完成**
- 无(本票范围内)。余下 67 家 `ambiguous` + 4 家 `not_found` **不是「未查」,是「查过、未确认」** ——
  按「空值优于错误值」留 `uscc_missing`,精确名单在报告里;要推进需**换通路**(过登录墙 / 多引擎),
  属新工作,不在本票。

**已知缺口**
- **只动 `enterprise`,不落 `record_evidence` / 不建 `uscc_source`**:出处活在**种子文件**里(见上「有意偏离」)。
  好处是可重放、可回退;代价是**出处不出现在 app 的页面上**(app 只读库)。若后续要在页面上展示「来源」,
  需另开一票(且要在**不破坏可重放**的前提下)。
- **待确认清单现已有固定文件**:`pipeline/reports/uscc-lookup-20261015.md`(三档全表 + 逐条来源 URL +
  未命中名单,可随批次更新)。`pipeline/reports/pending-issues.md` 是 `spztx-data-cleaning` 技能的固定产物,
  **本票未动它**(那是另一条流程)。
- 种子的**名称键**依赖 `nameKeys`(「宁波X / X」等价写法),该表来自**原始来源互证**;若某企业只有联网一条证据,
  其名称键不会被 `nameKeys` 归一 —— 即**种子的键必须与库里 `name_norm` 逐字对齐**,否则命中不了
  (CLI 的「种子未匹配到主体」一栏就是防这个;本轮 129 家逐条比对 **0 处漂移**)。
- **检索只用 360 单引擎**:搜狗/必应本轮未用(反爬限流)⇒「未找到」是**单引擎**口径,不等于全网无。
  67 家 `ambiguous` 里多数是**平台登录墙/JS 空壳**挡住的,换通路可能再核出一部分。
- **巨潮资讯网(cninfo)公司资料接口对上市公司稳定可查**,是上市主体的首选出处。

**分支**:`feat/uscc-lookup-batch`(base `feat/uscc-lookup` 之后的本地提交 8e8fee2)。
