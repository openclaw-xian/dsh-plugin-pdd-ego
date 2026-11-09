# 上架前必须问用户的清单（ego 版 pdd 上架流程）

> 规则：**每次真正跑上架之前，先问下面 5 项，用户答完再动浏览器。**
> 只做测试/演练时（不提交、不存草稿）可以跳过提问，但配置里要保持 `saveDraft:false`。

## 1. 必须问的 5 项

| # | 问题 | 落到配置 | 说明 |
|---|------|----------|------|
| 1 | 上架到哪个店铺？ | `spaceId` | space 1/2=店铺A(店1)、3/4=店铺B(店3)、5/6=店铺C；不确定就先 `list-spaces` |
| 2 | 用哪个素材包？ | `product` | 指向 `.../work/product.json` |
| 3 | **运费模板**：用店铺默认模板，还是指定某个模板？ | `freightTemplate` | 见第 2 节；不填=保持平台默认 |
| 4 | 这次是否保存草稿？ | `saveDraft` | **默认 false**（只有显式 `true` 才存） |
| 5 | 是否允许提交上架？ | — | 流程本身**永不提交**；提交必须用户当轮明确授权，才手工调用 `submitProduct` |

## 2. 运费模板怎么问（重点）

运费模板是**每店不同**的，不能默认沿用。两种问法：

- 用户说“用默认”→ `freightTemplate` 留空，保持店铺当前/默认模板；
- 用户说“选 XX 模板”→ `freightTemplate: "XX模板名"`；
- 用户还没想好 → `freightTemplate: "__ASK__"`（**闸门模式**）：
  runner 跑到 ⑤ 之后会先列出**该店真实可用模板**，然后 `throw ask_user_before_listing`，
  绝不继续填 SKU、绝不保存。把清单发给用户选，再改配置重跑。

实测三店模板差异（同一时刻，平台默认 8 个共通模板之外的自建模板）：

- 店铺A（space 1，旧版页）：`包邮默认模板-20240228113917`、`偏远就不发`、`默认2024-04-23-11:27:03.463396`
- 店铺B（space 3，新版页）：`东北三省不包邮`、`偏偏偏远不发`、`偏远不包邮`、`新西外`、`最新发货`、`隔音板/吸音板2026-01-24-14:51:00.789701`、`默认2022-10-05-13:35:55.787745`
- 店铺C（space 5，新版页）：`新西青内不发货`、`默认2024-08-05-12:06:01.723815`

> 物流工具页（`/orders/order/carriage/list`）里能看到的模板 ≠ 发品页下拉里可选的全部模板，以下拉枚举为准。

## 3. 配置模板（D:/egoscripts/run-config.json）

```json
{
  "spaceId": 3,
  "product": "D:/assets/DZ-洞石墙纸-店1-链1/work/product.json",
  "saveDraft": false,
  "skipDup": true,
  "freightTemplate": "__ASK__"
}
```

跑法：

```powershell
ego-browser nodejs -e "await import('file:///D:/egoscripts/run_listing_ego.mjs')"
```

## 4. 运费模板相关 API（pdd_flow_ego.mjs 导出，104 个导出）

- `ensureFreightOtherMode(page)`：把运费模板切到可编辑的「其他模板」态（默认态只有单选，没有下拉；折叠时要先点「展开修改」）
- `readFreightTemplate(page)`：回读当前模板（`mode: other|default` + `value`）
- `listFreightTemplates(page)`：枚举该店全部可用模板（虚拟列表会自动滚动）
- `setFreightTemplate(page, name)`：按名字选中并回读校验（最多 3 次重试）

选择逻辑与**属性下拉框完全一致**：点开选择框 → 找整页文本完全匹配的元素 → `click()` → 回读 select 值比对。
区别只有两点：① 默认态要先点「其他模板」才有下拉；② 下拉是虚拟列表，靠后的模板要先滚动才会出现在 DOM。

## 5. 验收记录（2026-11-04）

- 三店各连续切换多个模板，回读全部一致：
  - 店铺A `偏远就不发 → 内地包邮默认模板 → 包邮默认模板-20240228113917 → 新疆西藏不配送默认模板` ✅
  - 店铺B `东北三省不包邮 → 新疆西藏包邮模板 → 新西外 → 内地包邮默认模板` ✅
  - 店铺C `新西青内不发货 → 偏远按件收费默认模板 → 内地包邮默认模板 → 新疆西藏收费默认模板` ✅
- 全流程回归（space 3，DZ-洞石墙纸店1链1，`freightTemplate:"内地包邮默认模板"`，不提交不存草稿）：
  `⑤c 运费模板 ok:true got:"内地包邮默认模板"` → `⑩ validateForm 34/34 全 pass`
- ASK 闸门回归（`freightTemplate:"__ASK__"`）：跑到 ⑤c 打印该店 15 个模板后 `FAIL: ask_user_before_listing:freight_template`，未填 SKU、未存草稿 ✅
- 顺带修正：`price_displayed` 原来只认区间价（`12.9～25.9元`），单 SKU 单值价（`39.90元`）会误报 FAIL → 正则改为单值/区间都认，回归 34/34。

