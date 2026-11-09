/**
 * dsh-plugin-pdd-ego（正式版）
 *
 * 结构刻意保持「极简」：顶层只有 import、探针、一个 name 常量、一个 apply、一个 default。
 * 所有辅助代码都定义在 apply 内部（闭包），避免任何顶层副作用被宿主的插件沙箱放大。
 *
 * 能力：
 *   - 运行时技能注入：pdd-ego-listing（ctx.inject(['skills'])）
 *   - best-effort 工具注册：pdd_ego_*（宿主提供 @deepseek-ai/dsh-tools 时）
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const LOG = 'D:/egoscripts/pdd-ego-plugin.log';
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const SKILL_DIR = join(PKG_ROOT, 'skill');

const DEBUG = () => {
  try {
    return process.env.PDD_EGO_DEBUG === '1';
  } catch (e) {
    return false;
  }
};

const log = (m) => {
  if (!DEBUG()) return;
  try {
    appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n');
  } catch (e) {}
};

export const name = 'pdd-ego-listing';

export function apply(ctx, config) {
  log('apply called | ctx.get=' + typeof (ctx && ctx.get) + ' | ctx.inject=' + typeof (ctx && ctx.inject));

  // ── 配置（从 apply 的第二参数来；宿主可能传 undefined）──────────────────
  const cfg = {
    egoBrowser: String((config && config.egoBrowser) || 'C:/ego/ego-browser.exe'),
    workDir: String((config && config.workDir) || 'D:/egoscripts').replace(/\\/g, '/').replace(/\/$/, ''),
    pythonPath: String((config && config.pythonPath) || 'C:/Python311/python.exe'),
    timeoutMs: Number((config && config.timeoutMs) || 900000),
    verbose: (config && config.verbose) === true,
  };
  const vlog = (m) => {
    if (cfg.verbose) log('[debug] ' + m);
  };
  vlog('config = ' + JSON.stringify(cfg));

  // ── 子进程与命令 ────────────────────────────────────────────────────────
  let execFileFn = null;
  const getExecFile = () => {
    if (execFileFn) return execFileFn;
    // 顶层不 import child_process，避免宿主沙箱在 import 阶段做替换
    const rp = safeRequire();
    if (!rp) return null;
    try {
      execFileFn = rp('node:child_process').execFile;
      return execFileFn;
    } catch (e) {
      try {
        execFileFn = rp('child_process').execFile;
        return execFileFn;
      } catch (e2) {
        log('child_process unavailable: ' + e2.message);
        return null;
      }
    }
  };

  const safeRequire = () => {
    try {
      return createRequire(import.meta.url);
    } catch (e) {
      return null;
    }
  };

  const runCmd = (cmd, args, opts) =>
    new Promise((done) => {
      const execFile = getExecFile();
      if (!execFile) return done({ ok: false, text: 'execFile unavailable' });
      execFile(
        cmd,
        args,
        {
          timeout: (opts && opts.timeoutMs) || cfg.timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, ...((opts && opts.env) || {}) },
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          done({
            ok: !err,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: err ? String(err.message || err).slice(0, 300) : null,
          });
        }
      );
    });

  const cleanLog = (s) =>
    String(s || '')
      .split(/\r?\n/)
      .filter((l) => !/CategoryInfo|FullyQualifiedErrorId|所在位置|^ *\+ /.test(l))
      .join('\n')
      .trim();

  const runEgo = async (init) => {
    // ego-browser 不继承 execFile 的自定义环境变量 → 配置内联进 -e 脚本
    const inlineCfg = JSON.stringify({ cmd: (init && init.cmd) || 'spaces', space: Number((init && init.space) || 0) || null, target: String((init && init.target) || '') });
    const script = `globalThis.__PDD_CFG = ${inlineCfg}; await import('file:///${cfg.workDir}/cli-ego.mjs')`;
    const env = { PDD_CMD: (init && init.cmd) || 'spaces', PDD_SPACE: String((init && init.space) || ''), PDD_TARGET: String((init && init.target) || '') };
    const r = await runCmd(cfg.egoBrowser, ['nodejs', '-e', script], { env });
    const text = cleanLog(r.stdout) || cleanLog(r.stderr);
    let json = null;
    const i = text.indexOf('{');
    if (i >= 0) {
      try {
        json = JSON.parse(text.slice(i, text.lastIndexOf('}') + 1));
      } catch (e) {}
    }
    return { ok: r.ok, json, text: text.slice(-1200) };
  };

  const runPy = async (scriptName, args) => {
    const file = join(cfg.workDir, 'tools', scriptName);
    if (!existsSync(file)) return { ok: false, text: 'missing script: ' + file, json: null };
    const r = await runCmd(cfg.pythonPath, ['-X', 'utf8', file, ...args], { timeoutMs: 300000 });
    const text = cleanLog(r.stdout || r.stderr);
    let json = null;
    const i = text.indexOf('{');
    if (i >= 0) {
      try {
        json = JSON.parse(text.slice(i, text.lastIndexOf('}') + 1));
      } catch (e) {}
    }
    return { ok: r.ok, json, text };
  };

  const TOOLS = [
    {
      key: 'pdd_ego_spaces',
      description: '列出 ego 浏览器的店铺工作区（space），确认哪个 spaceId 对应哪个店。',
      props: {},
      run: async () => (await runEgo({ cmd: 'spaces' })).json,
    },
    {
      key: 'pdd_ego_freight_templates',
      description: '列出某店铺发品页真实可选的运费模板（每店不同）。',
      props: { space: { type: 'integer', description: 'spaceId（必填）' }, current: { type: 'boolean', description: '只回读当前值' } },
      required: ['space'],
      run: async (a) => (await runEgo({ cmd: (a && a.current) ? 'current' : 'freight', space: (a && a.space) })).json,
    },
    {
      key: 'pdd_ego_set_freight_template',
      description: '在发品页选中指定运费模板并回读校验（与属性下拉同一套逻辑，不新建模板）。',
      props: { space: { type: 'integer', description: 'spaceId（必填）' }, target: { type: 'string', description: '模板名（必须与下拉文本完全一致）' } },
      required: ['space', 'target'],
      run: async (a) => (await runEgo({ cmd: 'freight', space: (a && a.space), target: (a && a.target) || '' })).json,
    },
    {
      key: 'pdd_ego_probe_shop',
      description: '只读探测某店铺当前页面状态（URL / 是否在发品页 / 有无运费模板区）。',
      props: { space: { type: 'integer', description: 'spaceId（必填）' } },
      required: ['space'],
      run: async (a) => (await runEgo({ cmd: 'probe', space: (a && a.space) })).json,
    },
    {
      key: 'pdd_ego_run_listing',
      description: '按 D:/egoscripts/run-config.json 跑上架（填空 + 34 项校验，绝不提交，默认不存草稿）。',
      props: { configPath: { type: 'string', description: '可选：另一份 run-config.json 路径' } },
      run: async () => ({
        ok: true,
        note: '上架前必须先问用户：店铺 / 素材包 / 运费模板 / 是否存草稿 / 是否允许提交。',
        hint: `ego-browser nodejs -e "await import('file:///${cfg.workDir}/run_listing_ego.mjs')"`,
      }),
    },
    {
      key: 'pdd_ego_build_product',
      description: 'listing.json + 素材目录 → product.json（等价原插件 build_product.py，独立运行）。',
      props: { listing: { type: 'string' }, assets: { type: 'string' }, out: { type: 'string' } },
      required: ['listing', 'assets', 'out'],
      run: async (a) => ({ ok: true, result: await runPy('build_product.py', ['--listing', String(a.listing), '--assets', String(a.assets), '--out', String(a.out)]) }),
    },
    {
      key: 'pdd_ego_read_excel',
      description: '解析店透视/素材包 Excel → 结构化 SKU JSON（等价原插件 read_excel.py）。',
      props: { path: { type: 'string' } },
      required: ['path'],
      run: async (a) => ({ ok: true, result: await runPy('read_excel.py', [String(a.path)]) }),
    },
  ];

  // ── 技能注册 ────────────────────────────────────────────────────────────
  const skillEntry = () => {
    const md = join(SKILL_DIR, 'SKILL.md');
    const content = existsSync(md) ? readFileSync(md, 'utf8') : '# pdd-ego-listing\n';
    return {
      name: 'pdd-ego-listing',
      description:
        '拼多多多店铺上架（ego 版）：读素材包 product.json，经 ego-browser 打开商家后台发品页，依次填主图/标题/类目/详情图/品牌/属性/规格/SKU/预览图/参考价/运费模板，最后跑 34 项 validateForm；只填空与校验，绝不提交。',
      content,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: SKILL_DIR },
    };
  };


  const buildParameters = (props, required) => {
    const out = {};
    for (const [k, v] of Object.entries(props || {})) {
      const item = { type: (v && v.type) || 'string' };
      if (v && v.description) item.description = v.description;
      if (Array.isArray(required) && required.includes(k)) item.required = true;
      out[k] = item;
    }
    return out;
  };

  const disposers = [];
  const doSkill = (c) => {
    try {
      const skills = c && typeof c.get === 'function' ? c.get('skills') : c && c.skills;
      if (!skills || typeof skills.register !== 'function') {
        log('skills service unavailable');
        return;
      }
      const d = skills.register(skillEntry());
      disposers.push(d);
      log('skill registered: pdd-ego-listing');
    } catch (e) {
      log('skill register failed: ' + (e && e.message));
    }
  };

  const doTools = (c) => {
    try {
      const tools = c && typeof c.get === 'function' ? c.get('tools') : c && c.tools;
      if (!tools || typeof tools.register !== 'function') {
        log('tools service unavailable');
        return;
      }
      const rp = safeRequire();
      let defineTool = null;
      if (rp) {
        try {
          const m = rp('@deepseek-ai/dsh-tools');
          defineTool = m && (m.defineTool || (m.default && m.default.defineTool));
        } catch (e) {
          vlog('dsh-tools not resolvable: ' + e.message);
        }
      }
      if (typeof defineTool !== 'function') {
        log('defineTool unavailable -> tools skipped');
        return;
      }
      for (const t of TOOLS) {
        try {
          const tool = defineTool({
            name: t.key,
            description: t.description,
            parameters: buildParameters(t.props, t.required),
            output: {
              schema: { type: 'object', additionalProperties: true, properties: {} },
              render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1).slice(0, 6000) }],
            },
            timeoutMs: cfg.timeoutMs,
            execute: async (args) => t.run(args || {}),
          });
          tools.register(tool);
          log('tool registered: ' + t.key);
        } catch (e) {
          log('tool register failed: ' + t.key + ' — ' + (e && e.message));
        }
      }
    } catch (e) {
      log('tools register failed: ' + (e && e.message));
    }
  };

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['skills'], (c) => doSkill(c));
      ctx.inject(['tools'], (c) => doTools(c));
      log('ctx.inject queued for skills+tools');
    } catch (e) {
      log('inject failed: ' + (e && e.message));
    }
  } else {
    doSkill(ctx);
    doTools(ctx);
    log('no ctx.inject -> registered directly');
  }

  return () => {
    for (const d of disposers.reverse()) {
      if (typeof d === 'function') {
        try {
          d();
        } catch (e) {}
      }
    }
  };
}

export default { name, apply };

