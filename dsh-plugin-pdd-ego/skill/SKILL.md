---
name: pdd-ego-listing
description: 拼多多多店铺上架（ego 版）。读素材包 product.json，经 ego-browser 打开商家后台发品页，依次填主图/标题/类目/详情图/品牌/属性/规格/SKU/预览图/参考价/运费模板，最后跑 34 项 validateForm；只填空与校验，绝不提交。用户说「拼多多上架」「上架这个素材包」「pdd发布商品」「多店铺上架」「换成XX运费模板」时使用。
---

# pdd-ego-listing（ego 版拼多多上架）

与 `pdd-product-listing`（Playwright 版）等价的上架执行层，底座换成 **ego-browser**（不需要 Chrome 调试端口、不需要 playwright-core）。

## 执行层在哪

执行层**随插件包分发**，位于本包的 `scripts/` 目录（与 `skill/` 同级），不需要手工指定路径：

| 文件 | 作用 |
|---|---|
| `scripts/pdd_flow_ego.mjs` | 执行层，105 个导出（原插件 74 个 API 全覆盖 + 运费模板/截图/辅助函数） |
| `scripts/run_listing_ego.mjs` | 10 步上架编排（查重→类目→主图标题→详情→品牌属性→**运费模板**→规格→SKU→预览→价格→校验） |
| `scripts/cli-ego.mjs` | 命令入口：`spaces` / `freight` / `current` / `run` / `probe` |
| `scripts/tools/build_product.py` | listing.json + 素材目录 → `product.json`（独立版，不依赖原插件） |
| `scripts/tools/read_excel.py` | 店透视/素材包 Excel → 结构化 SKU JSON（独立版，需要 `openpyxl`） |
| `scripts/tools/xlsx_to_product.py` | 整包一键生成 `work/listing.json` + `work/product.json`（read_excel + build_product 的胶水） |
| `scripts/ASK-BEFORE-LISTING.md` | **上架前必须问用户的清单**（完整版） |
| `scripts/run-config.json` | 上架参数；仓库里只放模板 `run-config.example.json` |

**优先用插件工具，不要自己拼路径。** 工作目录、ego-browser、Python 解释器都由插件解析后注入：

- `pdd_ego_spaces` — 列店铺 space
- `pdd_ego_freight_templates` / `pdd_ego_set_freight_template` — 列/选中运费模板
- `pdd_ego_probe_shop` — 只读探测当前页面
- `pdd_ego_run_listing` — 跑上架编排（可传 `configPath` / `space` / `product` / `freightTemplate` / `saveDraft`）
- `pdd_ego_xlsx_to_product` — 从 `<包>/商品信息.xlsx` 生成 `work/product.json`（新素材包必做）
- `pdd_ego_build_product` / `pdd_ego_read_excel` — 素材与 Excel 转换

只在工具不可用时才退化到命令行；命令行里的脚本路径由持有绝对路径的一方给出，**不要猜路径**。

## 素材包准备（没有 product.json 时先做这步）

素材包通常只有 `<包>/商品信息.xlsx` 加一个 `拼多多/<包名>/{商品轮播图,商品详情,预览图}`，**没有 `work/product.json`**。这时先跑：

```
pdd_ego_xlsx_to_product({ assets: "<包目录>" })
```

- 产出 `<assets>/work/listing.json` 与 `<assets>/work/product.json`；返回值里的 `product` 是可直接传给 `pdd_ego_run_listing` 的绝对路径
- **属性直接取自 Excel 的产品属性列**（材质/特点/风格/图案元素/墙贴样式/厚度/产地/工艺/适用空间/底胶种类/中层厚度…），**不需要参考包**；多值单元格（逗号/顿号/斜杠分隔）会拆成候选数组
- 品牌单独走 `brand` 字段，不进 `attributes`
- `attrsFrom` 只是**可选的覆盖**：给了参考 `product.json` 才按同名键覆盖 Excel 的值，用于修正个别字段，不是必需品
- 属性值**不保证都能被发品页下拉接受**：填不中的项会进 `needReview`，交付时必须原样列给用户，不要当成已填完
- 生成后会提示哪些图接近 3MB 上限，按需先压图

## 运行时配置（都有默认值，按需覆盖）

| 配置项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `egoBrowser` | `PDD_EGO_BROWSER` | 自动探测 | ego 安装目录（含版本子目录）→ PATH |
| `pythonPath` | `PDD_PYTHON` | 自动探测 | 优先选能 `import openpyxl` 的解释器 |
| `workDir` | `PDD_WORK_DIR` | 包内 `scripts/` | 执行层目录，一般不要改 |
| `logFile` | `PDD_EGO_LOG` | 系统临时目录 | 包可能装在只读位置，日志不落包内 |
| `timeoutMs` | — | 900000 | 单次调用超时 |
| `allowSubmit` | — | `false` | **提交总开关**，只有显式开启才可能提交 |
| `verbose` | — | `false` | 调试日志 |