## 6. 2026-11-04 补齐的四项（相对原插件）

| 项 | 落地 | 验证 |
|---|---|---|
| 流程截图 | `shotPage(page, dir, name, {fullPage})` 导出；runner 支持 `shot:true` 每步截图、`shotDir` 时末尾拍 `final.png`(fullPage) | 代码就绪；ego 截图要求**窗口不最小化**，最小化时会打印失败原因（原版等价物只有 1 张可选 `final.png`，**不是每步**） |
| `fillProductForm` | 重写为 22 步一站式（预检→打开发布页→类目分流→主图标题→选类目→下一步→详情→包装清零→视频→白底→品牌属性→运费模板→规格→SKU→预览→参考价→详情复核→校验） | 单测通过：`ok:true / phase:done / validate allPass:true / 111s`（DZ 包，space 3，运费模板 `内地包邮默认模板`） |
| 素材包生成 | `tools/build_product.py` + `tools/read_excel.py`（独立版，config.json 改读同目录，不再依赖插件 skill 目录） | 冒烟通过：真实 listing+素材目录 → `product.json` 结构与现有产物一致（10 主图/16 详情）；店透视 Excel 解析出 252 SKU（颜色×尺寸） |
| DSH 插件 | `dsh-plugin-pdd-ego`（技能 `pdd-ego-listing` + 7 个 `pdd_ego_*` 工具，best-effort） | 静态装载测试通过（技能已注册、内容与 resourceBase 正常）；**需重启 DSH 生效** |

安装插件：

```powershell
powershell -ExecutionPolicy Bypass -File D:/egoscripts\dsh-plugin-pdd-ego\install.ps1
```

> 工具注册依赖宿主提供 `@deepseek-ai/dsh-tools` 的 `defineTool`；拿不到时只注册技能，插件不报错（技能内含完整用法）。

## 7. 2026-11-04 DSH 插件打通记录（4 次重启换来的结论）

插件 `dsh-plugin-pdd-ego` 现在已在本机 **完全生效**：

```
apply called | ctx.get=function | ctx.inject=function
skill registered: pdd-ego-listing
tool registered: pdd_ego_spaces / pdd_ego_freight_templates / pdd_ego_set_freight_template /
                pdd_ego_probe_shop / pdd_ego_run_listing / pdd_ego_build_product / pdd_ego_read_excel
```

`pdd_ego_spaces` 实调用返回 8 个 ego space（pdd店铺A / 店铺B / pdd店铺C）。

### 踩坑（顺序就是排查顺序）

1. **`ctx.skills.register(...)` 直接调用无效** —— skills 服务与插件并行加载，`apply` 时还没就位。
   必须 `ctx.inject(['skills'], (c) => c.get('skills').register({...}))`，`resourceBase` 用 `{ kind:'directory', path }`。
2. **插件挂载被拒（`MODULE imported` 但没有 `apply called`）** —— 完整版顶层有
   `createRequire(import.meta.url)` / `import child_process` 等副作用，宿主沙箱下会让 entry 判为不可用。
   把这类东西全部挪进 `apply` 内部**惰性加载**后即可。最终形态刻意保持极简：
   顶层只有 `import`、几个常量、`export const name`、`export function apply`、`export default { name, apply }`。
3. **`Config` 导出不是元凶** —— 二分实验证明去掉 schemastery `Config` 也没用；最终版**不导出 Config**，
   配置从 `apply(ctx, config)` 第二参数取（profile 的 `cordis.patch.yml` 里 `- id: pdd-ego-listing config:` 提供）。
4. **工具 schema 有两套格式**：
   - `parameters` = DSL：`{ space: { type:'integer', required:true, description:'…' } }`
   - `output.schema` = JSON-Schema，且必须 `{ type:'object', properties:{}, additionalProperties:true }`
   - 两者写错都会 `tool register failed`，且 DSH 是**一项一项**报错（要改 3 轮才过）。
5. **加载路径**：profile `package.json` 的 `dsh.profile.bundles` + profile `cordis.patch.yml` 的
   `- insert: { id: pdd-ego-listing, name: dsh-plugin-pdd-ego }` 两条都开着；
   插件用 `globalThis.__PDD_EGO_APPLIED__` 做幂等，只注册一次。
   （`pnpm install` 在这台机器上因离线元数据缺失跑不通，所以**不要**依赖 pnpm 安装来挂载。）

### 排障开关

```powershell
$env:PDD_EGO_DEBUG = "1"   # 重启 DSH 后写 D:/egoscripts\pdd-ego-plugin.log
```

## 8. 2026-11-04 大包 + 视频验收（72 SKU / 旧版页 / 不提交不存草稿）

配置：

```json
{
 "spaceId": 1,
 "product": "D:/assets/MZ-猫抓布-店1-链1/work/product.json",
 "saveDraft": false,
 "skipDup": true,
 "freightTemplate": "偏远就不发",
 "video": "D:/图片/猫抓链接/猫抓1/视频/视频_1.mp4"
}
```

结果（`D:/egoscripts/big-video-run.log`）：

