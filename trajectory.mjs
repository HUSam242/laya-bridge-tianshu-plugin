/**
 * trajectory.mjs —— TPI 2.0 隔离进程内纯内存 L3 轨迹监控与 <laya-bridge> 上下文块构造器。
 *
 * 严格约束：
 *   - 零网络、零子进程、零宿主写操作，可安全运行在 turnStart / toolEnd 生命周期内；
 *   - 输出的 promptContext 根标签必须以插件 ID `laya-bridge` 命名，总长度远低于 32 KiB 限制。
 */

export const TRAJECTORY_THRESHOLDS = Object.freeze({
  calls: 120,
  verifyRatio: 0.4,
  stepsSinceWrite: 20,
  sameKindRun: 8,
  previewLoopRun: 6,
  identicalCmdRun: 4,
  cooldownSteps: 10,
  ratioMinCalls: 12,
})

const SHELL_TOOLS = new Set(['bash', 'sh', 'pwsh', 'powershell', 'cmd', 'shell'])
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'write_file', 'edit_file', 'apply_patch', 'hash_edit'])
const VERIFY_TOOLS = new Set(['read_image', 'search_preview', 'search_self_check'])
const PREVIEW_LOOP_TOOLS = new Set(['search_preview', 'search_self_check'])
const VERIFY_CMD_RE = /\b(?:pytest|jest|vitest|mocha|lint|eslint|typecheck|mypy|ruff|verify|preview|screenshot|playwright)\b|\bnode\s+--test\b|\bpython\s+-m\s+pytest\b/i

