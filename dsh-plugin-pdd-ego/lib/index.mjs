/**
 * dsh-plugin-pdd-ego（可分发版）
 *
 * 与旧版差异：执行层（cli-ego / pdd_flow / run_listing / tools）现在随包放在 `scripts/`，
 * ego-browser、Python、日志路径全部改为「配置 > 环境变量 > 自动探测」，不再写死用户目录或某个盘符。
 *
 * 能力：
 *   - 运行时技能注入：pdd-ego-listing（ctx.inject(['skills'])）
 *   - best-effort 工具注册：pdd_ego_*（宿主提供 @deepseek-ai/dsh-tools 时）
 *
 * 配置项（均可省略）：egoBrowser / workDir / pythonPath / logFile / timeoutMs / allowSubmit / verbose
 * 环境变量：PDD_EGO_BROWSER / PDD_WORK_DIR / PDD_PYTHON / PDD_EGO_LOG / PDD_EGO_DEBUG
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { detectEgoBrowser, listPythonCandidates, resolveLogFile, resolveWorkDir } from './paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const SCRIPTS_DIR = join(PKG_ROOT, 'scripts')
const SKILL_DIR = join(PKG_ROOT, 'skill')

export const name = 'pdd-ego-listing'

export function apply(ctx, config) {
  const raw = (config && typeof config === 'object') ? config : {}

  // ── 路径解析：配置 > 环境变量 > 自动探测 ──────────────────────────────────
  const configuredEgo = typeof raw.egoBrowser === 'string' && raw.egoBrowser.length > 0 ? raw.egoBrowser : undefined
  const cfg = {
    egoBrowser: detectEgoBrowser({ configured: raw.egoBrowser }),
    workDir: resolveWorkDir({ configured: raw.workDir, fallback: SCRIPTS_DIR }),
    pythonPath: typeof raw.pythonPath === 'string' && raw.pythonPath.length > 0 ? raw.pythonPath : null,
    logFile: resolveLogFile({ configured: raw.logFile }),
    timeoutMs: Number(raw.timeoutMs || 900000),
    // 提交是危险操作：只有插件配置里显式写 allowSubmit: true 才允许，模型无法自行授权
    allowSubmit: raw.allowSubmit === true,
    verbose: raw.verbose === true,
  }

  const DEBUG = () => {
    try {
      return process.env.PDD_EGO_DEBUG === '1'
    } catch (e) {
      return false
    }
  }

  const log = (message) => {
    if (!DEBUG()) return
    try {
      appendFileSync(cfg.logFile, new Date().toISOString() + ' ' + message + '\n')
    } catch (e) {}
  }

  const vlog = (message) => {
    if (cfg.verbose) log('[debug] ' + message)
  }

  vlog('config = ' + JSON.stringify(cfg))
  if (configuredEgo && !existsSync(configuredEgo)) {
    log('配置的 egoBrowser 不存在，已回退自动探测：' + configuredEgo + ' → ' + (cfg.egoBrowser || '(未找到)'))
  }

  // ── 子进程与命令 ──────────────────────────────────────────────────────────
  let execFileFn = null
  const safeRequire = () => {
    try {
      return createRequire(import.meta.url)
    } catch (e) {
      return null
    }
  }

  const getExecFile = () => {
    if (execFileFn) return execFileFn
    // 顶层不 import child_process，避免宿主沙箱在 import 阶段做替换
    const rp = safeRequire()
    if (!rp) return null
    try {
      execFileFn = rp('node:child_process').execFile
      return execFileFn
    } catch (e) {
      try {
        execFileFn = rp('child_process').execFile
        return execFileFn
      } catch (e2) {
        log('child_process unavailable: ' + e2.message)
        return null
      }
    }
  }

  const runCmd = (command, args, options) =>
    new Promise((done) => {
      const execFile = getExecFile()
      if (!execFile) return done({ ok: false, stdout: '', stderr: '', error: 'execFile unavailable' })
      execFile(
        command,
        args,
        {
          timeout: (options && options.timeoutMs) || cfg.timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, ...((options && options.env) || {}) },
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          done({
            ok: !err,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: err ? String(err.message || err).slice(0, 300) : null,
          })
        },
      )
    })

  const cleanLog = (text) =>
    String(text || '')
      .split(/\r?\n/)
      .filter((line) => !/CategoryInfo|FullyQualifiedErrorId|所在位置|^ *\+ /.test(line))
      .join('\n')
      .trim()

  /**
   * 从命令输出里取结构化结果。
   *
   * 上架编排会先刷一大段日志、最后才打印结果 JSON，所以优先从末尾的 `{` 往前试，
   * 再退回「第一个 `{` 到最后一个 `}`」的旧取法。
   */
  const parseJson = (text) => {
    const end = text.lastIndexOf('}')
    if (end < 0) return null
    const starts = []
    for (let index = text.indexOf('{'); index >= 0 && index < end; index = text.indexOf('{', index + 1)) {
      starts.push(index)
    }
    for (const start of starts.slice(-8).reverse()) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch (e) {}
    }
    if (starts.length > 0) {
      try {
        return JSON.parse(text.slice(starts[0], end + 1))
      } catch (e) {}
    }
    return null
  }

  // ── ego-browser 调用 ──────────────────────────────────────────────────────
  const runEgo = async (init) => {
    if (!cfg.egoBrowser) {
      return {
        ok: false,
        json: null,
        text: 'ego-browser 未找到：请设置插件配置 egoBrowser、环境变量 PDD_EGO_BROWSER，或把 ego-browser 放进 PATH',
      }
    }
    const inline = {
      cmd: (init && init.cmd) || 'spaces',
      space: Number((init && init.space) || 0) || null,
      target: String((init && init.target) || ''),
      ...((init && init.extra) || {}),
    }
    // ego-browser 不继承 execFile 的自定义环境变量 → 配置内联进 -e 脚本
    const scriptUrl = cfg.workDir.replace(/\\/g, '/')
    const script = `globalThis.__PDD_CFG = ${JSON.stringify(inline)}; await import('file:///${scriptUrl}/cli-ego.mjs')`
    const env = { PDD_CMD: inline.cmd, PDD_SPACE: String((init && init.space) || ''), PDD_TARGET: inline.target }
    const result = await runCmd(cfg.egoBrowser, ['nodejs', '-e', script], { env })
    const text = cleanLog(result.stdout) || cleanLog(result.stderr) || String(result.error || '')
    return { ok: result.ok, json: parseJson(text), text: text.slice(-4000) }
  }

  // ── Python 调用（延迟解析，避免每次调用都探测）─────────────────────────────
  let pythonResolved = false
  let pythonPath = cfg.pythonPath

  const pythonCan = async (candidate, expression) =>
    (await runCmd(candidate, ['-c', expression], { timeoutMs: 20000 })).ok

  const resolvePython = async () => {
    if (pythonResolved) return pythonPath
    pythonResolved = true
    if (pythonPath) {
      if (existsSync(pythonPath)) return pythonPath
      log('配置的 pythonPath 不存在，已回退自动探测：' + pythonPath)
      pythonPath = null
    }
    const candidates = listPythonCandidates({})
    for (const candidate of candidates) {
      if (await pythonCan(candidate, 'import openpyxl')) {
        pythonPath = candidate
        vlog('python (openpyxl) = ' + candidate)
        return pythonPath
      }
    }
    for (const candidate of candidates) {
      if (await pythonCan(candidate, 'pass')) {
        pythonPath = candidate
        log('python 可用但没有 openpyxl，read_excel 会失败：' + candidate)
        return pythonPath
      }
    }
    pythonPath = null
    log('未找到可用 Python 解释器')
    return null
  }

  const runPy = async (scriptName, args) => {
    const file = join(cfg.workDir, 'tools', scriptName)
    if (!existsSync(file)) return { ok: false, json: null, text: 'missing script: ' + file }
    const interpreter = await resolvePython()
    if (!interpreter) {
      return {
        ok: false,
        json: null,
        text: '未找到可用的 Python 解释器：正常应自动使用 DSH 自带 Python（~/.dsh/dsh-runtimes/*/dependencies/python）；也可设置插件配置 pythonPath、环境变量 PDD_PYTHON，或把 python 放进 PATH',
      }
    }
    const result = await runCmd(interpreter, ['-X', 'utf8', file, ...args], { timeoutMs: 300000 })
    const text = cleanLog(result.stdout || result.stderr) || String(result.error || '')
    return { ok: result.ok, json: parseJson(text), text }
  }

  // ── 工具定义 ──────────────────────────────────────────────────────────────
  /** ego 调用结果：拿不到 JSON 时把错误文本交还给模型，而不是静默返回 null。 */
  const egoJson = async (init) => {
    const result = await runEgo(init)
    return result.json ?? { ok: false, error: result.text || 'ego 调用失败且没有输出' }
  }

  const TOOLS = [
    {
      key: 'pdd_ego_spaces',
      description: '列出 ego 浏览器的店铺工作区（space），确认哪个 spaceId 对应哪个店。',
      props: {},
      run: async () => egoJson({ cmd: 'spaces' }),
    },
    {
      key: 'pdd_ego_freight_templates',
      description: '列出某店铺发品页真实可选的运费模板（每店不同）。',
      props: {
        space: { type: 'integer', description: 'spaceId（必填）' },
        current: { type: 'boolean', description: '只回读当前值' },
      },
      required: ['space'],
      run: async (a) => egoJson({ cmd: (a && a.current) ? 'current' : 'freight', space: (a && a.space) }),
    },
    {
      key: 'pdd_ego_set_freight_template',
      description: '在发品页选中指定运费模板并回读校验（与属性下拉同一套逻辑，不新建模板）。',
      props: {
        space: { type: 'integer', description: 'spaceId（必填）' },
        target: { type: 'string', description: '模板名（必须与下拉文本完全一致）' },
      },
      required: ['space', 'target'],
      run: async (a) => egoJson({ cmd: 'freight', space: (a && a.space), target: (a && a.target) || '' }),
    },
    {
      key: 'pdd_ego_probe_shop',
      description: '只读探测某店铺当前页面状态（URL / 是否在发品页 / 有无运费模板区）。',
      props: { space: { type: 'integer', description: 'spaceId（必填）' } },
      required: ['space'],
      run: async (a) => egoJson({ cmd: 'probe', space: (a && a.space) }),
    },
    {
      key: 'pdd_ego_run_listing',
      description:
        '跑上架编排（填空 + 34 项校验）。默认不存草稿、不提交；'
        + '提交需要两个开关同时为真：插件配置 allowSubmit: true 与本次参数 submitAfterPass: true。'
        + '上架前必须先问用户：店铺 / 素材包 / 运费模板 / 是否存草稿 / 是否允许提交。',
      props: {
        configPath: { type: 'string', description: '可选：run-config.json 的绝对路径，默认用插件包 scripts/run-config.json' },
        space: { type: 'integer', description: '可选：覆盖 spaceId' },
        product: { type: 'string', description: '可选：覆盖素材包 product.json 路径' },
        freightTemplate: { type: 'string', description: '可选：运费模板名；"__ASK__" 表示先列模板再停下' },
        saveDraft: { type: 'boolean', description: '可选：是否保存草稿（默认 false）' },
        submitAfterPass: { type: 'boolean', description: '可选：本次是否授权提交（仍需插件配置 allowSubmit: true）' },
      },
      run: async (a) => {
        const args = a || {}
        const extra = { allowSubmit: cfg.allowSubmit === true }
        if (args.configPath) extra.configPath = String(args.configPath)
        if (args.space !== undefined && args.space !== null) extra.spaceId = args.space
        if (args.product) extra.product = String(args.product)
        if (args.freightTemplate) extra.freightTemplate = String(args.freightTemplate)
        if (args.saveDraft !== undefined) extra.saveDraft = args.saveDraft === true
        if (args.submitAfterPass !== undefined) extra.submitAfterPass = args.submitAfterPass === true
        const result = await runEgo({ cmd: 'run', extra })
        return {
          ok: result.ok,
          configPath: extra.configPath || join(cfg.workDir, 'run-config.json'),
          submitAllowed: cfg.allowSubmit === true,
          json: result.json,
          text: result.text,
        }
      },
    },
    {
      key: 'pdd_ego_build_product',
      description: 'listing.json + 素材目录 → product.json（等价 build_product.py，独立运行）。',
      props: {
        listing: { type: 'string' },
        assets: { type: 'string' },
        out: { type: 'string' },
      },
      required: ['listing', 'assets', 'out'],
      run: async (a) => ({
        ok: true,
        result: await runPy('build_product.py', ['--listing', String(a.listing), '--assets', String(a.assets), '--out', String(a.out)]),
      }),
    },
    {
      key: 'pdd_ego_xlsx_to_product',
      description:
        '素材包一键生成 product.json：读 <素材包>/商品信息.xlsx，产出 <out>/listing.json 与 <out>/product.json。'
        + '属性默认直接取自 Excel 的产品属性列（不需要参考包）；attrsFrom 仅用于按同名键覆盖个别字段。',
      props: {
        assets: { type: 'string', description: '素材包根目录（含 商品信息.xlsx）' },
        out: { type: 'string', description: '可选：输出目录，默认 <assets>/work' },
        attrsFrom: { type: 'string', description: '可选：参考 product.json 路径，按同名键覆盖 Excel 取到的 attributes' },
        title: { type: 'string', description: '可选：覆盖标题' },
        brand: { type: 'string', description: '可选：覆盖品牌' },
        ref: { type: 'number', description: '可选：覆盖参考价' },
      },
      required: ['assets'],
      run: async (a) => {
        const assets = String(a.assets)
        const out = a.out ? String(a.out) : join(assets, 'work')
        const args = ['--assets', assets, '--out', out]
        if (a.attrsFrom) args.push('--attrs-from', String(a.attrsFrom))
        if (a.title) args.push('--title', String(a.title))
        if (a.brand) args.push('--brand', String(a.brand))
        if (a.ref !== undefined && a.ref !== null) args.push('--ref', String(a.ref))
        const result = await runPy('xlsx_to_product.py', args)
        const product = join(out, 'product.json')
        return {
          ok: result.ok && existsSync(product),
          product,
          exists: existsSync(product),
          text: result.text,
        }
      },
    },
    {
      key: 'pdd_ego_read_excel',
      description: '解析店透视/素材包 Excel → 结构化 SKU JSON（等价 read_excel.py）。',
      props: { path: { type: 'string' } },
      required: ['path'],
      run: async (a) => ({ ok: true, result: await runPy('read_excel.py', [String(a.path)]) }),
    },
    {
      key: 'pdd_ego_env',
      description:
        '自检运行前提：ego 浏览器、Python（含 openpyxl）、当前可连的店铺 space。'
        + '缺少任何一项都会直接列出来并说明要装什么 —— 上架前先跑它，把结果告诉用户。',
      props: {},
      run: async () => {
        const interpreter = await resolvePython().catch(() => null)
        const pythonHasOpenpyxl = interpreter ? await pythonCan(interpreter, 'import openpyxl') : false
        const spaceResult = cfg.egoBrowser ? await runEgo({ cmd: 'spaces' }) : null
        const missing = []
        if (!cfg.egoBrowser) missing.push('ego-browser')
        if (!interpreter) missing.push('python')
        else if (!pythonHasOpenpyxl) missing.push('openpyxl')
        return {
          ok: missing.length === 0,
          egoBrowser: cfg.egoBrowser || null,
          pythonPath: interpreter,
          pythonHasOpenpyxl,
          workDir: cfg.workDir,
          spaces: spaceResult && spaceResult.json && Array.isArray(spaceResult.json.spaces)
            ? spaceResult.json.spaces.map((space) => ({ id: space.id, name: space.name, profileName: space.profileName }))
            : null,
          missing,
          requirement: [
            'ego-browser：需在本机安装（默认探测 ~/.local/share/ego/active_version_dir 与 PATH），也可在插件配置里填 egoBrowser 或设 PDD_EGO_BROWSER。',
            'Python 3 + openpyxl：**默认直接用 DSH 自带那份**（~/.dsh/dsh-runtimes/*/dependencies/python，已带 openpyxl），用户不需要另装；也可在插件配置里填 pythonPath 或设 PDD_PYTHON 覆盖。',
            '拼多多商家后台：需用户自行在 ego 浏览器里登录目标店铺（本插件不代登录、不碰账号密码）。',
          ],
          hint: missing.length === 0
            ? '前提齐全，可以按技能里的流程跑上架（默认不存草稿、不提交）。'
            : '先告诉用户缺哪一项、要装什么、装完后重启应用再试；不要猜路径，也不要硬跑上架。',
        }
      },
    },
  ]

  // ── 技能注册 ──────────────────────────────────────────────────────────────
  /** 技能正文前部的自检清单：缺什么就直接写在模型能看到的地方。 */
  const prerequisiteBlock = () => {
    const lines = ['## 运行前提（插件加载时自检）', '']
    lines.push(cfg.egoBrowser
      ? `- ego 浏览器：✅ \`${cfg.egoBrowser}\``
      : '- ego 浏览器：❌ **未找到** —— 请在本机安装 ego-browser（默认探测 `~/.local/share/ego/active_version_dir` 与 PATH），或在插件配置填 `egoBrowser` / 设环境变量 `PDD_EGO_BROWSER`。')
    lines.push(cfg.pythonPath
      ? `- Python（需 openpyxl）：✅ \`${cfg.pythonPath}\``
      : '- Python（需 openpyxl）：⚠️ 未配置，插件会自动探测本机解释器并在首次调用时验证 `openpyxl` —— 若都没有，请安装 Python 3 后执行 `pip install openpyxl`，或配置 `pythonPath` / 设 `PDD_PYTHON`。')
    lines.push('- 拼多多商家后台：需用户自行在 ego 浏览器里登录目标店铺；本插件不代登录、不碰账号密码。')
    lines.push('')
    lines.push('**以上任一项缺失时：先明确告诉用户缺什么、要装什么，然后停下；不要猜路径，也不要硬跑上架。** 需要一次性核对全部前提就调用 `pdd_ego_env`。')
    lines.push('')
    return lines.join('\n')
  }

  const skillEntry = () => {
    const file = join(SKILL_DIR, 'SKILL.md')
    const body = existsSync(file) ? readFileSync(file, 'utf8') : '# pdd-ego-listing\n'
    // 前提清单放在 frontmatter 之后，避免把 YAML 头挤到正文中间。
    let merged = prerequisiteBlock() + body
    if (body.startsWith('---')) {
      const closing = body.indexOf('\n---', 3)
      if (closing >= 0) {
        const afterFrontmatter = body.indexOf('\n', closing + 1)
        const head = body.slice(0, afterFrontmatter + 1)
        const rest = body.slice(afterFrontmatter + 1)
        merged = head + '\n' + prerequisiteBlock() + rest
      }
    }
    return {
      name: 'pdd-ego-listing',
      description:
        '拼多多多店铺上架（ego 版）。读素材包 product.json，经 ego-browser 打开商家后台发品页，依次填主图/标题/类目/详情图/品牌/属性/规格/SKU/预览图/参考价/运费模板，最后跑 34 项 validateForm；只填空与校验，绝不提交。运行前提：ego 浏览器、带 openpyxl 的 Python 3、已登录的拼多多商家后台。',
      content: merged,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: SKILL_DIR },
    }
  }

  const buildParameters = (props, required) => {
    const out = {}
    for (const [key, value] of Object.entries(props || {})) {
      const item = { type: (value && value.type) || 'string' }
      if (value && value.description) item.description = value.description
      if (Array.isArray(required) && required.includes(key)) item.required = true
      out[key] = item
    }
    return out
  }

  const disposers = []

  const doSkill = (scope) => {
    try {
      const skills = scope && typeof scope.get === 'function' ? scope.get('skills') : scope && scope.skills
      if (!skills || typeof skills.register !== 'function') {
        log('skills service unavailable')
        return
      }
      disposers.push(skills.register(skillEntry()))
      log('skill registered: pdd-ego-listing')
    } catch (e) {
      log('skill register failed: ' + (e && e.message))
    }
  }

  const doTools = (scope) => {
    try {
      const tools = scope && typeof scope.get === 'function' ? scope.get('tools') : scope && scope.tools
      if (!tools || typeof tools.register !== 'function') {
        log('tools service unavailable')
        return
      }
      const rp = safeRequire()
      let defineTool = null
      if (rp) {
        try {
          const module = rp('@deepseek-ai/dsh-tools')
          defineTool = module && (module.defineTool || (module.default && module.default.defineTool))
        } catch (e) {
          vlog('dsh-tools not resolvable: ' + e.message)
        }
      }
      if (typeof defineTool !== 'function') {
        log('defineTool unavailable -> tools skipped')
        return
      }
      for (const definition of TOOLS) {
        try {
          disposers.push(tools.register(defineTool({
            name: definition.key,
            description: definition.description,
            parameters: buildParameters(definition.props, definition.required),
            output: {
              schema: { type: 'object', additionalProperties: true, properties: {} },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1).slice(0, 6000) }],
            },
            timeoutMs: cfg.timeoutMs,
            execute: async (args) => definition.run(args || {}),
          })))
          log('tool registered: ' + definition.key)
        } catch (e) {
          log('tool register failed: ' + definition.key + ' — ' + (e && e.message))
        }
      }
    } catch (e) {
      log('tools register failed: ' + (e && e.message))
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['skills'], (scope) => doSkill(scope))
      ctx.inject(['tools'], (scope) => doTools(scope))
      log('ctx.inject queued for skills+tools')
    } catch (e) {
      log('inject failed: ' + (e && e.message))
    }
  } else {
    doSkill(ctx)
    doTools(ctx)
    log('no ctx.inject -> registered directly')
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch (e) {}
      }
    }
  }
}

export default { name, apply }
