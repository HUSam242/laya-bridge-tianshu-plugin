/**
 * index.mjs —— Laya 虚拟环境工坊（laya-bridge v2.0.1 · TPI 2.0 全功能档入口）
 *
 * 严格遵守官方 TPI 2.0 隔离宿主规范（docs/developers/tpi2.md & tpi/tpi-v2.d.mts）：
 *   1. 通过 `globalThis.__tianshuTPI.defineTianshuPlugin` 注册；
 *   2. 插件进程零外部网络、零子进程、零本地权重加载，内存有界（成品索引最多常驻 30 条）；
 *   3. 工具调用期间通过 `host.shell.run` 派活给本地 `laya-env`（`laya_artifact_worker.py`）：
 *      - 任务参数经 Base64 编码传参，避免跨平台引号转义；
 *      - 可执行路径经严格字符集白名单校验（仅允许字母/数字/`. _ / -`与盘符前缀，拒绝 `%`/`^`/`~`/空白/元字符）；
 *      - `daemonUrl` 严格限定为本地回环 `http://127.0.0.1:<port>` 或 `http://localhost:<port>`（防 SSRF）；
 *      - `shell.run` 全程受 `try/catch` 与 `signal` 中止保护，异常统一结构化返回并写入 `host.log.warn`；
 *   4. `laya_fetch_artifact` 与 UI 面板仅用 `host.workspace.read` 读取 `.laya/artifacts/`，并按字节安全截断；
 *   5. 生命周期阶段（`turnStart`/`toolEnd`/`sessionEnd`/`dispose`）全部受 `try/catch` 兜底，
 *      且与 `ui.onMessage`/`ui.onCommand` 严格绝不调用 `host.shell.run` 或 `host.workspace.write`。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildPromptContextBlock,
  createTrajectoryState,
  evaluateTrajectoryAlerts,
  formatStatusText,
  observeToolEnd,
} from './trajectory.mjs'

const PLUGIN_ID = 'laya-bridge'
const ARTIFACTS_INDEX_PATH = '.laya/artifacts/index.json'
const EXPECTED_ARTIFACT_SCHEMA = 'laya.artifact/1'
const CONFIG_FILE_NAME = 'config.json'

const MAX_CACHED_ARTIFACTS = 30
const MAX_INDEX_READ_BYTES = 512 * 1024
const MAX_FETCH_CONTENT_BYTES = 512 * 1024
const MAX_UI_CONTENT_BYTES = 180 * 1024
const MAX_NOTIFY_BYTES = 900

const DEFAULT_CONFIG = Object.freeze({
  pythonPath: '',
  workerScript: '',
  daemonUrl: 'http://127.0.0.1:8767',
  defaultTimeoutMs: 120_000,
})

// 严格路径字符白名单：归一化 `\` → `/` 后，仅允许可选盘符 + `[A-Za-z0-9._/-]`
// 彻底拒绝 `%`、`^`、`~`、空白、Tab、引号、控制字符及所有 Shell 元字符
const STRICT_EXEC_PATH_RE = /^(?:[A-Za-z]:)?[A-Za-z0-9._/-]+$/
const SAFE_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

function logDebug(host, message) {
  try {
    host?.log?.debug(`[${PLUGIN_ID}] ${message}`)
  } catch {
    // non-fatal
  }
}

function logWarn(host, message) {
  try {
    host?.log?.warn(`[${PLUGIN_ID}] ${message}`)
  } catch {
    // non-fatal
  }
}

/**
 * 按 UTF-8 字节数安全截断字符串（不切碎多字节字符或代理对）。
 */
export function truncateUtf8Bytes(input, maxBytes) {
  const str = String(input ?? '')
  const totalBytes = Buffer.byteLength(str, 'utf8')
  if (totalBytes <= maxBytes) {
    return { text: str, truncated: false, totalBytes, returnedBytes: totalBytes }
  }
  const suffix = '…'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  let used = 0
  let out = ''
  for (const ch of str) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (used + b > budget) break
    out += ch
    used += b
  }
  const finalText = out + suffix
  return {
    text: finalText,
    truncated: true,
    totalBytes,
    returnedBytes: Buffer.byteLength(finalText, 'utf8'),
  }
}

/**
 * 单一权威路径校验器：用于 pythonPath / workerScript（读写配置与命令拼装共用）。
 */
