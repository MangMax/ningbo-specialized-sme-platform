# 02 — Nitro 接口 `GET /api/comparison`

**What to build:** 把票 01 的 `getComparison` 薄封装成一个只读 Nitro 路由,供页面与导出取数。**接口只做参数解析、调用、分页/筛选,不含口径逻辑。**

**Blocked by:** 01 — 比对口径与计算纯函数

**Status:** ready

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

- [ ] `server/api/comparison.get.ts`,薄封装 `getComparison`,含参数解析与分页。
- [ ] 复用现有路由的参数解析/错误处理风格(参考 `server/api/records.get.ts`)。
- [ ] 不引入新依赖;不改 schema。

## 测试

- [ ] 若现有路由有测试先例,补一条:给定 fixture 库,`?direction=missing_in_miit` 返回的 rows 全部为该方向,且 `counts` 与不带过滤器时一致。
- [ ] 无先例则至少手工 `curl` 验证并把响应贴进完成记录。

## 验收

- [ ] `pnpm typecheck`、`pnpm test` 通过。
- [ ] `curl 'http://localhost:3470/api/comparison?title=specialized_sme'` 返回 `counts.specialized_sme = { missing_in_miit: 337, extra_in_miit: 13 }`。
- [ ] 非法参数返回 400。

**分支**:`feat/tus-uploads`。**只提交本票涉及的文件。**