function normalizeCmdKey(cmd) {
  return String(cmd || '')
    .trim()
    .replace(/^\s*cd\s+(?:\/d\s+)?(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*/i, '')
    .replace(/\|\s*(?:tail|head)\s+(?:-\s*n\s*|-)\d+\s*$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function classifyToolKind(tool, target) {
  const nm = String(tool ?? '').toLowerCase()
  const cmd = String(target ?? '').trim()
  if (!SHELL_TOOLS.has(nm) || cmd === '') return nm
  const head = cmd.split(/[\s;|&]+/).find(Boolean) ?? ''
  return `${nm}:${head.replace(/^.*[\\/]/, '').toLowerCase()}`
}

function escapeXmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function createTrajectoryState() {
  return {
    calls: 0,
    verifyCalls: 0,
    previewStreakWithoutProgress: 0,
    lastWriteCall: 0,
    lastKind: '',
    kindRun: 0,
    lastCmdKey: '',
    identicalCmdRun: 0,
    cooldown: new Map(),
    recentArtifacts: [],
    lastProducedJob: null,
  }
}

export function observeToolEnd(state, event) {
  const tool = String(event?.tool ?? '').toLowerCase()
  const target = typeof event?.target === 'string' ? event.target : ''

  state.calls += 1
  const isVerify =
    VERIFY_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && target !== '' && VERIFY_CMD_RE.test(target))
  if (isVerify) {
    state.verifyCalls += 1
  }

  if (PREVIEW_LOOP_TOOLS.has(tool)) {
    state.previewStreakWithoutProgress += 1
  }

  if (WRITE_TOOLS.has(tool)) {
    state.lastWriteCall = state.calls
    state.previewStreakWithoutProgress = 0
  } else if (!PREVIEW_LOOP_TOOLS.has(tool) && !isVerify) {
    state.previewStreakWithoutProgress = Math.max(0, state.previewStreakWithoutProgress - 1)
  }

  const kind = classifyToolKind(tool, target)
  if (kind !== '' && kind === state.lastKind) {
    state.kindRun += 1
  } else {
    state.lastKind = kind
    state.kindRun = kind === '' ? 0 : 1
  }

  if (SHELL_TOOLS.has(tool) && target.trim() !== '') {
    const ckey = normalizeCmdKey(target)
    if (ckey && ckey === state.lastCmdKey) {
      state.identicalCmdRun += 1
    } else {
      state.lastCmdKey = ckey
      state.identicalCmdRun = 1
    }
  } else if (!SHELL_TOOLS.has(tool)) {
    state.lastCmdKey = ''
    state.identicalCmdRun = 0
  }

  return state
}

function tickCooldowns(state) {
  for (const [sig, left] of state.cooldown) {
    if (left <= 1) state.cooldown.delete(sig)
    else state.cooldown.set(sig, left - 1)
  }
}

export function evaluateTrajectoryAlerts(state, thresholds = TRAJECTORY_THRESHOLDS) {
  tickCooldowns(state)
  const raw = []

  if (state.previewStreakWithoutProgress >= thresholds.previewLoopRun) {
    raw.push({
      sig: 'preview-doom-loop',
      risk: 'high',
      text: `连续 ${state.previewStreakWithoutProgress} 次预览/自检未产出代码改动，疑似验证打转，建议立刻停下定位根因或改用 laya_venv_produce(html_audit)。`,
    })
  }
  if (state.identicalCmdRun >= thresholds.identicalCmdRun) {
    raw.push({
      sig: `identical-cmd:${state.lastCmdKey.slice(0, 48)}`,
      risk: 'high',
      text: `同一命令连续重复执行 ${state.identicalCmdRun} 次，建议停止重试并换策略。`,
    })
  }
  if (state.kindRun >= thresholds.sameKindRun) {
    raw.push({
      sig: `same-kind:${state.lastKind}`,
      risk: 'medium',
      text: `同类工具 ${state.lastKind} 连续执行 ${state.kindRun} 次，考虑批量合并或让 laya_venv_produce 一次性在虚拟环境产成品。`,
    })
  }
  const sinceWrite = state.calls - state.lastWriteCall
  if (state.calls >= thresholds.ratioMinCalls && sinceWrite >= thresholds.stepsSinceWrite) {
    raw.push({
      sig: 'long-without-write',
      risk: 'medium',
      text: `已连续 ${sinceWrite} 步未产生写入，建议用 laya_venv_produce(workspace_digest) 快速收敛上下文并推进修改。`,
    })
  }
  if (
    state.calls >= thresholds.ratioMinCalls &&
    state.verifyCalls / Math.max(1, state.calls) >= thresholds.verifyRatio
  ) {
    raw.push({
      sig: 'high-verify-ratio',
      risk: 'medium',
      text: `验证类调用占比已达 ${Math.round((state.verifyCalls / state.calls) * 100)}%，注意避免过度重复验证。`,
    })
  }
  if (state.calls >= thresholds.calls) {
    raw.push({
      sig: 'long-session',
      risk: 'low',
      text: `会话工具调用已达 ${state.calls} 次，建议阶段性收敛交付。`,
    })
  }

  const emitted = []
  for (const item of raw) {
    if (!state.cooldown.has(item.sig)) {
      state.cooldown.set(item.sig, thresholds.cooldownSteps)
      emitted.push(item)
    }
  }
  return emitted
}

export function buildPromptContextBlock(state, alerts, readyArtifacts) {
  const artifacts = Array.isArray(readyArtifacts) ? readyArtifacts.slice(0, 5) : []
  if (alerts.length === 0 && artifacts.length === 0) {
    return null
  }

  const doomRisk = alerts.some(a => a.risk === 'high')
    ? 'high'
    : alerts.some(a => a.risk === 'medium')
      ? 'medium'
      : 'low'

  const lines = [
    `<laya-bridge mode="tpi2-venv" calls="${state.calls}" doom-loop-risk="${doomRisk}" ready-artifacts="${artifacts.length}">`,
  ]

  if (artifacts.length > 0) {
    lines.push('  <ready-artifacts hint="可直接调用 laya_fetch_artifact 按 job_id 零拷贝取货">')
    for (const art of artifacts) {
      lines.push(
        `    <artifact job-id="${escapeXmlAttr(art.job_id)}" kind="${escapeXmlAttr(art.kind)}" summary-file="${escapeXmlAttr(art.summary_file)}">${escapeXmlText(art.title || art.job_id)}</artifact>`,
      )
    }
    lines.push('  </ready-artifacts>')
  }

  if (alerts.length > 0) {
    lines.push('  <trajectory-alerts>')
    for (const al of alerts) {
      lines.push(`    <alert risk="${escapeXmlAttr(al.risk)}">${escapeXmlText(al.text)}</alert>`)
    }
    lines.push('  </trajectory-alerts>')
  }

  lines.push('</laya-bridge>')
  const xml = lines.join('\n')
  return xml.length <= 28_000 ? xml : `${xml.slice(0, 27_900)}\n</laya-bridge>`
}

export function formatStatusText(state, artifactCount, alertsCount) {
  const parts = ['Laya']
  if (artifactCount > 0) parts.push(`${artifactCount}成品`)
  if (alertsCount > 0) parts.push(`⚠${alertsCount}`)
  else if (state.calls > 0) parts.push(`${state.calls}步`)
  const text = parts.join(' · ')
  return text.slice(0, 120)
}