## 上架前必问（硬规则）

真跑之前先问用户，5 项：

1. 上架到哪个店铺？（先跑 `pdd_ego_spaces` 确认 spaceId，不确定就问用户）
2. 用哪个素材包？（`product` 指向 `.../work/product.json`）
3. **运费模板**：用店铺默认，还是指定某个模板？（`freightTemplate`；不确定就填 `"__ASK__"`，流程会先列出该店模板再停下）
4. 是否保存草稿？（默认 **false**，只有显式 `saveDraft:true` 才存）
5. 是否允许提交？（**默认不提交**；必须当轮明确授权，且插件配置 `allowSubmit:true`）

> 运费模板**每店不同**，自建模板各店各异：以发品页下拉枚举为准（`pdd_ego_freight_templates`），物流工具页不等于全集。

## 上架参数（`run-config.json`）

```json
{
  "spaceId": 3,
  "product": "<素材包>/work/product.json",
  "saveDraft": false,
  "skipDup": true,
  "freightTemplate": "__ASK__",
  "submitAfterPass": false,
  "allowSubmit": false,
  "shot": false,
  "video": ""
}
```

- `freightTemplate`：留空=保持店铺默认；填模板名=选中并回读；`"__ASK__"`=先列模板停下等用户确认
- `shot:true`：每步截图到 `<素材包>/shots/`（可用 `shotDir` 改）
- `skipDup:true`：跳过查重（仅测试用）
- `assetRoots`：白底图/视频的搜索根目录，可覆盖默认搜索顺序
- `submitAfterPass` 与 `allowSubmit` **必须同时为真**才会提交；只开 `submitAfterPass` 会打印「已跳过提交」并继续

## 商品视频（④b）

流程里有独立的 **④b 商品视频** 步骤：定位「商品视频」区（排除左侧发布助手侧栏误命中）→ 该区的
`input[type=file]` → `setInputFiles` → 轮询该区状态（`found / imgs / hasError / placeholder / done`）。

**视频来源（二选一）**

1. **自动解析**：素材包目录里任意层级、路径含「视频」字样的 `*.mp4` 会被自动找到
   （例如 `<素材包>/拼多多/<包名>/视频/视频_1.mp4`）
2. **显式指定**：`run-config.json` 里 `"video": "<mp4 绝对路径>"`

素材包没有视频时该步**自动跳过**，校验项 `product_video` 记为 pass（`素材包无视频(跳过)`），
不会因为缺视频卡住整条链路。

**平台规格（实测能过的）**

| 项 | 要求 | 实测 |
|---|---|---|
| 时长 | ≤ 60s | 19.6s |
| 大小 | ≤ 3MB | 2.3MB |
| 宽高比 | 1:1 / 16:9 / 3:4 | 720×960（3:4） |
| 编码 | h264 + aac | h264/aac |

上传耗时约 **35–43 秒**（`how:"setInputFiles"`）；已存在视频时走 `already` 分支，不重复上传。

**校验口径**（`validateForm`）

- `videoDone` → `product_video: pass`
- `videoExpected === false`（素材包无视频）→ `product_video: pass（跳过）`
- 其余（页面上找不到视频、有错误标记）→ `product_video: fail`

**排障**：若视频区报 `视频上传错误`，流程会先清区重试一次，仍失败才跳过；
平台对视频还有「时长/尺寸/编码」硬校验，被拒时先 `ffprobe` 看一眼再重试。

## 关键差异（相对 Playwright 版）

- 连接：`claimTaskSpace` / `takeOverTaskSpace`（spaceId）而不是 `connectShop(port)`
- 速度：`fillSkuRowsCDP` 用 CDP `Runtime.evaluate` 一次性填（绕开 ego evaluate 15s 上限），72 SKU ≈ 66s
- 运费模板：新增 4 个函数（`ensureFreightOtherMode` / `readFreightTemplate` / `listFreightTemplates` / `setFreightTemplate`），选择逻辑与属性下拉完全一致
- 导航：`gotoUrl` 容错（ego 的 `goto` 只等 `load` 且 15s）

## 红线

- 不新建运费模板、不改价、不上下架、不碰订单客服投流
- 不代替用户点「提交并上架」；提交必须 `allowSubmit` 与 `submitAfterPass` 双开
- 失败就停：`freight_template_failed` / `category_mismatch_on_form` / `spec_table_failed` 都要人工介入，不要绕过
