# dsh-plugin-pdd-ego

DeepSeek Harness 插件：把 **ego 版拼多多上架**接进 DSH。执行层（`cli-ego` / `pdd_flow_ego` / `run_listing_ego` / `tools`）**随包分发在 `scripts/`**，不再依赖仓库外的外部工作目录。

- 注册**运行时技能** `pdd-ego-listing`（`ctx.inject(['skills'])` → `skills.register`，资源基目录是本包 `skill/`）
- 注册 **9 个工具**（`ctx.inject(['tools'])` → `tools.register`）：
  `pdd_ego_spaces` / `pdd_ego_freight_templates` / `pdd_ego_set_freight_template` /
  `pdd_ego_probe_shop` / `pdd_ego_run_listing` / `pdd_ego_build_product` / `pdd_ego_xlsx_to_product` / `pdd_ego_read_excel` / `pdd_ego_env`
- **默认不提交商品**：只填空 + 34 项校验；提交要 `allowSubmit` 与 `submitAfterPass` 两个开关同时显式打开

## 目录结构

```
lib/index.mjs           插件入口：解析路径、注册技能与工具
lib/paths.mjs           路径探测（配置 > 环境变量 > 自动探测）
skill/SKILL.md          运行时技能正文
scripts/cli-ego.mjs     ego 命令入口（spaces / freight / current / run / probe）
scripts/pdd_flow_ego.mjs  执行层（在 ego-browser 内运行）
scripts/run_listing_ego.mjs 上架编排
scripts/tools/          build_product.py / read_excel.py / xlsx_to_product.py / config.json
scripts/ASK-BEFORE-LISTING.md  上架前必问清单
scripts/run-config.example.json 上架参数模板
```

## 路径解析（不再写死）

| 依赖 | 配置项 | 环境变量 | 默认行为 |
|---|---|---|---|
| ego-browser.exe | `egoBrowser` | `PDD_EGO_BROWSER` | 探测 `~/.local/share/ego/active_version_dir`（含版本子目录）→ `~/.local/bin` → PATH |
| Python（带 openpyxl） | `pythonPath` | `PDD_PYTHON` | 逐个验证候选解释器，优先能 `import openpyxl` 的 |
| 执行层目录 | `workDir` | `PDD_WORK_DIR` | 包内 `scripts/` |
| 日志 | `logFile` | `PDD_EGO_LOG` | 系统临时目录（包可能装在只读位置） |
| 单次超时 | `timeoutMs` | — | 900000 ms |
| 提交总开关 | `allowSubmit` | — | `false` |

配置写在 profile 的 `cordis.patch.yml`，任何一项都可以省略：

```yaml
- id: pdd-ego-listing
  config:
    verbose: false
    allowSubmit: false
    # egoBrowser: "C:/Users/<你>/.local/share/ego/active_version_dir/ego-browser.exe"
    # pythonPath: "C:/Users/<你>/AppData/Local/Programs/Python/Python311/python.exe"
```

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 然后重启 DeepSeek Harness
```

`install.ps1` 会：
1. 复制 `lib/`、`skill/`、`scripts/` 到插件目录与当前 profile 的 `node_modules/dsh-plugin-pdd-ego`
2. 在 profile `package.json` 里加 `file:` 依赖 + `dsh.profile.bundles` 条目
3. 在 profile `cordis.patch.yml` 里加 `- insert: {id: pdd-ego-listing, name: dsh-plugin-pdd-ego}` 兜底

## 工具一览

| 工具 | 作用 |
|---|---|
| `pdd_ego_spaces` | 列店铺 space（哪个 spaceId 是哪个店） |
| `pdd_ego_freight_templates` | 列该店发品页真实可选的运费模板（`current:true` 只回读当前值） |
| `pdd_ego_set_freight_template` | 选中指定运费模板并回读校验（不新建模板） |
| `pdd_ego_probe_shop` | 只读探测当前页面状态 |
| `pdd_ego_run_listing` | 按 `run-config.json` 跑上架；可传 `configPath`/`space`/`product`/`freightTemplate`/`saveDraft`/`submitAfterPass` |
| `pdd_ego_build_product` | `listing.json` + 素材目录 → `product.json` |
| `pdd_ego_xlsx_to_product` | 整包 Excel → `work/listing.json` + `work/product.json`；属性默认取自 Excel 的产品属性列，`attrsFrom` 仅覆盖同名项 |
| `pdd_ego_read_excel` | 店透视 Excel → 结构化 SKU JSON |

## 上架前必问

见 `scripts/ASK-BEFORE-LISTING.md`：店铺 / 素材包 / **运费模板** / 是否存草稿 / 是否允许提交。
`freightTemplate:"__ASK__"` 时流程会先列该店模板再中止，不填 SKU、不存草稿。

## 排障（踩过的坑，写在这里省一次重启）

| 现象 | 原因 / 正确写法 |
|---|---|
| `MODULE imported` 但没有 `apply called` | **顶层不要放 `createRequire(import.meta.url)`、`child_process` import 等副作用**；把这类东西放进 `apply` 内部惰性加载。只有「顶层仅 imports/常量/name/apply/default」的极简骨架才稳定挂载 |
| `parameters.type must be a value schema object` | 工具 `parameters` 用 **DSL**：`{ space: { type:'integer', required:true, description:'...' } }`，不是 JSON-Schema |
| `schema.type must be string/number/...` | `output.schema` 是 **JSON-Schema**，必须含合法 `type` |
| `schema.additionalProperties must be explicitly true or false` | `output.schema` 要写成 `{ type:'object', properties:{}, additionalProperties:true }` |
| 技能看不到 | 文件技能还额外放在 `~/.agents/skills/` 与 `~/.dsh/skills/`（兜底），刷新页面即可见 |
| 工具返回「ego-browser 未找到」 | 装 ego 不在默认位置时，设 `egoBrowser` 或 `PDD_EGO_BROWSER` |
| `read_excel` 报 `ModuleNotFoundError: openpyxl` | `pythonPath` 指向的解释器没装 openpyxl；插件会自动跳到装了的那个，都不行时手工指定 |

打开插件调试日志：设 `PDD_EGO_DEBUG=1` 后重启；日志默认写系统临时目录的 `pdd-ego-plugin.log`（`PDD_EGO_LOG` 可覆盖）。

## 卸载

删掉当前 profile 的 `node_modules/dsh-plugin-pdd-ego`，并从 profile `package.json` 的 `bundles` / `cordis.patch.yml` 里移除 `pdd-ego-listing`，重启即可。

## 商品视频（商品视频区）

- 流程里有独立的 **④b 商品视频** 步骤：定位「商品视频」区 → 该区 `input[type=file]` → `setInputFiles` → 轮询落地状态；已存在视频则走 `already`，不重复上传
- **来源二选一**：素材包内任意层级、路径含「视频」的 `*.mp4` 自动找到；或 `run-config.json` 里 `"video": "<mp4 绝对路径>` 显式指定
- 素材包无视频 → 该步跳过，`product_video` 校验记为 pass（跳过），不阻塞链路
- 平台规格：**≤60s、≤3MB、宽高比 1:1/16:9/3:4、h264+aac**（实测 720×960 / 19.6s / 2.3MB 直接通过）
- 上传耗时约 35–43 秒
