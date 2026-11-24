/**
 * index.mjs —— Laya 虚拟环境工坊（laya-bridge v2.0.0 · TPI 2.0 全功能档入口）
 *
 * 严格遵守官方 TPI 2.0 隔离宿主规范（docs/developers/tpi2.md & tpi/tpi-v2.d.mts）：
 *   1. 通过 `globalThis.__tianshuTPI.defineTianshuPlugin` 注册；
 *   2. 插件进程本身零外部网络、零子进程、零本地权重加载，内存占用极低；
 *   3. 工具调用期间通过 `host.shell.run` 派活给本地 `laya-env`（`laya_artifact_worker.py`），
 *      所有任务参数经 Base64 编码传参（杜绝 shell 注入与跨平台引号问题），成品落盘 `.laya/artifacts/`；
 *   4. 工具 `laya_fetch_artifact` 与 UI 面板仅用 `host.workspace.read` 读取成品；
 *   5. 生命周期阶段（`turnStart`/`toolEnd`/`sessionEnd`）与 `ui.onMessage`/`ui.onCommand`
 *      绝不调用 `host.shell.run` 或 `host.workspace.write`，严格遵守 TPI 2.0 权限边界。
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
const CONFIG_FILE_NAME = 'config.json'

const DEFAULT_CONFIG = Object.freeze({
  pythonPath: 'D:/laya-env/Scripts/python.exe',
  workerScript: 'D:/laya-work/dsh-guard/optimizer/laya_artifact_worker.py',
  daemonUrl: 'http://127.0.0.1:8767',
  defaultTimeoutMs: 120_000,
})

const UNSAFE_SHELL_CHARS_RE = /[;&|`$<>!\r\n"'*?\[\]{}()]/
const SAFE_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/
const SAFE_REL_FILE_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

export function validateExecutablePath(label, rawPath) {
  const val = String(rawPath ?? '').trim()
  if (!val || val.length > 300) {
    throw new Error(`${label} 不能为空且长度不能超过 300 字符`)
  }
  if (UNSAFE_SHELL_CHARS_RE.test(val)) {
    throw new Error(`${label} 包含非法 Shell 元字符，已拒绝执行`)
  }
  return val
}

export function buildWorkerCommand(config, action, payloadObj) {
  const allowedActions = new Set(['probe', 'decide', 'produce', 'list'])
  if (!allowedActions.has(action)) {
    throw new Error(`不支持的 worker 动作：${action}`)
  }
  const py = validateExecutablePath('pythonPath', config.pythonPath)
  const script = validateExecutablePath('workerScript', config.workerScript)
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj ?? {}), 'utf8').toString('base64')
  if (!/^[A-Za-z0-9+/=]+$/.test(payloadB64)) {
    throw new Error('Base64 载荷校验失败')
  }
  return `"${py}" "${script}" ${action} --workspace . --payload-b64 ${payloadB64}`
}

export function parseWorkerJsonOutput(rawOutput) {
  const text = String(rawOutput ?? '').trim()
  if (!text) return null
  // 允许前置环境噪声，从最后一行起尝试解析 JSON
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        return JSON.parse(line)
      } catch {
        // continue scanning upwards
      }
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function loadConfig(host) {
  if (!host.storage?.dataDir) {
    return { ...DEFAULT_CONFIG }
  }
  try {
    const dir = await host.storage.dataDir()
    const raw = await readFile(join(dir, CONFIG_FILE_NAME), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      pythonPath: typeof parsed.pythonPath === 'string' && parsed.pythonPath.trim()
        ? parsed.pythonPath.trim()
        : DEFAULT_CONFIG.pythonPath,
      workerScript: typeof parsed.workerScript === 'string' && parsed.workerScript.trim()
        ? parsed.workerScript.trim()
        : DEFAULT_CONFIG.workerScript,
      daemonUrl: typeof parsed.daemonUrl === 'string' && parsed.daemonUrl.trim()
        ? parsed.daemonUrl.trim()
        : DEFAULT_CONFIG.daemonUrl,
      defaultTimeoutMs: Number.isFinite(Number(parsed.defaultTimeoutMs))
        ? Math.max(10_000, Math.min(600_000, Number(parsed.defaultTimeoutMs)))
        : DEFAULT_CONFIG.defaultTimeoutMs,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

async function saveConfig(host, patch) {
  if (!host.storage?.dataDir) {
    throw new Error('宿主未授予 storage 能力，无法保存配置')
  }
  const current = await loadConfig(host)
  const next = {
    pythonPath: patch.pythonPath !== undefined
      ? validateExecutablePath('pythonPath', patch.pythonPath)
      : current.pythonPath,
    workerScript: patch.workerScript !== undefined
      ? validateExecutablePath('workerScript', patch.workerScript)
      : current.workerScript,
    daemonUrl: patch.daemonUrl !== undefined
      ? String(patch.daemonUrl).trim() || DEFAULT_CONFIG.daemonUrl
      : current.daemonUrl,
    defaultTimeoutMs: patch.defaultTimeoutMs !== undefined
      ? Math.max(10_000, Math.min(600_000, Number(patch.defaultTimeoutMs) || DEFAULT_CONFIG.defaultTimeoutMs))
      : current.defaultTimeoutMs,
  }
  const dir = await host.storage.dataDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

async function readArtifactsIndex(host) {
  if (!host.workspace?.read) {
    return { artifacts: [], latest_job_id: null }
  }
  try {
    const raw = await host.workspace.read(ARTIFACTS_INDEX_PATH)
    const parsed = JSON.parse(raw)
    return {
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      latest_job_id: parsed.latest_job_id ?? null,
      updated_at: parsed.updated_at ?? null,
    }
  } catch {
    return { artifacts: [], latest_job_id: null }
  }
}

async function invokeWorkerInVenv(host, action, payloadObj, timeoutOverrideMs) {
  if (!host.shell?.run) {
    return {
      content: JSON.stringify({
        ok: false,
        error: '宿主未授予 shell.run 权限，无法唤起本地 laya-env 虚拟环境。',
      }),
      isError: true,
    }
  }
  const config = await loadConfig(host)
  const fullPayload = {
    daemon_url: config.daemonUrl,
    ...(payloadObj ?? {}),
  }
  const command = buildWorkerCommand(config, action, fullPayload)
  const timeoutMs = Math.max(
    10_000,
    Math.min(600_000, Number(timeoutOverrideMs || config.defaultTimeoutMs || 120_000)),
  )

  const res = await host.shell.run(command, { timeoutMs })
  const parsed = parseWorkerJsonOutput(res?.output)
  if (!parsed) {
    return {
      content: JSON.stringify({
        ok: false,
        action,
        exit_code: res?.exitCode ?? null,
        error: 'laya_artifact_worker 未返回可解析的 JSON 结果',
        raw_output: String(res?.output ?? '').slice(0, 4000),
      }, null, 2),
      isError: true,
    }
  }

  const ok = Boolean(parsed.ok) && (res?.exitCode === 0 || res?.exitCode === null || res?.exitCode === undefined)
  return {
    content: JSON.stringify(parsed, null, 2),
    isError: !ok,
    parsed,
  }
}

async function safeNotify(host, message, level = 'info') {
  try {
    await host.notifications?.show(message, { level })
  } catch {
    // non-fatal
  }
}

async function safeSetStatus(host, text) {
  try {
    await host.ui?.setStatus('laya-status', text)
  } catch {
    // non-fatal
  }
}

async function safePushWorkbench(host, payload) {
  try {
    await host.ui?.post('workbench', payload)
  } catch {
    // panel may not be open
  }
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

    const syncArtifactsAndUi = async () => {
      const idx = await readArtifactsIndex(host)
      state.recentArtifacts = idx.artifacts
      await safeSetStatus(host, formatStatusText(state, idx.artifacts.length, lastAlertsCount))
      await safePushWorkbench(host, {
        kind: 'state_sync',
        artifacts: idx.artifacts,
        latestJobId: idx.latest_job_id,
        trajectory: {
          calls: state.calls,
          verifyCalls: state.verifyCalls,
          previewStreak: state.previewStreakWithoutProgress,
          identicalCmdRun: state.identicalCmdRun,
        },
      })
      return idx
    }

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
                description: '可选：覆盖默认的 Laya 8767 热态守护进程地址',
              },
            },
            additionalProperties: false,
          },
          requiresApproval: true,
          async execute({ args }) {
            const out = await invokeWorkerInVenv(
              host,
              'probe',
              args?.daemon_url ? { daemon_url: String(args.daemon_url) } : {},
              30_000,
            )
            if (!out.isError && out.parsed) {
              const daemonOk = out.parsed.daemon_8767?.reachable ? '8767热态在线' : '冷态可启动'
              await safeSetStatus(host, `Laya · ${daemonOk}`)
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
          requiresApproval: true,
          async execute({ args }) {
            const payload = {
              command: typeof args?.command === 'string' ? args.command : undefined,
              commands: Array.isArray(args?.commands) ? args.commands.map(String) : undefined,
              offline: Boolean(args?.offline),
              save_artifact: args?.save_artifact !== false,
            }
            const out = await invokeWorkerInVenv(host, 'decide', payload, 90_000)
            if (!out.isError && out.parsed?.job_id) {
              state.lastProducedJob = out.parsed.job_id
              await syncArtifactsAndUi()
              await safeNotify(host, `三问决策成品已就绪：${out.parsed.job_id}`, 'info')
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
                description: 'py_script 超时秒数（5..540）',
              },
            },
            required: ['mode'],
            additionalProperties: false,
          },
          requiresApproval: true,
          async execute({ args }) {
            const mode = String(args?.mode ?? '')
            const payload = {
              mode,
              subpath: typeof args?.subpath === 'string' ? args.subpath : undefined,
              max_files: Number.isInteger(args?.max_files) ? args.max_files : undefined,
              target_path: typeof args?.target_path === 'string' ? args.target_path : undefined,
              script_path: typeof args?.script_path === 'string' ? args.script_path : undefined,
              script_args: Array.isArray(args?.script_args) ? args.script_args.map(String) : undefined,
              timeout_sec: Number.isInteger(args?.timeout_sec) ? args.timeout_sec : undefined,
            }
            const timeoutMs = payload.timeout_sec ? (payload.timeout_sec + 15) * 1000 : undefined
            const out = await invokeWorkerInVenv(host, 'produce', payload, timeoutMs)
            if (!out.isError && out.parsed?.job_id) {
              state.lastProducedJob = out.parsed.job_id
              await syncArtifactsAndUi()
              await safeNotify(host, `虚拟环境成品已产出：${out.parsed.job_id}`, 'info')
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

            const relFile = typeof args?.file === 'string' && args.file.trim()
              ? args.file.trim().replace(/\\/g, '/')
              : 'summary.md'
            if (!SAFE_REL_FILE_RE.test(relFile) || relFile.includes('..')) {
              return {
                content: JSON.stringify({ ok: false, error: `非法成品文件名：${relFile}` }),
                isError: true,
              }
            }

            const fullRel = `.laya/artifacts/${targetJobId}/${relFile}`
            try {
              const content = await host.workspace.read(fullRel)
              let manifest = null
              try {
                manifest = JSON.parse(await host.workspace.read(`.laya/artifacts/${targetJobId}/manifest.json`))
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
                  manifest,
                  content,
                }, null, 2),
              }
            } catch (err) {
              return {
                content: JSON.stringify({
                  ok: false,
                  job_id: targetJobId,
                  path: fullRel,
                  error: `无法读取成品文件：${err?.message ?? String(err)}`,
                }),
                isError: true,
              }
            }
          },
        },
      ],

      lifecycle: {
        async turnStart() {
          const idx = await readArtifactsIndex(host)
          state.recentArtifacts = idx.artifacts
          const alerts = evaluateTrajectoryAlerts(state)
          lastAlertsCount = alerts.length
          const block = buildPromptContextBlock(state, alerts, idx.artifacts)
          await host.promptContext?.setBlock(block)
          await safeSetStatus(host, formatStatusText(state, idx.artifacts.length, alerts.length))
        },

        async toolEnd(event) {
          observeToolEnd(state, event)
          await safeSetStatus(host, formatStatusText(state, state.recentArtifacts.length, lastAlertsCount))
        },

        async sessionEnd() {
          await safeSetStatus(host, null)
        },
      },

      ui: {
        async onMessage(view, message) {
          const type = String(message?.type ?? '')
          if (type === 'get_state') {
            const [config, idx] = await Promise.all([loadConfig(host), readArtifactsIndex(host)])
            state.recentArtifacts = idx.artifacts
            return {
              config,
              artifacts: idx.artifacts,
              latestJobId: idx.latest_job_id,
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
            const relFile = String(message?.file ?? 'summary.md').trim().replace(/\\/g, '/')
            if (!SAFE_JOB_ID_RE.test(jobId) || !SAFE_REL_FILE_RE.test(relFile) || relFile.includes('..')) {
              throw new Error('非法成品路径参数')
            }
            const [body, manifestRaw] = await Promise.all([
              host.workspace.read(`.laya/artifacts/${jobId}/${relFile}`),
              host.workspace.read(`.laya/artifacts/${jobId}/manifest.json`).catch(() => null),
            ])
            return {
              jobId,
              file: relFile,
              content: body,
              manifest: manifestRaw ? JSON.parse(manifestRaw) : null,
            }
          }

          if (type === 'save_config') {
            const saved = await saveConfig(host, message?.config ?? {})
            await safeNotify(host, 'Laya 虚拟环境配置已保存', 'info')
            return { ok: true, config: saved }
          }

          if (type === 'reset_config') {
            const saved = await saveConfig(host, { ...DEFAULT_CONFIG })
            return { ok: true, config: saved }
          }

          throw new Error(`未知页面消息类型 (${view}): ${type}`)
        },

        async onCommand(commandId) {
          if (commandId === 'refresh-artifacts') {
            const idx = await syncArtifactsAndUi()
            await safeNotify(host, `已刷新 Laya 成品索引（共 ${idx.artifacts.length} 项）`, 'info')
          }
        },
      },

      async dispose() {
        await safeSetStatus(host, null)
      },
    }
  },
})
