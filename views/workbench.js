let nextId = 1
const pending = new Map()
let activeJobId = null

function notifyResize() {
  const height = Math.min(4000, Math.max(200, document.body.scrollHeight + 12))
  parent.postMessage({ tpi: 'view', type: 'resize', height }, '*')
}

function ask(message) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parent.postMessage({ tpi: 'view', type: 'post', id, message }, '*')
  })
}

function renderState(state) {
  const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : []
  const traj = state?.trajectory ?? {}

  document.getElementById('stat-artifacts').textContent = String(artifacts.length)
  document.getElementById('stat-calls').textContent = String(traj.calls ?? 0)
  document.getElementById('stat-dup').textContent = String(traj.identicalCmdRun ?? 0)
  document.getElementById('stat-preview').textContent = String(traj.previewStreak ?? 0)

  const listEl = document.getElementById('artifact-list')
  listEl.replaceChildren()

  if (artifacts.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '当前工作区暂无成品。在对话中调用 laya_venv_decide 或 laya_venv_produce 后会自动出现。'
    listEl.appendChild(empty)
    notifyResize()
    return
  }

  for (const art of artifacts) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'item' + (art.job_id === activeJobId ? ' active' : '')

    const main = document.createElement('div')
    main.className = 'item-main'

    const title = document.createElement('div')
    title.className = 'item-title'
    title.textContent = art.title || art.job_id

    const meta = document.createElement('div')
    meta.className = 'item-meta'
    meta.textContent = `${art.job_id} · ${art.created_at || ''}`

    main.appendChild(title)
    main.appendChild(meta)

    const pill = document.createElement('span')
    pill.className = 'pill pill-ok'
    pill.textContent = art.kind || 'artifact'

    btn.appendChild(main)
    btn.appendChild(pill)
    btn.addEventListener('click', () => openArtifact(art.job_id, 'summary.md'))
    listEl.appendChild(btn)
  }

  notifyResize()
}

async function openArtifact(jobId, fileName) {
  activeJobId = jobId
  const detailPanel = document.getElementById('detail-panel')
  const detailTitle = document.getElementById('detail-title')
  const detailBody = document.getElementById('detail-body')
  const tabsEl = document.getElementById('file-tabs')

  detailPanel.hidden = false
  detailTitle.textContent = `${jobId} / ${fileName}`
  detailBody.textContent = '读取中…'
  notifyResize()

  try {
    const res = await ask({ type: 'read_artifact', jobId, file: fileName })
    detailBody.textContent = res.content || '(空文件)'

    tabsEl.replaceChildren()
    const files = Array.isArray(res.manifest?.files) ? res.manifest.files.map(f => f.name) : ['summary.md']
    if (!files.includes('manifest.json')) files.push('manifest.json')
    for (const fname of files) {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'btn' + (fname === fileName ? ' btn-primary' : '')
      tab.textContent = fname
      tab.addEventListener('click', () => openArtifact(jobId, fname))
      tabsEl.appendChild(tab)
    }
  } catch (err) {
    detailBody.textContent = `读取失败：${err.message}`
  }
  notifyResize()
}

async function refresh() {
  try {
    const state = await ask({ type: 'get_state' })
    renderState(state)
  } catch (err) {
    const listEl = document.getElementById('artifact-list')
    listEl.replaceChildren()
    const div = document.createElement('div')
    div.className = 'empty'
    div.textContent = `等待会话启动后可刷新：${err.message}`
    listEl.appendChild(div)
    notifyResize()
  }
}

window.addEventListener('message', event => {
  const data = event.data
  if (!data || data.tpi !== 'host') return
  if (data.type === 'hello') {
    refresh()
    return
  }
  if (data.type === 'push' && data.message?.kind === 'state_sync') {
    renderState(data.message)
    return
  }
  if (data.type === 'reply') {
    const waiter = pending.get(data.id)
    pending.delete(data.id)
    if (waiter) {
      if (data.ok) waiter.resolve(data.value)
      else waiter.reject(new Error(data.error || '请求失败'))
    }
  }
})

document.getElementById('btn-refresh').addEventListener('click', () => refresh())
parent.postMessage({ tpi: 'view', type: 'ready' }, '*')
notifyResize()
