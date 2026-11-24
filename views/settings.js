let nextId = 1
const pending = new Map()

function notifyResize() {
  const height = Math.min(4000, Math.max(260, document.body.scrollHeight + 12))
  parent.postMessage({ tpi: 'view', type: 'resize', height }, '*')
}

function ask(message) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parent.postMessage({ tpi: 'view', type: 'post', id, message }, '*')
  })
}

function fillForm(cfg) {
  if (!cfg) return
  document.getElementById('input-python').value = cfg.pythonPath || ''
  document.getElementById('input-worker').value = cfg.workerScript || ''
  document.getElementById('input-daemon').value = cfg.daemonUrl || ''
  document.getElementById('input-timeout').value = String(cfg.defaultTimeoutMs || 120000)
}

async function loadInitial() {
  const status = document.getElementById('save-status')
  try {
    const state = await ask({ type: 'get_state' })
    fillForm(state.config)
    status.textContent = ''
  } catch (err) {
    status.textContent = `未连接会话：${err.message}`
  }
  notifyResize()
}

document.getElementById('btn-save').addEventListener('click', async () => {
  const status = document.getElementById('save-status')
  status.textContent = '保存中…'
  try {
    const res = await ask({
      type: 'save_config',
      config: {
        pythonPath: document.getElementById('input-python').value.trim(),
        workerScript: document.getElementById('input-worker').value.trim(),
        daemonUrl: document.getElementById('input-daemon').value.trim(),
        defaultTimeoutMs: Number(document.getElementById('input-timeout').value) || 120000,
      },
    })
    fillForm(res.config)
    status.textContent = '已保存'
  } catch (err) {
    status.textContent = `保存失败：${err.message}`
  }
  notifyResize()
})

document.getElementById('btn-reset').addEventListener('click', async () => {
  const status = document.getElementById('save-status')
  try {
    const res = await ask({ type: 'reset_config' })
    fillForm(res.config)
    status.textContent = '已恢复默认'
  } catch (err) {
    status.textContent = `重置失败：${err.message}`
  }
  notifyResize()
})

window.addEventListener('message', event => {
  const data = event.data
  if (!data || data.tpi !== 'host') return
  if (data.type === 'hello') {
    loadInitial()
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

parent.postMessage({ tpi: 'view', type: 'ready' }, '*')
notifyResize()
