/**
 * 运行时路径解析：把原先写死的绝对路径换成「配置 > 环境变量 > 自动探测」。
 *
 * 本模块只做文件系统探测，不依赖 Cordis，可独立冒烟测试。
 * 所有探测函数都返回 undefined/空数组表示「没找到」，由调用方决定报错文案。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : ''

/**
 * 返回第一个真实存在的候选路径。
 * @param candidates - 候选路径；空值会被跳过。
 * @returns 首个存在的路径，或 undefined。
 */
export function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 在 PATH 的各目录里查找可执行文件。
 * @param names - 可执行文件名候选。
 * @returns 首个存在的绝对路径，或 undefined。
 */
export function findOnPath(names) {
  const directories = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 探测 ego-browser 可执行文件。
 *
 * 顺序：显式配置 → 环境变量 → ego 安装目录（含版本子目录）→ PATH。
 * @param options - `configured` 为插件配置值，`envVar` 为环境变量名。
 * @returns 可执行文件绝对路径，或 undefined。
 */
export function detectEgoBrowser(options = {}) {
  const { configured, envVar = 'PDD_EGO_BROWSER' } = options
  const direct = firstExisting([configured, envVar ? process.env[envVar] : undefined])
  if (direct) return direct

  const home = homedir()
  const localShare = join(home, '.local', 'share', 'ego')
  const activeDirectory = join(localShare, 'active_version_dir')
  const candidates = [join(activeDirectory, `ego-browser${EXE_SUFFIX}`)]
  // 有的安装把实际二进制再套一层版本目录
  if (existsSync(activeDirectory)) {
    try {
      for (const entry of readdirSync(activeDirectory, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(activeDirectory, entry.name, `ego-browser${EXE_SUFFIX}`))
      }
    } catch {}
  }
  candidates.push(
    join(home, '.local', 'bin', `ego-browser${EXE_SUFFIX}`),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'ego', `ego-browser${EXE_SUFFIX}`) : undefined,
  )
  return firstExisting(candidates) || findOnPath([`ego-browser${EXE_SUFFIX}`, 'ego-browser'])
}

/**
 * 列出 DSH 自带的 Python 解释器。
 *
 * 用户都是用 DSH 跑本插件的，不该为了读 Excel 再单独装一份 Python：
 * DSH 运行时（`~/.dsh/dsh-runtimes/<runtime>/dependencies/python`）自带
 * python + openpyxl（`/office-xlsx` 用的就是这一份），优先用它。
 * @param home - 用户主目录。
 * @returns 找到的解释器绝对路径数组（没有 DSH 运行时时为空数组）。
 */
export function listDshPythons(home = homedir()) {
  const base = join(home, '.dsh', 'dsh-runtimes')
  const found = []
  let entries = []
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const exe of [`python${EXE_SUFFIX}`, 'python', 'python3']) {
      const candidate = join(base, entry.name, 'dependencies', 'python', exe)
      if (existsSync(candidate)) {
        found.push(candidate)
        break
      }
    }
  }
  return found
}

/**
 * 列出 Python 解释器候选，交给调用方逐个验证 `openpyxl` 是否可用。
 *
 * 顺序：**插件配置** → **DSH 自带 Python** → `PDD_PYTHON` 环境变量 → PATH → 常见安装目录。
 * DSH 排在环境变量/PATH 前面：用户都是用 DSH 跑的，不该被机器上零散的 python 带偏；
 * `py` 启动器排在最后，因为它需要 `-3` 参数而不是自身可执行。
 * @param options - `configured` 为插件配置值，`envVar` 为环境变量名。
 * @returns 候选绝对路径数组（可能为空）。
 */
export function listPythonCandidates(options = {}) {
  const { configured, envVar = 'PDD_PYTHON' } = options
  const home = homedir()
  const localPrograms = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Python') : undefined
  const configuredFirst = [configured].filter(Boolean)
  const dsh = listDshPythons(home)
  const fromEnv = [envVar ? process.env[envVar] : undefined].filter(Boolean)
  const installed = []
  for (const version of ['313', '312', '311', '310']) {
    if (localPrograms) installed.push(join(localPrograms, `Python${version}`, `python${EXE_SUFFIX}`))
    installed.push(join(home, 'AppData', 'Local', 'Programs', 'Python', `Python${version}`, `python${EXE_SUFFIX}`))
  }
  if (process.env.LOCALAPPDATA) installed.push(join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Launcher', `py${EXE_SUFFIX}`))
  const onPath = findOnPath([`python${EXE_SUFFIX}`, 'python'])
  return [...configuredFirst, ...dsh, ...fromEnv, onPath, ...installed].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
}

/**
 * 解析可写日志文件位置。
 *
 * 包可能装在只读位置（例如 app.asar），因此默认落在系统临时目录，而不是包内。
 * @param options - `configured` 为插件配置值，`envVar` 为环境变量名。
 * @returns 日志文件绝对路径。
 */
export function resolveLogFile(options = {}) {
  const { configured, envVar = 'PDD_EGO_LOG' } = options
  const fromEnv = envVar ? process.env[envVar] : undefined
  if (configured) return String(configured)
  if (fromEnv) return String(fromEnv)
  return join(tmpdir(), 'pdd-ego-plugin.log')
}

/**
 * 解析工作目录（运行时脚本所在目录）。
 *
 * 默认是插件包自带的 `scripts/`，也就是执行层随包分发的那一份。
 * 返回值统一用正斜杠：它会被拼进 `file:///` URL，反斜杠在那里无效。
 * @param options - `configured` 为插件配置值，`envVar` 为环境变量名，`fallback` 为包内默认目录。
 * @returns 工作目录绝对路径（正斜杠）。
 */
export function resolveWorkDir(options = {}) {
  const { configured, envVar = 'PDD_WORK_DIR', fallback } = options
  const fromEnv = envVar ? process.env[envVar] : undefined
  const chosen = configured || fromEnv || fallback
  return String(chosen).replace(/\\/g, '/').replace(/\/+$/, '')
}
