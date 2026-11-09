---
name: pdd-ego-listing
description: 拼多多多店铺上架（ego 版）。读素材包 product.json，经 ego-browser 打开商家后台发品页，依次填主图/标题/类目/详情图/品牌/属性/规格/SKU/预览图/参考价/运费模板，最后跑 34 项 validateForm；只填空与校验，绝不提交。用户说「拼多多上架」「上架这个素材包」「pdd发布商品」「多店铺上架」「换成XX运费模板」时使用。
---

# pdd-ego-listing（ego 版拼多多上架）

与 `pdd-product-listing`（Playwright 版）等价的上架执行层，底座换成 **ego-browser**（不需要 Chrome 调试端口、不需要 playwright-core）。

## 脚本位置（默认 `D:/egoscripts`）

| 文件 | 作用 |
|---|---|
| `pdd_flow_ego.mjs` | 执行层，105 个导出（原插件 74 个 API 全覆盖 + 运费模板/截图/辅助函数） |
| `run_listing_ego.mjs` | 10 步上架编排（查重→类目→主图标题→详情→品牌属性→**运费模板**→规格→SKU→预览→价格→校验） |
| `cli-ego.mjs` | 命令入口：`spaces` / `freight` / `current` / `run` / `probe` |
| `tools/build_product.py` | listing.json + 素材目录 → `product.json`（独立版，不依赖原插件） |
| `tools/read_excel.py` | 店透视/素材包 Excel → 结构化 SKU JSON（独立版） |
| `ASK-BEFORE-LISTING.md` | **上架前必须问用户的清单** |

## 上架前必问（硬规则）

真跑之前先问用户，5 项：

1. 上架到哪个店铺？（`spaceId`：1/2=店铺A，3/4=店铺B，5/6=店铺C；不确定先跑 `spaces`）
2. 用哪个素材包？（`product` 指向 `.../work/product.json`）
3. **运费模板**：用店铺默认，还是指定某个模板？（`freightTemplate`；不确定就填 `"__ASK__"`，流程会先列出该店模板再停下）
4. 是否保存草稿？（默认 **false**，只有显式 `saveDraft:true` 才存）
5. 是否允许提交？（流程本身永不提交，提交必须当轮明确授权）

> 运费模板**每店不同**（自建模板各店各异）：店铺A有 `偏远就不发`/`包邮默认模板-20240228113917`，店铺B有 `东北三省不包邮`/`新西外`/`偏远不包邮`，店铺C有 `新西青内不发货`。以发品页下拉枚举为准，物流工具页不等于全集。

## 运行方式

```powershell
# 1) 列店铺 space
ego-browser nodejs -e "await import('file:///D:/egoscripts/cli-ego.mjs')"   # 需 PDD_CMD=spaces

# 2) 列某店运费模板（不选）
#    PDD_CMD=freight, PDD_SPACE=3

# 3) 跑上架（读 D:/egoscripts/run-config.json）
ego-browser nodejs -e "await import('file:///D:/egoscripts/run_listing_ego.mjs')"
```

`run-config.json` 字段：

```json
{
  "spaceId": 3,
  "product": "D:/assets/DZ-洞石墙纸-店1-链1/work/product.json",
  "saveDraft": false,
  "skipDup": true,
  "freightTemplate": "__ASK__",
  "shot": false
}
```

- `freightTemplate`：留空=保持店铺默认；填模板名=选中并回读；`"__ASK__"`=先列模板停下等用户确认
- `shot:true`：每步截图到 `<包目录>/shots/`（原版等价物是末尾一张 `final.png`，`shotDir` 设置时自动拍）
- `skipDup:true`：跳过查重（仅测试用）

## 关键差异（相对 Playwright 版）

- 连接：`claimTaskSpace` / `takeOverTaskSpace`（spaceId）而不是 `connectShop(port)`
- 速度：`fillSkuRowsCDP` 用 CDP `Runtime.evaluate` 一次性填（绕开 ego evaluate 15s 上限），72 SKU ≈ 66s
- 运费模板：新增 4 个函数（`ensureFreightOtherMode` / `readFreightTemplate` / `listFreightTemplates` / `setFreightTemplate`），选择逻辑与属性下拉完全一致
- 导航：`gotoUrl` 容错（ego 的 `goto` 只等 `load` 且 15s）

## 红线

- 不新建运费模板、不改价、不上下架、不碰订单客服投流
- 不代替用户点「提交并上架」
- 失败就停：`freight_template_failed` / `category_mismatch_on_form` / `spec_table_failed` 都要人工介入，不要绕过