export function validateExecutablePath(label, rawPath, { allowEmpty = false } = {}) {
  const raw = String(rawPath ?? '').trim()
  if (!raw) {
    if (allowEmpty) return ''
    throw new Error(`${label} 未配置，请先在「设置 → 插件界面 → Laya 虚拟环境」中填写。`)
  }
  if (raw.length > 300) {
    throw new Error(`${label} 长度不能超过 300 字符`)
  }
  if (/[\s\r\n\t\0%^*?~`$;|&<>!"'()[\]{}]/.test(raw)) {
    throw new Error(`${label} 包含非法字符（不允许空白、%、^、~ 或 Shell 元字符）`)
  }
  const normalized = raw.replace(/\\/g, '/')
  if (!STRICT_EXEC_PATH_RE.test(normalized)) {
    throw new Error(`${label} 包含不支持的路径字符（仅允许字母、数字、. _ / - 及盘符前缀）`)
  }
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some(seg => seg === '.' || seg === '..' || seg.includes('..'))) {
    throw new Error(`${label} 不允许包含相对跳转段（. 或 ..）`)
  }
  return normalized
}

/**
 * 单一权威本地守护地址校验器：仅放行本机回环 http://127.0.0.1:<port> 或 http://localhost:<port>。
 */
export function validateDaemonUrl(rawUrl) {
  const val = String(rawUrl ?? '').trim()
  if (!val) return DEFAULT_CONFIG.daemonUrl
  let parsed
  try {
    parsed = new URL(val)
  } catch {
    throw new Error(`daemonUrl 格式非法：${val}`)
  }
  if (parsed.protocol !== 'http:') {
    throw new Error(`daemonUrl 仅允许 http:// 本地回环地址（拒绝 ${parsed.protocol}）`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('daemonUrl 不允许包含账号密码段')
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`daemonUrl 仅允许 127.0.0.1 或 localhost（拒绝非回环主机 ${host}）`)
  }
  // WHATWG URL 会把 http 默认端口 80 归一为空串，故空串按 80 判并拒绝低位特权端口
  const port = parsed.port ? Number(parsed.port) : 80
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`daemonUrl 必须显式指定 1024..65535 之间的端口（当前 ${parsed.port || '80'}）`)
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('daemonUrl 不允许携带路径、查询参数或锚点')
  }
  return `http://${host}:${port}`
}

/**
 * 单一权威成品相对路径校验器（结构性阻断 `.`、`..`、隐藏文件段与绝对路径，不依赖外层补丁）。
 */
export function validateArtifactRelPath(rawRel) {
  const val = String(rawRel ?? '').trim()
  if (!val || val.length > 240) {
    throw new Error('成品相对文件名不能为空且不能超过 240 字符')
  }
  if (val.includes('\\') || val.startsWith('/') || val.endsWith('/')) {
    throw new Error(`非法成品路径格式：${val}`)
  }
  const segments = val.split('/')
  if (segments.length > 8) {
    throw new Error(`成品路径层级过深：${val}`)
  }
  for (const seg of segments) {
    if (!SAFE_PATH_SEGMENT_RE.test(seg) || seg.includes('..')) {
      throw new Error(`非法成品路径段（禁止 . / .. / 隐藏段与特殊字符）：${seg}`)
    }
  }
  return segments.join('/')
}

export function validateConfigObject(obj, { allowEmptyPaths = true } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('配置根结构必须是 JSON 对象')
  }
  const pythonPath = validateExecutablePath('pythonPath', obj.pythonPath ?? '', { allowEmpty: allowEmptyPaths })
  const workerScript = validateExecutablePath('workerScript', obj.workerScript ?? '', { allowEmpty: allowEmptyPaths })
  const daemonUrl = validateDaemonUrl(obj.daemonUrl ?? DEFAULT_CONFIG.daemonUrl)
  const rawTimeout = obj.defaultTimeoutMs === undefined ? DEFAULT_CONFIG.defaultTimeoutMs : Number(obj.defaultTimeoutMs)
  if (!Number.isFinite(rawTimeout) || rawTimeout < 10_000 || rawTimeout > 600_000) {
    throw new Error('defaultTimeoutMs 必须在 10000..600000 毫秒之间')
  }
  return {
    pythonPath,
    workerScript,
    daemonUrl,
    defaultTimeoutMs: Math.round(rawTimeout),
  }
}

export function buildWorkerCommand(config, action, payloadObj) {
  const allowedActions = new Set(['probe', 'decide', 'produce', 'list'])
  if (!allowedActions.has(action)) {
    throw new Error(`不支持的 worker 动作：${action}`)
  }
  const py = validateExecutablePath('pythonPath', config.pythonPath, { allowEmpty: false })
  const script = validateExecutablePath('workerScript', config.workerScript, { allowEmpty: false })
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj ?? {}), 'utf8').toString('base64')
  if (!/^[A-Za-z0-9+/=]+$/.test(payloadB64)) {
    throw new Error('Base64 载荷校验失败')
  }
  return `"${py}" "${script}" ${action} --workspace . --payload-b64 ${payloadB64}`
}

