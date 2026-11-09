# dsh-plugin-pdd-ego

拼多多多店铺「新品上架」自动化 —— **ego 浏览器版**（DeepSeek Harness 插件 + 独立脚本）。

和 Playwright/CDP 版的区别：

| | Playwright 版 | **本仓库（ego 版）** |
|---|---|---|
| 浏览器底座 | Playwright 连 Chrome 调试端口 | **ego-browser**（`taskSpace` / `page` / CDP） |
| 外部依赖 | `playwright-core` + 开调试端口的 Chrome | 只要 ego-browser，无需 playwright、无需开端口 |
| 店铺切换 | 一店一个调试端口 | 一店一个 ego space（`claimTaskSpace`） |
| 运费模板 | 不支持 | **支持**（枚举 + 选中 + 回读校验，每店模板不同） |
| 详情图上传 | 批量塞 | **逐张严格上传 + 失败占位自动重传**（防「上传失败」被计数器掩盖） |
| 主图上传 | 批量塞（顺序会乱） | **逐张上传**（保证首图 = 主图01） |
| SKU 填值 | 逐行 | CDP `Runtime.evaluate` 一次填（72 SKU ≈ 66s） |

> 默认不提交：流程只做「填空 + 34 项校验」，点「提交并上架」需由用户当轮明确授权（`submitAfterPass` 开关控制）。

## 目录

```
dsh-plugin-pdd-ego/        # DSH 插件包（注册运行时技能 + 7 个工具）
├─ lib/index.mjs
├─ skill/SKILL.md
├─ package.json / cordis.patch.yml
└─ install.ps1             # 一键装进 DSH profile
ego-scripts/               # 执行层
├─ pdd_flow_ego.mjs        #   106 个导出：类目/主图/详情/属性/规格/SKU/预览图/运费模板/校验
├─ run_listing_ego.mjs     #   10 步编排（读 run-config.json）
└─ cli-ego.mjs             #   命令入口：spaces / freight / current / probe / run
tools/                     # 素材包工具（纯本地，无浏览器）
├─ read_excel.py            #   店透视 Excel → 结构化 SKU JSON
├─ build_product.py         #   listing.json + 素材目录 → product.json
└─ xlsx_to_product.py       #   read_excel + build_product 一键胶水（推荐）
docs/ASK-BEFORE-LISTING.md #   上架前必问清单 + 实测验收记录 + 踩坑修法
```

## 先改三处路径（仓库里是占位值）

| 配置 | 位置 | 占位值 | 改成 |
|---|---|---|---|
| ego-browser 路径 | `dsh-plugin-pdd-ego/lib/index.mjs` 的 `cfgOf` | `C:/ego/ego-browser.exe` | 你机器上的 ego-browser 绝对路径 |
| ego 脚本目录 | 同上 `workDir` | `D:/egoscripts` | 本仓库 `ego-scripts/` 所在目录 |
| Python 路径 | 同上 `pythonPath` | `C:/Python311/python.exe` | 带 openpyxl 的 python |

也可以在 profile 的 `cordis.patch.yml` 里覆盖（推荐，不改代码）：

```yaml
- id: pdd-ego-listing
  config:
    egoBrowser: "C:/<你>/ego-browser.exe"
    workDir: "C:/<你的路径>/ego-scripts"
    pythonPath: "C:/<你>/python.exe"
```

## 安装插件（可选）

```powershell
powershell -ExecutionPolicy Bypass -File .\dsh-plugin-pdd-ego\install.ps1
# 然后重启 DeepSeek Harness
```

装完重启后应有：技能 `pdd-ego-listing` + 7 个工具（`pdd_ego_spaces` / `freight_templates` / `set_freight_template` / `probe_shop` / `run_listing` / `build_product` / `read_excel`）。

不装插件也能用：按下面命令行跑即可。

## 用法

### 1) 生成素材包数据

```powershell
python tools/xlsx_to_product.py --assets "D:/assets/<素材包目录>" --out "D:/assets/<素材包目录>/work"
```

输出 `work/product.json`（主图/详情/预览图按目录顺序生成，首图 = 主图01）。

### 2) 跑上架（只填空 + 校验，不提交）

`run-config.json`：

```json
{
  "spaceId": 1,
  "product": "D:/assets/<素材包目录>/work/product.json",
  "saveDraft": false,
  "skipDup": true,
  "freightTemplate": "内地包邮默认模板",
  "submitAfterPass": false
}
```

```powershell
ego-browser nodejs -e "await import('file:///<ego-scripts 绝对路径>/run_listing_ego.mjs')"
```

- `freightTemplate`：填模板名 → 选中并回读；`__ASK__` → 先列该店模板再停下；留空 → 保持店铺默认
- `submitAfterPass: true` → 34 项全 pass 后才点「提交并上架」（即用户当轮授权）
- `saveDraft: true` → 跑完存草稿（默认不存）

### 3) 只读工具

```powershell
ego-browser nodejs -e "globalThis.__PDD_CFG={cmd:'spaces'}; await import('file:///<ego-scripts 路径>/cli-ego.mjs')"
```

`cmd` 可选：`spaces` / `freight`（列模板）/ `current`（读当前模板）/ `probe`（读页面状态）/ `run`（跑编排）。
`space` 填店铺对应的 spaceId。

## 上架前必问（硬规则）

店铺 / 素材包 / **运费模板** / 是否存草稿 / 是否允许提交 —— 见 `docs/ASK-BEFORE-LISTING.md`。
运费模板每店不同，不要沿用上次；以发品页下拉枚举为准。

## 边界

- 不代登录、不碰验证码
- 不做改价、改库存、下架、订单、客服、投流
- 提交必须用户显式授权；跑完请自行在后台核对
