# dsh-plugin-pdd-ego

拼多多多店铺「新品上架」自动化 —— **ego 浏览器版**（DeepSeek Harness 插件，含执行层脚本与素材包工具）。

和 Playwright/CDP 版的区别：

| | Playwright 版 | **本仓库（ego 版）** |
|---|---|---|
| 浏览器底座 | Playwright 连 Chrome 调试端口 | **ego-browser**（`taskSpace` / `page` / CDP） |
| 外部依赖 | `playwright-core` + 开调试端口的 Chrome | 只要 ego-browser，无需 playwright、无需开端口 |
| 店铺切换 | 一店一个调试端口 | 一店一个 ego space（`claimTaskSpace`） |
| 运费模板 | 不支持 | **支持**（枚举 + 选中 + 回读校验，每店模板不同） |
| 商品视频 | 支持 | **支持**（④b 步骤；自动解析素材包 mp4 或 `video` 显式指定；已存在则跳过） |
| 详情图上传 | 批量塞 | **逐张严格上传 + 失败占位自动重传**（防「上传失败」被计数器掩盖） |
| 主图上传 | 批量塞（顺序会乱） | **逐张上传**（保证首图 = 主图01） |
| SKU 填值 | 逐行 | CDP `Runtime.evaluate` 一次填（72 SKU ≈ 66s） |

> 默认不提交：流程只做「填空 + 34 项校验」，点「提交并上架」需两个开关同时为真
> （`submitAfterPass` + 插件配置 `allowSubmit`），且必须用户当轮明确授权。

## 目录

```
dsh-plugin-pdd-ego/            # 插件包（也是执行层所在）
├─ lib/index.mjs               #   插件入口：注册技能 pdd-ego-listing + 7 个工具
├─ lib/paths.mjs               #   路径解析（ego-browser / python / workDir 自动探测）
├─ skill/SKILL.md              #   运行时技能正文
├─ scripts/                    #   执行层（随包分发，不需要另配路径）
│  ├─ pdd_flow_ego.mjs         #     106 个导出：类目/主图/详情/视频/属性/规格/SKU/预览图/运费模板/校验
│  ├─ run_listing_ego.mjs      #     10 步编排（读 run-config.json）
│  ├─ cli-ego.mjs              #     命令入口：spaces / freight / current / probe / run
│  ├─ tools/read_excel.py      #     店透视 Excel → 结构化 SKU JSON
│  ├─ tools/build_product.py   #     listing.json + 素材目录 → product.json
│  ├─ tools/xlsx_to_product.py #     整包一键：xlsx → work/listing.json + work/product.json
│  ├─ run-config.example.json  #     上架参数模板（含 video 字段）
│  └─ ASK-BEFORE-LISTING.md    #     上架前必问清单
├─ install.ps1                 #   一键装进 DSH profile
└─ package.json / cordis.patch.yml / NOTICE.txt

docs/ASK-BEFORE-LISTING.md     # 完整版必问清单 + 实测验收记录 + 踩坑修法
docs/上架记录-*.md             # 批次上架记录（已脱敏）
```

## 先改三处路径（都有默认值，按需覆盖）

| 配置 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `egoBrowser` | `PDD_EGO_BROWSER` | 自动探测 | ego 安装目录（含版本子目录）→ PATH |
| `pythonPath` | `PDD_PYTHON` | 自动探测 | 优先选能 `import openpyxl` 的解释器 |
| `workDir` | `PDD_WORK_DIR` | 包内 `scripts/` | 执行层目录，一般不要改 |

也可以在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: pdd-ego-listing
  config:
    egoBrowser: "C:/<你>/ego-browser.exe"
    pythonPath: "C:/<你>/python.exe"
    workDir: "C:/<插件包>/scripts"
