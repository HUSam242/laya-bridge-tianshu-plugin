import { createTpiBridge } from './tpi-bridge.js'

let activeJobId = null
let activeFileName = null

const bridge = createTpiBridge({
  onHello() {
    refresh()
  },
  onPush(message) {
    if (message?.kind === 'state_sync') {
      renderState(message)
    }
  },
  defaultTimeoutMs: 15_000,
})

function setBanner(text) {
  const banner = document.getElementById('warn-banner')
  if (!text) {
    banner.hidden = true
    banner.textContent = ''
  } else {
    banner.hidden = false
    banner.textContent = text
  }
}

function renderState(state) {
  const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : []
  const traj = state?.trajectory ?? {}

  if (state?.configError) {
    setBanner(state.configError)
  } else if (state?.schemaWarning) {
    setBanner(state.schemaWarning)
  } else if (state?.configured === false) {
    setBanner('尚未配置本地 laya-env 路径，请前往「设置 → 插件界面 → Laya 虚拟环境」填写后使用。')
  } else {
    setBanner('')
  }

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
    bridge.notifyResize(200)
    return
  }

  for (const art of artifacts) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('role', 'listitem')
    const isActive = art.job_id === activeJobId
    btn.className = 'item' + (isActive ? ' active' : '')
    btn.setAttribute('aria-pressed', String(isActive))

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

  bridge.notifyResize(200)
}

async function openArtifact(jobId, fileName) {
  activeJobId = jobId
  activeFileName = fileName
  const detailPanel = document.getElementById('detail-panel')
  const detailTitle = document.getElementById('detail-title')
  const detailBody = document.getElementById('detail-body')
  const tabsEl = document.getElementById('file-tabs')

  detailPanel.hidden = false
  detailTitle.textContent = `${jobId} / ${fileName}`
  detailBody.textContent = '读取中…'
  bridge.notifyResize(200)

  try {
    const res = await bridge.ask({ type: 'read_artifact', jobId, file: fileName })
    const suffix = res.truncated ? `\n\n[已截断：原始大小 ${res.totalBytes} 字节]` : ''
    detailBody.textContent = (res.content || '(空文件)') + suffix

    tabsEl.replaceChildren()
    const files = Array.isArray(res.manifest?.files) ? res.manifest.files.map(f => f.name) : ['summary.md']
    if (!files.includes('manifest.json')) files.push('manifest.json')
    for (const fname of files) {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.setAttribute('role', 'tab')
      const selected = fname === activeFileName
      tab.setAttribute('aria-selected', String(selected))
      tab.className = 'btn' + (selected ? ' btn-primary' : '')
      tab.textContent = fname
      tab.addEventListener('click', () => openArtifact(jobId, fname))
      tabsEl.appendChild(tab)
    }
  } catch (err) {
    detailBody.textContent = `读取失败：${err.message}`
  }
  bridge.notifyResize(200)
}

async function refresh() {
  try {
    const state = await bridge.ask({ type: 'get_state' })
    renderState(state)
  } catch (err) {
    const listEl = document.getElementById('artifact-list')
    listEl.replaceChildren()
    const div = document.createElement('div')
    div.className = 'empty'
    div.textContent = `等待会话启动后可刷新：${err.message}`
    listEl.appendChild(div)
    bridge.notifyResize(200)
  }
}

document.getElementById('btn-refresh').addEventListener('click', () => refresh())
bridge.ready(200)