/**
 * 强容错 JSON 提取器：支持单行 JSON、多行 pretty-print JSON 以及前置噪声日志。
 * 从最后一个 `}` 反向做字符串感知的括号深度匹配，定位最后一个完整 JSON 对象并解析。
 */
export function parseWorkerJsonOutput(rawOutput) {
  const text = String(rawOutput ?? '').trim()
  if (!text) return null

  // 快速路径：整体就是合法 JSON 对象
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fall through to reverse scan
    }
  }

  // 反向查找末尾合法 JSON 对象（支持多行 pretty-print + 前置噪声）
  let end = text.lastIndexOf('}')
  while (end >= 0) {
    let depth = 0
    let inString = false
    let start = -1
    for (let i = end; i >= 0; i -= 1) {
      const ch = text[i]
      if (ch === '"') {
        // 统计紧邻前导反斜杠数量，偶数个代表非转义引号
        let bs = 0
        for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) bs += 1
        if (bs % 2 === 0) inString = !inString
      } else if (!inString) {
        if (ch === '}') depth += 1
        else if (ch === '{') {
          depth -= 1
          if (depth === 0) {
            start = i
            break
          }
        }
      }
    }
    if (start >= 0) {
      const candidate = text.slice(start, end + 1)
      try {
        const parsed = JSON.parse(candidate)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed
        }
      } catch {
        // try an earlier '}'
      }
    }
    end = text.lastIndexOf('}', end - 1)
  }
  return null
}

/**
 * 加载配置：显式区分「首次未配置（ENOENT）」与「配置文件损坏/校验失败（fail-closed 上报）」。
 */
async function loadConfigWithStatus(host) {
  if (!host.storage?.dataDir) {
    return { config: { ...DEFAULT_CONFIG }, configError: null, configured: false }
  }
  let raw
  try {
    const dir = await host.storage.dataDir()
    raw = await readFile(join(dir, CONFIG_FILE_NAME), 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { config: { ...DEFAULT_CONFIG }, configError: null, configured: false }
    }
    const msg = `无法读取配置文件：${err?.message ?? String(err)}`
    logWarn(host, msg)
    return { config: { ...DEFAULT_CONFIG }, configError: msg, configured: false }
  }

  try {
    const parsed = JSON.parse(raw)
    const validated = validateConfigObject(parsed, { allowEmptyPaths: true })
    const configured = Boolean(validated.pythonPath && validated.workerScript)
    return { config: validated, configError: null, configured }
  } catch (err) {
    const msg = `配置文件损坏或包含非法字段（请打开设置页重新保存）：${err?.message ?? String(err)}`
    logWarn(host, msg)
    return { config: { ...DEFAULT_CONFIG }, configError: msg, configured: false }
  }
}

async function saveConfig(host, patch, { allowEmptyPaths = false } = {}) {
  if (!host.storage?.dataDir) {
    throw new Error('宿主未授予 storage 能力，无法保存配置')
  }
  const { config: current } = await loadConfigWithStatus(host)
  const merged = {
    pythonPath: patch.pythonPath !== undefined ? patch.pythonPath : current.pythonPath,
    workerScript: patch.workerScript !== undefined ? patch.workerScript : current.workerScript,
    daemonUrl: patch.daemonUrl !== undefined ? patch.daemonUrl : current.daemonUrl,
    defaultTimeoutMs: patch.defaultTimeoutMs !== undefined ? patch.defaultTimeoutMs : current.defaultTimeoutMs,
  }
  const validated = validateConfigObject(merged, { allowEmptyPaths })
  const dir = await host.storage.dataDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify(validated, null, 2) + '\n', 'utf8')
  logDebug(host, `配置已保存（pythonPath=${validated.pythonPath ? '已设' : '空'}, daemonUrl=${validated.daemonUrl}）`)
  return validated
}

function slimArtifactEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const jobId = typeof raw.job_id === 'string' && SAFE_JOB_ID_RE.test(raw.job_id) ? raw.job_id : null
  if (!jobId) return null
  return {
    job_id: jobId,
    kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 48) : 'artifact',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : jobId,
    status: typeof raw.status === 'string' ? raw.status.slice(0, 24) : 'ready',
    created_at: typeof raw.created_at === 'string' ? raw.created_at.slice(0, 40) : '',
    summary_file: typeof raw.summary_file === 'string' ? raw.summary_file.slice(0, 180) : `.laya/artifacts/${jobId}/summary.md`,
    file_count: Number.isInteger(raw.file_count) ? raw.file_count : 0,
  }
}

