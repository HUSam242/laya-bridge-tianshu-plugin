import { createTpiBridge } from './tpi-bridge.js'

let resetArmed = false
let resetArmTimer = null

const bridge = createTpiBridge({
  onHello() {
    loadInitial()
  },
  defaultTimeoutMs: 15_000,
})

function disarmResetButton() {
  resetArmed = false
  if (resetArmTimer) {
    clearTimeout(resetArmTimer)
    resetArmTimer = null
  }
  const btn = document.getElementById('btn-reset')
  btn.textContent = '恢复默认'
  btn.className = 'btn'
  btn.setAttribute('aria-pressed', 'false')
}

function setConfigError(msg) {
  const el = document.getElementById('config-error')
  if (!msg) {
    el.hidden = true
    el.textContent = ''
  } else {
    el.hidden = false
    el.textContent = msg
  }
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
    const state = await bridge.ask({ type: 'get_state' })
    fillForm(state.config)
    setConfigError(state.configError || '')
    status.textContent = state.configured ? '' : '请填写本机路径并保存'
  } catch (err) {
    status.textContent = `未连接会话：${err.message}`
  }
  bridge.notifyResize(260)
}

document.getElementById('btn-save').addEventListener('click', async () => {
  disarmResetButton()
  const status = document.getElementById('save-status')
  status.textContent = '保存中…'
  try {
    const res = await bridge.ask({
      type: 'save_config',
      config: {
        pythonPath: document.getElementById('input-python').value.trim(),
        workerScript: document.getElementById('input-worker').value.trim(),
        daemonUrl: document.getElementById('input-daemon').value.trim(),
        defaultTimeoutMs: Number(document.getElementById('input-timeout').value) || 120000,
      },
    })
    fillForm(res.config)
    setConfigError('')
    status.textContent = '已保存'
  } catch (err) {
    status.textContent = `保存失败：${err.message}`
  }
  bridge.notifyResize(260)
})

document.getElementById('btn-reset').addEventListener('click', async () => {
  const btn = document.getElementById('btn-reset')
  const status = document.getElementById('save-status')

  // 二次确认防误触：首次点击仅进入武装态，5 秒内再次点击才真正清空配置
  if (!resetArmed) {
    resetArmed = true
    btn.textContent = '再次点击确认清空路径'
    btn.className = 'btn btn-danger'
    btn.setAttribute('aria-pressed', 'true')
    status.textContent = '将清空本地路径并恢复默认，5 秒内再次点击确认'
    resetArmTimer = setTimeout(() => {
      disarmResetButton()
      status.textContent = '已取消重置'
    }, 5000)
    bridge.notifyResize(260)
    return
  }

  disarmResetButton()
  status.textContent = '重置中…'
  try {
    const res = await bridge.ask({ type: 'reset_config', confirmed: true })
    fillForm(res.config)
    setConfigError('')
    status.textContent = '已恢复默认（路径已清空，请重新填写）'
  } catch (err) {
    status.textContent = `重置失败：${err.message}`
  }
  bridge.notifyResize(260)
})

bridge.ready(260)
