# 02 — Nitro 接口 `GET /api/comparison`

**What to build:** 把票 01 的 `getComparison` 薄封装成一个只读 Nitro 路由,供页面与导出取数。**接口只做参数解析、调用、分页/筛选,不含口径逻辑。**

**Blocked by:** 01 — 比对口径与计算纯函数

**Status:** ✅ done

## 接口契约

`GET /api/comparison?title=&direction=&page=&pageSize=`

- `title`:称号代号,可多值(`title=a&title=b`)或逗号分隔,与 `GET /api/records` 的写法保持一致(照现有路由的参数解析风格做)。缺省 = 全部称号。
- `direction`:`missing_in_miit` / `extra_in_miit`;缺省 = 两个方向都返回。
- `page` / `pageSize`:沿用现有路由的默认值与上限(**上限与 `lib/query.ts` 的 `MAX_PAGE_SIZE` 一致**,不要另起一套)。

响应:

```jsonc
{
  "rows": [
    {
      "enterpriseId": 123,
      "name": "…", "uscc": "…", "district": "…",
      "titleCode": "specialized_sme",
      "direction": "missing_in_miit",
      "curated": false,
      "evidence": { "matchedBy": "uscc", "otherSideUscc": null, "currentCity": "嘉兴市", "regStatus": "存续" }
    }
  ],
  "total": 337,
  "counts": { "specialized_sme": { "missing_in_miit": 337, "extra_in_miit": 13 },
              "innovative_sme":  { "missing_in_miit": 543, "extra_in_miit": 28 },
              "little_giant":    { "missing_in_miit": 0,   "extra_in_miit": 0 } }
}
```

- `counts` **不随 `page` 变化**,供页面 tab 徽标与两侧入口使用(前端不要自己数当前页)。
- 参数非法(未知 `title` / `direction`)→ 返回 400,带可读消息,与现有路由的错误风格一致。

## 交付物

- [x] `server/api/comparison.get.ts`,薄封装 `getComparison`,含参数解析与分页。
- [x] 复用现有路由的参数解析/错误处理风格(参考 `server/api/records.get.ts`)。
- [x] 不引入新依赖;不改 schema。

## 测试

- [x] 若现有路由有测试先例则补 fixture 路由测试:本仓无直接路由测试先例,此条件不适用;采用下项真实 HTTP 验证,未声称新增路由单测。
- [x] 无先例则至少手工 `curl` 验证并把响应贴进完成记录。

## 验收

- [x] `pnpm typecheck`、`pnpm test` 通过。
- [x] `curl 'http://localhost:3470/api/comparison?title=specialized_sme'` 返回 `counts.specialized_sme = { missing_in_miit: 337, extra_in_miit: 13 }`。
- [x] 非法参数返回 400。

**分支**:`feat/comparison-core`。**只提交本票涉及的文件。**


## 完成记录(2026-10-14)

- 新增 `server/api/comparison.get.ts`,仅解析/校验参数、调用 `getComparison`、分页。称号支持重复参数与 CSV;默认页码 1、每页 25,上限复用 `lib/query.ts` 的 `MAX_PAGE_SIZE = 200`。非法 title / direction 返回 400。
- 现有路由无直接测试先例,按票要求执行真实 Nitro HTTP 验证。`NUXT_IGNORE_LOCK=1 pnpm dev --port 3470` 启动独立验证服务(保留原有 3000 服务),读取 `data/roster.db`。
- `pnpm test`:108/108 通过;`pnpm typecheck`:退出码 0。
- curl 验证(用 `pageSize=1` 缩短响应;称号 total 仍为 350,counts 不受分页/筛选影响):

```sh
curl --fail --silent 'http://localhost:3470/api/comparison?title=specialized_sme&pageSize=1'
```

```json
{
  "rows": [{
    "enterpriseId": 7439,
    "name": "一临云（宁波）科技有限公司",
    "uscc": "91440300MA5G2DGE3R",
    "district": "前湾新区",
    "titleCode": "specialized_sme",
    "direction": "extra_in_miit",
    "curated": false,
    "evidence": {"matchedBy": "uscc", "otherSideUscc": null, "currentCity": null, "regStatus": null}
  }],
  "total": 350,
  "counts": {
    "little_giant": {"missing_in_miit": 0, "extra_in_miit": 0},
    "specialized_sme": {"missing_in_miit": 337, "extra_in_miit": 13},
    "innovative_sme": {"missing_in_miit": 543, "extra_in_miit": 28}
  }
}
```

- 另执行验收指定的无分页参数 curl `http://localhost:3470/api/comparison?title=specialized_sme`,断言 counts 为 `337 / 13`,返回 25 行、total 350。
- 单测外 Node `assert` 验证全称号/各方向 total、方向成员、counts 在方向/称号筛选与第 2 页时保持一致、默认 25 与上限 200、重复与 CSV title 等价,全部通过。
- 非法参数验证:`?title=unknown` → 400 / `Unknown title; expected little_giant, specialized_sme, innovative_sme`;`?direction=unknown` → 400 / `Unknown direction; expected missing_in_miit, extra_in_miit`。混合合法/非法称号与多值 direction 也返回 400。
- 不引入新依赖,不改 schema,不实现票 03/04。