/**
 * 只读读取 `.laya/artifacts/index.json`：校验 schema 版本、限制最大读取体积，且仅保留最新 30 条精简记录。
 */
async function readArtifactsIndex(host) {
  if (!host.workspace?.read) {
    return { artifacts: [], latest_job_id: null, totalCount: 0, schemaWarning: null }
  }
  let raw
  try {
    raw = await host.workspace.read(ARTIFACTS_INDEX_PATH)
  } catch {
    return { artifacts: [], latest_job_id: null, totalCount: 0, schemaWarning: null }
  }

  const rawBytes = Buffer.byteLength(raw, 'utf8')
  if (rawBytes > MAX_INDEX_READ_BYTES) {
    const warn = `成品索引超过 ${MAX_INDEX_READ_BYTES} 字节（实际 ${rawBytes}），已跳过自动预读以保护性能`
    logWarn(host, warn)
    return { artifacts: [], latest_job_id: null, totalCount: 0, schemaWarning: warn }
  }

  try {
    const parsed = JSON.parse(raw)
    let schemaWarning = null
    if (parsed?.schema !== EXPECTED_ARTIFACT_SCHEMA) {
      schemaWarning = `索引 schema 不匹配（期望 ${EXPECTED_ARTIFACT_SCHEMA}，实际 ${String(parsed?.schema ?? 'missing')}）`
      logWarn(host, schemaWarning)
    }
    const all = Array.isArray(parsed?.artifacts) ? parsed.artifacts : []
    const bounded = []
    for (const item of all) {
      if (bounded.length >= MAX_CACHED_ARTIFACTS) break
      const slim = slimArtifactEntry(item)
      if (slim) bounded.push(slim)
    }
    const latest = typeof parsed?.latest_job_id === 'string' && SAFE_JOB_ID_RE.test(parsed.latest_job_id)
      ? parsed.latest_job_id
      : (bounded[0]?.job_id ?? null)
    return {
      artifacts: bounded,
      latest_job_id: latest,
      updated_at: typeof parsed?.updated_at === 'string' ? parsed.updated_at : null,
      totalCount: all.length,
      schemaWarning,
    }
  } catch (err) {
    const warn = `成品索引 JSON 解析失败：${err?.message ?? String(err)}`
    logWarn(host, warn)
    return { artifacts: [], latest_job_id: null, totalCount: 0, schemaWarning: warn }
  }
}

async function safeNotify(host, message, level = 'info') {
  try {
    const { text } = truncateUtf8Bytes(message, MAX_NOTIFY_BYTES)
    await host.notifications?.show(text, { level })
  } catch (err) {
    logWarn(host, `notifications.show 失败：${err?.message ?? String(err)}`)
  }
}

async function safeSetStatus(host, text) {
  try {
    const clean = text === null ? null : String(text).slice(0, 120)
    await host.ui?.setStatus('laya-status', clean)
  } catch (err) {
    logWarn(host, `ui.setStatus 失败：${err?.message ?? String(err)}`)
  }
}

async function safePushWorkbench(host, payload) {
  try {
    await host.ui?.post('workbench', payload)
  } catch {
    // 面板未打开时忽略
  }
}