```

## 安装插件（可选）

```powershell
powershell -ExecutionPolicy Bypass -File .\dsh-plugin-pdd-ego\install.ps1
# 然后重启 DeepSeek Harness
```

装完重启后应有：技能 `pdd-ego-listing` + 7 个工具（`pdd_ego_spaces` / `pdd_ego_freight_templates` /
`pdd_ego_set_freight_template` / `pdd_ego_probe_shop` / `pdd_ego_run_listing` /
`pdd_ego_xlsx_to_product` / `pdd_ego_build_product` / `pdd_ego_read_excel`）。

不装插件也能用：直接跑 `scripts/` 里的脚本即可。

## 用法

### 1) 生成素材包数据（没有 product.json 时）

```powershell
python dsh-plugin-pdd-ego/scripts/tools/xlsx_to_product.py --assets "D:/assets/<素材包>" --out "D:/assets/<素材包>/work"
```

输出 `work/listing.json` 与 `work/product.json`（主图/详情/预览图按目录顺序，首图 = 主图01；
属性直接取 Excel 产品属性列，多值单元格会拆成候选数组）。

### 2) 跑上架（只填空 + 校验，默认不提交）

`scripts/run-config.json`（从 `run-config.example.json` 复制）：

```json
{
  "spaceId": 1,
  "product": "D:/assets/<素材包>/work/product.json",
  "saveDraft": false,
  "skipDup": true,
  "freightTemplate": "__ASK__",
  "submitAfterPass": false,
  "allowSubmit": false,
  "shot": false,
  "video": ""
}
```

```powershell
ego-browser nodejs -e "await import('file:///<插件包>/scripts/run_listing_ego.mjs')"
```

- `freightTemplate`：填模板名 → 选中并回读；`"__ASK__"` → 先列该店模板再停下；留空 → 保持店铺默认
- `video`：留空则自动从素材包解析 mp4；填绝对路径则强制用这个视频
- `submitAfterPass` + `allowSubmit` **必须同时为真**才会提交
- `saveDraft: true` → 跑完存草稿（默认不存）

### 3) 只读工具

```powershell
ego-browser nodejs -e "globalThis.__PDD_CFG={cmd:'spaces'}; await import('file:///<插件包>/scripts/cli-ego.mjs')"
```

`cmd`：`spaces` / `freight`（列模板）/ `current`（读当前模板）/ `probe`（读页面状态）/ `run`（跑编排）。

## 商品视频（④b）

流程里有独立的 **④b 商品视频** 步骤：定位「商品视频」区（排除左侧发布助手侧栏误命中）→
该区 `input[type=file]` → `setInputFiles` → 轮询该区状态（`found / imgs / hasError / placeholder / done`）。

**来源二选一**

1. **自动解析**：素材包目录任意层级、路径含「视频」的 `*.mp4`（如 `<包>/拼多多/<包名>/视频/视频_1.mp4`）
2. **显式指定**：`run-config.json` 的 `"video": "<mp4 绝对路径>"`

素材包没有视频时该步自动跳过，`product_video` 校验记为 pass（跳过），不阻塞链路。

**平台规格（实测能过）**

| 项 | 要求 | 实测 |
|---|---|---|
| 时长 | ≤ 60s | 19.6s ✅ |
| 大小 | ≤ 3MB | 2.3MB ✅ |
| 宽高比 | 1:1 / 16:9 / 3:4 | 720×960（3:4）✅ |
| 编码 | h264 + aac | ✅ |

上传耗时约 **35–43 秒**；已存在视频时走 `already` 分支不重复上传。
页面上报「视频上传错误」时会先清区重试一次，仍失败才跳过。

## 上架前必问（硬规则）

店铺 / 素材包 / **运费模板** / 是否存草稿 / 是否允许提交 —— 见 `docs/ASK-BEFORE-LISTING.md`。
运费模板每店不同，不要沿用上次；以发品页下拉枚举为准。

## 边界

- 不代登录、不碰验证码
- 不做改价、改库存、下架、订单、客服、投流
- 提交必须用户显式授权；跑完请自行在后台核对

## 商品主档账本

上架成功后必须用新生成的商品 ID 落账：

```bash
node skill/record-listing.mjs --shop <店铺> --goods-id <新商品ID> --goods-name "<商品名>" --status 审核中 --evidence <报告/截图>
```

- 新链接：`listing-new`，上架前无 goodsId，状态 `未上架`
- 已下架重新上架：`relist`，状态 `已下架` → `审核中/在售`
- 落账路径：`店铺运营日志/商品/<店铺>/<商品ID>/`
