/**
 * tpi-bridge.js —— 三个沙箱视图共用的 TPI 2.0 postMessage 通信桥（消除 3 份重复副本 + ask() 超时兜底）。
 */

export function createTpiBridge({ onHello, onPush, defaultTimeoutMs = 15_000 } = {}) {
  let nextId = 1
  const pending = new Map()

  function notifyResize(minHeight = 160) {
    const height = Math.min(4000, Math.max(minHeight, document.body.scrollHeight + 12))
    parent.postMessage({ tpi: 'view', type: 'resize', height }, '*')
  }

  function ask(message, timeoutMs = defaultTimeoutMs) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error(`宿主响应超时（${Math.round(timeoutMs / 1000)}s），请确认会话已打开后重试`))
      }, timeoutMs)

      pending.set(id, {
        resolve(val) {
          clearTimeout(timer)
          resolve(val)
        },
        reject(err) {
          clearTimeout(timer)
          reject(err)
        },
      })
      parent.postMessage({ tpi: 'view', type: 'post', id, message }, '*')
    })
  }

  window.addEventListener('message', event => {
    const data = event.data
    if (!data || data.tpi !== 'host') return
    if (data.type === 'hello') {
      if (typeof onHello === 'function') onHello(data.context)
      return
    }
    if (data.type === 'push') {
      if (typeof onPush === 'function') onPush(data.message)
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

  function ready(minHeight = 160) {
    parent.postMessage({ tpi: 'view', type: 'ready' }, '*')
    notifyResize(minHeight)
  }

  return { ask, notifyResize, ready }
}