async function invokeWorkerInVenv(host, action, payloadObj, timeoutOverrideMs, signal) {
  if (!host.shell?.run) {
    const err = '宿主未授予 shell.run 权限，无法唤起本地 laya-env 虚拟环境。'
    logWarn(host, err)
    return { content: JSON.stringify({ ok: false, action, error: err }), isError: true }
  }

  const { config, configError } = await loadConfigWithStatus(host)
  if (configError) {
    return {
      content: JSON.stringify({ ok: false, action, error: configError, code: 'CONFIG_CORRUPT' }, null, 2),
      isError: true,
    }
  }

  let validatedDaemonUrl
  let command
  try {
    validatedDaemonUrl = payloadObj?.daemon_url !== undefined
      ? validateDaemonUrl(payloadObj.daemon_url)
      : config.daemonUrl
    const fullPayload = { ...payloadObj, daemon_url: validatedDaemonUrl }
    command = buildWorkerCommand(config, action, fullPayload)
  } catch (err) {
    const msg = err?.message ?? String(err)
    logWarn(host, `构建 worker 命令被拒绝（${action}）：${msg}`)
    return {
      content: JSON.stringify({ ok: false, action, error: msg, code: 'CONFIG_INVALID' }, null, 2),
      isError: true,
    }
  }

  if (signal?.aborted) {
    logWarn(host, `工具调用在执行前已被中止（${action}）`)
    return {
      content: JSON.stringify({ ok: false, action, error: '调用已取消', aborted: true }, null, 2),
      isError: true,
    }
  }

  const timeoutMs = Math.max(
    10_000,
    Math.min(600_000, Number(timeoutOverrideMs || config.defaultTimeoutMs || 120_000)),
  )

  logDebug(host, `shell.run 开始 action=${action} timeoutMs=${timeoutMs}`)
  let res
  try {
    res = await host.shell.run(command, { timeoutMs })
  } catch (err) {
    const aborted = Boolean(signal?.aborted) || /abort|cancel|timeout/i.test(String(err?.message ?? err))
    const errMsg = `host.shell.run 执行异常（action=${action}）：${err?.message ?? String(err)}`
    logWarn(host, errMsg)
    return {
      content: JSON.stringify({
        ok: false,
        action,
        error: errMsg,
        aborted,
        timeout_ms: timeoutMs,
      }, null, 2),
      isError: true,
    }
  }

  const parsed = parseWorkerJsonOutput(res?.output)
  if (!parsed) {
    const errMsg = 'laya_artifact_worker 未返回可解析的 JSON 结果'
    logWarn(host, `${errMsg}（action=${action}, exitCode=${res?.exitCode}）`)
    return {
      content: JSON.stringify({
        ok: false,
        action,
        exit_code: res?.exitCode ?? null,
        error: errMsg,
        raw_output: truncateUtf8Bytes(String(res?.output ?? ''), 4096).text,
      }, null, 2),
      isError: true,
    }
  }

  const ok = Boolean(parsed.ok) && (res?.exitCode === 0 || res?.exitCode === null || res?.exitCode === undefined)
  logDebug(host, `shell.run 完成 action=${action} ok=${ok} exitCode=${res?.exitCode}`)
  const serialized = JSON.stringify(parsed, null, 2)
  const capped = truncateUtf8Bytes(serialized, MAX_FETCH_CONTENT_BYTES)
  const content = capped.truncated
    ? JSON.stringify({
        ok,
        action,
        job_id: parsed.job_id ?? null,
        summary_file: parsed.summary_file ?? null,
        truncated: true,
        total_bytes: capped.totalBytes,
        note: '输出已超过 512 KiB 上限，请通过 laya_fetch_artifact 按文件名分段读取。',
      }, null, 2)
    : serialized
  return { content, isError: !ok, parsed }
}

const sdk = globalThis.__tianshuTPI
if (sdk?.version !== '2.0' || typeof sdk.defineTianshuPlugin !== 'function') {
  throw new Error('laya-bridge 需要支持 TPI 2.0 的天枢隔离宿主。')
}

