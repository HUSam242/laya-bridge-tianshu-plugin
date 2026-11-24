function notifyResize() {
  const height = Math.min(4000, Math.max(120, document.body.scrollHeight + 12))
  parent.postMessage({ tpi: 'view', type: 'resize', height }, '*')
}

function addPill(container, text, variant = '') {
  const span = document.createElement('span')
  span.className = 'pill' + (variant ? ` pill-${variant}` : '')
  span.textContent = text
  container.appendChild(span)
}

function renderToolContext(context) {
  const tool = context?.tool || 'laya'
  const isError = Boolean(context?.isError)
  const rawResult = typeof context?.result === 'string' ? context.result : JSON.stringify(context?.result ?? '', null, 2)

  const titleEl = document.getElementById('card-title')
  const metaEl = document.getElementById('card-meta')
  const statusEl = document.getElementById('card-status')
  const pillsEl = document.getElementById('card-pills')
  const bodyEl = document.getElementById('card-body')

  pillsEl.replaceChildren()
  statusEl.textContent = isError ? 'ERROR' : 'OK'
  statusEl.className = 'pill ' + (isError ? 'pill-err' : 'pill-ok')

  let parsed = null
  try {
    parsed = JSON.parse(rawResult)
  } catch {
    parsed = null
  }

  if (!parsed || typeof parsed !== 'object') {
    titleEl.textContent = `Laya · ${tool}`
    metaEl.textContent = context?.truncated ? '结果已截断（点击展开原始输出）' : '原始文本结果'
    bodyEl.textContent = rawResult
    notifyResize()
    return
  }

  titleEl.textContent = parsed.job_id ? `Laya 成品 · ${parsed.job_id}` : `Laya · ${tool}`
  metaEl.textContent = parsed.summary_file || parsed.path || parsed.action || tool

  if (parsed.total_latency_ms !== undefined) addPill(pillsEl, `${parsed.total_latency_ms} ms`)
  if (parsed.meta?.latency_ms !== undefined) addPill(pillsEl, `${parsed.meta.latency_ms} ms`)
  if (parsed.mode) addPill(pillsEl, parsed.mode, 'ok')
  if (parsed.execution_plan) {
    addPill(pillsEl, `可并行 ${parsed.execution_plan.parallel_batch?.length ?? 0}`, 'ok')
    addPill(pillsEl, `串行 ${parsed.execution_plan.serial_queue?.length ?? 0}`, 'warn')
  }
  if (parsed.meta?.score !== undefined) {
    addPill(pillsEl, `质检 ${parsed.meta.score}/100`, parsed.meta.score >= 85 ? 'ok' : 'warn')
  }
  if (parsed.count !== undefined) {
    addPill(pillsEl, `成品 ${parsed.count} 项`, 'ok')
  }

  if (typeof parsed.summary_markdown === 'string' && parsed.summary_markdown.trim()) {
    bodyEl.textContent = parsed.summary_markdown
  } else if (typeof parsed.content === 'string' && parsed.content.trim()) {
    bodyEl.textContent = parsed.content
  } else {
    bodyEl.textContent = JSON.stringify(parsed, null, 2)
  }

  notifyResize()
}

window.addEventListener('message', event => {
  const data = event.data
  if (!data || data.tpi !== 'host') return
  if (data.type === 'hello') {
    renderToolContext(data.context)
  }
})

parent.postMessage({ tpi: 'view', type: 'ready' }, '*')
notifyResize()
