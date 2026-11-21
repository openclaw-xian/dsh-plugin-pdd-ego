# 上架前必须问用户的清单（ego 版）

> 规则：**每次真正跑上架之前，先问下面 5 项，用户答完再动浏览器。**
> 只做演练（不提交、不存草稿）时也要先跑 `pdd_ego_env` 确认前提齐全。

## 1. 必须问的 5 项

| # | 问题 | 落到配置 | 说明 |
|---|------|----------|------|
| 1 | 上架到哪个店铺？ | `spaceId` | 先用 `pdd_ego_spaces` 列出 space 再让用户选；不要按店名猜 spaceId |
| 2 | 用哪个素材包？ | `product` | 指向 `<素材包>/work/product.json` |
| 3 | **运费模板**：用店铺默认，还是指定具体模板？ | `freightTemplate` | 每店不同；不填=保持店铺当前/默认 |
| 4 | 这次是否保存草稿？ | `saveDraft` | **默认 false**（只有显式 true 才存） |
| 5 | 是否允许提交？ | `submitAfterPass` | **默认不提交**，且还需要插件配置 `allowSubmit: true` |

## 2. 运费模板怎么问

- 用户说“用默认” → `freightTemplate` 留空，保持店铺当前模板；
- 用户指定模板 → `freightTemplate: "<与发品页下拉完全一致的文本>"`；
- 用户还没想好 → `freightTemplate: "__ASK__"`：编排先列出该店真实可选模板后停下，不填 SKU、不存草稿。

判断依据只有一个：**发品页的下拉枚举**（`pdd_ego_freight_templates` 读到的就是它）。物流工具页里能看到的模板不等于发品页可选的集合。模板名必须逐字一致，否则会停在 `freight_template_failed`。

## 3. 运行前提

跑之前先调用 `pdd_ego_env`，它逐项返回：

- `egoBrowser`：本机 ego 浏览器路径（缺失时 `missing` 里会有 `ego-browser`，提示安装或配置 `PDD_EGO_BROWSER`）；
- `pythonPath` / `pythonHasOpenpyxl`：Python 解释器与 `openpyxl` 是否可用（缺失时提示安装或配置 `PDD_PYTHON`）；
- `spaces`：当前可连的店铺 space；
- `missing` / `hint`：直接告诉用户缺什么、要装什么。

缺项时先把结果告诉用户并停下，不要猜路径，也不要硬跑。

## 4. 红线

- 不新建运费模板、不改价、不上下架、不碰订单/客服/投流；
- 不代替用户点「提交并上架」；提交必须 `allowSubmit` 与 `submitAfterPass` 同时开启；
- 失败就停：`freight_template_failed` / `category_mismatch_on_form` / `spec_table_failed` / `detail_images_failed` 都交人工处理，不要绕过。

## 5. 交付口径

- 验收标准是 `validateForm` 的 `allPass`，并且页面「错误（N）」为 0；
- 属性下拉里没有的取值会进 `needReview`，交付时**原样列出哪几项没填、为什么**，不要当成已按数据包填完；
- 多选字段只落一个值时也按同样口径说明。