export default sdk.defineTianshuPlugin({
  id: PLUGIN_ID,

  async activate(host) {
    const state = createTrajectoryState()
    let lastAlertsCount = 0
    let syncSeq = 0

    const syncArtifactsAndUi = async () => {
      const seq = ++syncSeq
      const idx = await readArtifactsIndex(host)
      if (seq !== syncSeq) {
        return idx
      }
      state.recentArtifacts = idx.artifacts
      await safeSetStatus(host, formatStatusText(state, idx.artifacts.length, lastAlertsCount))
      await safePushWorkbench(host, {
        kind: 'state_sync',
        artifacts: idx.artifacts,
        latestJobId: idx.latest_job_id,
        totalCount: idx.totalCount,
        schemaWarning: idx.schemaWarning,
        trajectory: {
          calls: state.calls,
          verifyCalls: state.verifyCalls,
          previewStreak: state.previewStreakWithoutProgress,
          identicalCmdRun: state.identicalCmdRun,
        },
      })
      return idx
    }

    logDebug(host, `插件已激活 sessionId=${host.sessionId ?? 'none'} isWorker=${Boolean(host.isWorker)}`)
    await safeSetStatus(host, 'Laya · 就绪')

    return {
      tools: [
        {
          name: 'laya_venv_probe',
          description: '探测本地 laya-env 虚拟环境、PyTorch、权重目录与 8767 热态守护进程状态，不修改项目文件。',
          inputSchema: {
            type: 'object',
            properties: {
              daemon_url: {
                type: 'string',
                description: '可选：覆盖默认的本地回环 Laya 8767 地址（仅允许 http://127.0.0.1:<port> 或 http://localhost:<port>）',
              },
            },
            additionalProperties: false,
          },
          concurrencySafe: false,
          requiresApproval: true,
          async execute({ args, signal }) {
            const out = await invokeWorkerInVenv(
              host,
              'probe',
              args?.daemon_url ? { daemon_url: String(args.daemon_url) } : {},
              30_000,
              signal,
            )
            if (!out.isError && out.parsed) {
              const daemonOk = out.parsed.daemon_8767?.reachable ? '8767热态在线' : '冷态可启动'
              await safeSetStatus(host, `Laya · ${daemonOk}`)
            } else if (out.isError) {
              await safeNotify(host, 'Laya 环境探测失败，请检查设置页路径配置', 'warning')
            }
            return { content: out.content, isError: out.isError }
          },
        },
        {
          name: 'laya_venv_decide',
          description: '在本地 laya-env 中运行 Laya 三问决策（fast_path/parallel_safe/route，支持单条或批量命令），产出并发分组与路由成品。',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: '单条待决策的 Shell 命令',
              },
              commands: {
                type: 'array',
                items: { type: 'string' },
                maxItems: 32,
                description: '批量待决策的 Shell 命令列表（最多 32 条）',
              },
              offline: {
                type: 'boolean',
                description: '是否跳过 8767 守护进程、直接在 laya-env 内本地推理',
              },
              save_artifact: {
                type: 'boolean',
                description: '是否把决策成品写入 .laya/artifacts（默认 true）',
              },
            },
            additionalProperties: false,
          },
          concurrencySafe: false,
          requiresApproval: true,
          async execute({ args, signal }) {
            if (Array.isArray(args?.commands) && args.commands.length > 32) {
              return {
                content: JSON.stringify({ ok: false, error: 'commands 最多允许 32 条命令' }),
                isError: true,
              }
            }
            const payload = {
              command: typeof args?.command === 'string' ? args.command : undefined,
              commands: Array.isArray(args?.commands) ? args.commands.map(String) : undefined,
              offline: Boolean(args?.offline),
              save_artifact: args?.save_artifact !== false,
            }
            const out = await invokeWorkerInVenv(host, 'decide', payload, 90_000, signal)
            if (!out.isError && out.parsed?.job_id) {
              state.lastProducedJob = String(out.parsed.job_id).slice(0, 80)
              await syncArtifactsAndUi()
              await safeNotify(host, `三问决策成品已就绪：${state.lastProducedJob}`, 'info')
            } else if (out.isError) {
              await safeNotify(host, 'Laya 三问决策执行失败', 'warning')
            }
            return { content: out.content, isError: out.isError }
          },
        },
        {
          name: 'laya_venv_produce',
          description: '派活给本地 laya-env 虚拟环境产出成品（workspace_digest 项目简报 / html_audit 静态质检 / py_script 虚拟环境脚本），写入 .laya/artifacts 并返回精简摘要。',
          inputSchema: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['workspace_digest', 'html_audit', 'py_script'],
                description: '虚拟环境生产模式',
              },
              subpath: {
                type: 'string',
                description: 'workspace_digest 可选子目录相对路径',
              },
              max_files: {
                type: 'integer',
                minimum: 20,
                maximum: 10000,
                description: 'workspace_digest 最多扫描文件数（20..10000）',
              },
              target_path: {
                type: 'string',
                description: 'html_audit 目标 HTML 相对路径',
              },
              script_path: {
                type: 'string',
                description: 'py_script 要在 laya-env 中执行的工作区内 .py 相对路径',
              },
              script_args: {
                type: 'array',
                items: { type: 'string' },
                description: 'py_script 命令行参数列表',
              },
              timeout_sec: {
                type: 'integer',
                minimum: 5,
                maximum: 540,
                description: 'py_script 超时秒数（5..540）',
              },
            },
            required: ['mode'],
            additionalProperties: false,
          },
          concurrencySafe: false,
          requiresApproval: true,
          async execute({ args, signal }) {
            const mode = String(args?.mode ?? '')
            if (!['workspace_digest', 'html_audit', 'py_script'].includes(mode)) {
              return {
                content: JSON.stringify({ ok: false, error: `不支持的 mode：${mode}` }),
                isError: true,
              }
            }
            if (args?.max_files !== undefined) {
              if (!Number.isInteger(args.max_files) || args.max_files < 20 || args.max_files > 10000) {
                return {
                  content: JSON.stringify({ ok: false, error: 'max_files 必须是 20..10000 之间的整数' }),
                  isError: true,
                }
              }
            }
            if (args?.timeout_sec !== undefined) {
              if (!Number.isInteger(args.timeout_sec) || args.timeout_sec < 5 || args.timeout_sec > 540) {
                return {
                  content: JSON.stringify({ ok: false, error: 'timeout_sec 必须是 5..540 之间的整数' }),
                  isError: true,
                }
              }
            }
            const payload = {
              mode,
              subpath: typeof args?.subpath === 'string' ? args.subpath : undefined,
              max_files: args?.max_files,
              target_path: typeof args?.target_path === 'string' ? args.target_path : undefined,
              script_path: typeof args?.script_path === 'string' ? args.script_path : undefined,
              script_args: Array.isArray(args?.script_args) ? args.script_args.map(String) : undefined,
              timeout_sec: args?.timeout_sec,
            }
            const timeoutMs = payload.timeout_sec ? (payload.timeout_sec + 15) * 1000 : undefined
            const out = await invokeWorkerInVenv(host, 'produce', payload, timeoutMs, signal)
            if (!out.isError && out.parsed?.job_id) {
              state.lastProducedJob = String(out.parsed.job_id).slice(0, 80)
              await syncArtifactsAndUi()
              await safeNotify(host, `虚拟环境成品已产出：${state.lastProducedJob}`, 'info')
            } else if (out.isError) {
              await safeNotify(host, `虚拟环境任务失败（${mode}）`, 'warning')
            }
            return { content: out.content, isError: out.isError }
          },
        },
        {
          name: 'laya_fetch_artifact',
          description: '只读列出或提取 .laya/artifacts 中 Laya 已产出的成品清单、manifest、summary 或指定产物正文供主模型直接使用。',
          inputSchema: {
            type: 'object',
            properties: {
              job_id: {
                type: 'string',
                description: '留空则返回全部成品索引；传 "latest" 返回最新成品；传具体 job_id 则读取该成品。',
              },
              file: {
                type: 'string',
                description: '成品目录下的相对文件名，默认 "summary.md"（可传 "manifest.json"、"report.json"、"digest.json"、"outputs/..."）。',
              },
            },
            additionalProperties: false,
          },
          concurrencySafe: true,
          async execute({ args }) {
            if (!host.workspace?.read) {
              return { content: JSON.stringify({ ok: false, error: '宿主未授予 workspace.read 权限' }), isError: true }
            }
            const idx = await readArtifactsIndex(host)
            const requestedJob = typeof args?.job_id === 'string' ? args.job_id.trim() : ''
            if (!requestedJob) {
              return {
                content: JSON.stringify({
                  ok: true,
                  action: 'fetch_index',
                  latest_job_id: idx.latest_job_id,
                  count: idx.artifacts.length,
                  total_count: idx.totalCount,
                  schema_warning: idx.schemaWarning,
                  artifacts: idx.artifacts,
                }, null, 2),
              }
            }

            const targetJobId = requestedJob === 'latest' ? (idx.latest_job_id || '') : requestedJob
            if (!targetJobId || !SAFE_JOB_ID_RE.test(targetJobId)) {
              return {
                content: JSON.stringify({
                  ok: false,
                  error: targetJobId ? `非法 job_id：${targetJobId}` : '当前工作区尚无已产出的 Laya 成品',
                }),
                isError: true,
              }
            }

            let relFile
            try {
              relFile = validateArtifactRelPath(args?.file ?? 'summary.md')
            } catch (err) {
              return {
                content: JSON.stringify({ ok: false, error: err.message }),
                isError: true,
              }
            }

            const fullRel = `.laya/artifacts/${targetJobId}/${relFile}`
            try {
              const rawContent = await host.workspace.read(fullRel)
              const capped = truncateUtf8Bytes(rawContent, MAX_FETCH_CONTENT_BYTES)
              if (capped.truncated) {
                logWarn(host, `laya_fetch_artifact 正文超限已截断：${fullRel} (${capped.totalBytes} -> ${capped.returnedBytes} B)`)
              }
              let manifest = null
              try {
                const mRaw = await host.workspace.read(`.laya/artifacts/${targetJobId}/manifest.json`)
                if (Buffer.byteLength(mRaw, 'utf8') <= 64 * 1024) {
                  manifest = JSON.parse(mRaw)
                }
              } catch {
                // optional
              }
              return {
                content: JSON.stringify({
                  ok: true,
                  action: 'fetch_artifact',
                  job_id: targetJobId,
                  file: relFile,
                  path: fullRel,
                  truncated: capped.truncated,
                  total_bytes: capped.totalBytes,
                  returned_bytes: capped.returnedBytes,
                  manifest,
                  content: capped.text,
                }, null, 2),
              }
            } catch (err) {
              const msg = `无法读取成品文件：${err?.message ?? String(err)}`
              logWarn(host, `${msg} (${fullRel})`)
              return {
                content: JSON.stringify({
                  ok: false,
                  job_id: targetJobId,
                  path: fullRel,
                  error: msg,
                }),
                isError: true,
              }
            }
          },
        },
      ],

      lifecycle: {
        async turnStart() {
          try {
            const idx = await readArtifactsIndex(host)
            state.recentArtifacts = idx.artifacts
            const alerts = evaluateTrajectoryAlerts(state)
            lastAlertsCount = alerts.length
            const block = buildPromptContextBlock(state, alerts, idx.artifacts)
            await host.promptContext?.setBlock(block)
            await safeSetStatus(host, formatStatusText(state, idx.artifacts.length, alerts.length))
          } catch (err) {
            logWarn(host, `turnStart 异常已兜底：${err?.message ?? String(err)}`)
          }
        },

        async toolEnd(event) {
          try {
            observeToolEnd(state, event)
            await safeSetStatus(host, formatStatusText(state, state.recentArtifacts.length, lastAlertsCount))
          } catch (err) {
            logWarn(host, `toolEnd 异常已兜底：${err?.message ?? String(err)}`)
          }
        },

        async sessionEnd() {
          try {
            logDebug(host, `会话结束（总观察步数=${state.calls}）`)
            await safeSetStatus(host, null)
          } catch (err) {
            logWarn(host, `sessionEnd 异常已兜底：${err?.message ?? String(err)}`)
          }
        },
      },

      ui: {
        async onMessage(view, message) {
          const type = String(message?.type ?? '')
          if (type === 'get_state') {
            const [cfgState, idx] = await Promise.all([loadConfigWithStatus(host), readArtifactsIndex(host)])
            state.recentArtifacts = idx.artifacts
            return {
              config: cfgState.config,
              configError: cfgState.configError,
              configured: cfgState.configured,
              artifacts: idx.artifacts,
              totalCount: idx.totalCount,
              latestJobId: idx.latest_job_id,
              schemaWarning: idx.schemaWarning,
              trajectory: {
                calls: state.calls,
                verifyCalls: state.verifyCalls,
                previewStreak: state.previewStreakWithoutProgress,
                identicalCmdRun: state.identicalCmdRun,
              },
            }
          }

          if (type === 'read_artifact') {
            const jobId = String(message?.jobId ?? '').trim()
            if (!SAFE_JOB_ID_RE.test(jobId)) {
              throw new Error(`非法 jobId：${jobId}`)
            }
            const relFile = validateArtifactRelPath(message?.file ?? 'summary.md')
            const [bodyRaw, manifestRaw] = await Promise.all([
              host.workspace.read(`.laya/artifacts/${jobId}/${relFile}`),
              host.workspace.read(`.laya/artifacts/${jobId}/manifest.json`).catch(() => null),
            ])
            const capped = truncateUtf8Bytes(bodyRaw, MAX_UI_CONTENT_BYTES)
            return {
              jobId,
              file: relFile,
              content: capped.text,
              truncated: capped.truncated,
              totalBytes: capped.totalBytes,
              manifest: manifestRaw && Buffer.byteLength(manifestRaw, 'utf8') <= 64 * 1024 ? JSON.parse(manifestRaw) : null,
            }
          }

          if (type === 'save_config') {
            const saved = await saveConfig(host, message?.config ?? {}, { allowEmptyPaths: false })
            await safeNotify(host, 'Laya 虚拟环境配置已保存', 'info')
            return { ok: true, config: saved, configError: null, configured: true }
          }

          if (type === 'reset_config') {
            if (message?.confirmed !== true) {
              throw new Error('重置配置需要显式二次确认（confirmed=true）')
            }
            const saved = await saveConfig(host, { ...DEFAULT_CONFIG }, { allowEmptyPaths: true })
            logWarn(host, '用户已确认重置配置为空默认值')
            await safeNotify(host, 'Laya 虚拟环境配置已重置，请重新填写本地路径', 'info')
            return { ok: true, config: saved, configError: null, configured: false }
          }

          logWarn(host, `收到未知页面消息 (${view}): ${type}`)
          throw new Error(`未知页面消息类型 (${view}): ${type}`)
        },

        async onCommand(commandId) {
          try {
            if (commandId === 'refresh-artifacts') {
              const idx = await syncArtifactsAndUi()
              await safeNotify(host, `已刷新 Laya 成品索引（显示 ${idx.artifacts.length}/${idx.totalCount} 项）`, 'info')
              return
            }
            if (commandId === 'open-workbench') {
              logDebug(host, '收到命令 open-workbench，同步工坊状态')
              await syncArtifactsAndUi()
              return
            }
            logWarn(host, `忽略未注册命令：${commandId}`)
          } catch (err) {
            logWarn(host, `onCommand(${commandId}) 异常：${err?.message ?? String(err)}`)
          }
        },
      },

      async dispose() {
        try {
          logDebug(host, '插件正在卸载释放')
          await safeSetStatus(host, null)
        } catch (err) {
          logWarn(host, `dispose 异常已兜底：${err?.message ?? String(err)}`)
        }
      },
    }
  },
})