| 项 | 结果 |
|---|---|
| ④b 商品视频 | `ok:true how:setInputFiles secs:38`（`商品视频` 区识别正常） |
| ⑤c 运费模板 | `want:"偏远就不发" ok:true got:"偏远就不发" attempt:1` |
| ⑦ 填值 | `writes:288 covered:72 ok:72 bad:[] stockSum:719928/719928` |
| ⑧b 预览图 | `total:72 withImg:72 missing:0` |
| ⑩ validateForm | **allPass:true，零 FAIL**（`product_video: {"imgs":1,...}` pass、`sku_rows 72/72`、`sku_count 72/72`） |
| 总耗时 | **278s**（72 SKU，旧版页） |
| 提交/草稿 | 未提交、未存草稿（`goods_id=<goods_id>` 只是 URL 里的 id） |

### 可复用要点

- 视频通过 `CFG.video` 显式指定绝对路径即可，不必塞进素材包；平台要求：**h264/aac、3:4 或 1:1 或 16:9、≤60s、≤3MB**。
  本次用的 `720x960 / 19.6s / 2.3MB` 直接通过。
- 视频上传耗时约 **38s**，比主图/详情图快，72 SKU 总耗时仍在 5 分钟内。

## 9. 2026-11-04 三店铺 72 SKU 全矩阵冒烟（含视频 / 白底图 / 指定运费模板）

| 店铺 | space | 页面 | 素材包 | 运费模板 | 视频 | 白底图 | 耗时 | validateForm |
|---|---|---|---|---|---|---|---|---|
| 店铺A | 1 | 旧版 | MZ-猫抓布-店1-链1 | `偏远就不发` ✅ | ✅ 38s | 包内无（跳过） | 278s | **allPass / 0 FAIL** |
| 店铺B | 3 | 新版 | MZ-猫抓布-店3-链1 | `最新发货` ✅ | ✅ 35s | ✅ 2s 自动 | 268s | **allPass / 0 FAIL** |
| 店铺C | 5 | 新版 | MZ-猫抓布-店2-链1 | `新西青内不发货` ✅ | ✅ 43s | ✅ 2s 自动 | 282s | **allPass / 0 FAIL** |

共同数据：72 SKU、主图 10、详情 12、`writes 288 / covered 72 / ok 72 / bad []`、预览图 `72/72 withImg`、
`stockSum 719928/719928`、`sku_rows 72/72 (可见 18)`、`product_video imgs:1`、全部**未提交、未存草稿**。

### 新发现：ego `page.evaluate` 的 15s 上限会在页面卡顿时炸

店铺C第一次跑在 **⑥ 规格表** 阶段报：

```
FAIL: page.evaluate timed out after 15000ms and the renderer stopped responding.
```

- 立刻 `cli-ego probe` 探活：页面**正常**（`goods_add`、len 2733、运费模板区/图区都在）→ 是**渲染线程短时卡死**，不是死锁
- 已加 `stepRetry(label, fn, times=2, delayMs=3000)`，对 **⑥ 规格表** 与 **⑧ 预览图** 兜底（`ensureSpecTable` 幂等，重跑安全）
- 第二次重跑一路绿灯，**没再触发**（说明卡顿是偶发；兜底已就位但本轮未被真正触发）

> 若以后在别的步骤频繁出现这个 15s 超时，优先考虑把该步的 evaluate 换成
> `evalLong(page, fnSource, arg)`（走 CDP `Runtime.evaluate`，超时可控，主模块已有）。

### 提醒

三次冒烟都**没有保存草稿**，所以后台草稿箱不会出现这三条；浏览器里各留一张未保存表单页，可直接关。

## 10. 2026-11-04 详情图「上传失败」占位的成因与修复

**现象**：详情区 12 张里有 2 张显示灰底 + 红字「上传失败」，但计数器仍显示 `已上传 12/50`，
旧的 `detail_images` 校验只看计数器 → **假通过**。

**原因**（已核实）：图片本身完全合规（750×1000 = 3:4、RGBA、1.43–1.78MB，全部满足
「1:1 或 3:4、宽高均 >480px、单图 ≤3MB」）。失败发生在**平台上传环节**：
逐张 `setInputFiles` 后服务端处理个别图失败/网络抖动，而计数器对失败占位**照样 +1**。

**修复**：

1. `readDetailZone` 现在返回 `failed / failedIdx / noImg / noImgIdx / realImgs`（realImgs = 带
   `pfs.pinduoduo.com` 域名的真实图数量，用来区分 `data:image` 懒加载占位）。
2. `validateForm` 的 `detail_images` 改为**三重核对**：计数器 `N/50` **且** 容器数 == 期望
   **且** `failed == 0 && noImg == 0`，任一不符就判 **fail**（不再假通过）。
3. `uploadZoneFast` 详情区上传后会把失败项**映射回文件名**（`failedImgs`），
   runner ④ 打印告警并提示：若 ⑩ 判 fail，**直接重跑该店**（重跑是新建表单，顺序不会错）。

**处理建议**：偶发失败 → 重跑该店（约 4–5 分钟）；只有 1–2 张失败且不想重跑时，
可在后台手动删掉那两张再补传。**不要**在已填表单上反复点「保存草稿」试图修图。
