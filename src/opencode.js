import { spawn } from 'node:child_process'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/** Client cho OpenCode Server API (base path: /api). */
export class OpenCodeClient {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.api = `${this.baseUrl}/api`
    this.auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
  }

  async req(path, { method = 'GET', body } = {}) {
    const res = await fetch(this.api + path, {
      method,
      headers: { authorization: this.auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const raw = await res.text()
    let json = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {
      json = raw
    }
    if (!res.ok) {
      const msg = (json && (json.message || json.error)) || raw || res.statusText
      throw new Error(`OpenCode ${method} ${path} -> ${res.status}: ${msg}`)
    }
    return json
  }

  async waitReady(timeoutMs = 30_000) {
    const start = Date.now()
    let lastErr
    while (Date.now() - start < timeoutMs) {
      try {
        await this.req('/session')
        return true
      } catch (e) {
        lastErr = e
        await sleep(500)
      }
    }
    throw new Error(`OpenCode server không sẵn sàng: ${lastErr?.message}`)
  }

  // ---- Sessions ----
  createSession(body = {}) {
    return this.req('/session', { method: 'POST', body }).then((r) => r?.data ?? r)
  }
  listSessions() {
    return this.req('/session').then((r) => r?.data ?? r)
  }
  getSession(id) {
    return this.req(`/session/${id}`).then((r) => r?.data ?? r)
  }
  moveSession(id, directory) {
    return this.req(`/session/${id}/move`, { method: 'POST', body: { directory } }).then((r) => r?.data ?? r)
  }
  listInbox(id) {
    return this.req(`/session/${id}/inbox`).then((r) => r?.data ?? r)
  }
  cancelInbox(id, inboxID) {
    return this.req(`/session/${id}/inbox/${inboxID}`, { method: 'DELETE' })
  }

  // ---- Prompt / control ----
  prompt(id, text, extra = {}) {
    return this.req(`/session/${id}/prompt`, { method: 'POST', body: { text, ...extra } })
  }
  interrupt(id) {
    return this.req(`/session/${id}/interrupt`, { method: 'POST', body: {} })
  }

  // ---- Permissions ----
  replyPermission(id, requestID, response) {
    return this.req(`/session/${id}/permission/${requestID}/reply`, {
      method: 'POST',
      body: { response },
    })
  }

  /**
   * Đăng ký luồng sự kiện SSE (/api/event) và tự kết nối lại.
   * onEvent(ev) được gọi cho mỗi event JSON.
   */
  async subscribe(onEvent, { signal } = {}) {
    let backoff = 500
    while (!signal?.aborted) {
      try {
        const res = await fetch(`${this.api}/event`, {
          headers: { authorization: this.auth },
          signal,
        })
        if (!res.ok || !res.body) throw new Error(`event stream status ${res.status}`)
        backoff = 500
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const chunks = buf.split('\n\n')
          buf = chunks.pop() ?? ''
          for (const chunk of chunks) {
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n')
            if (!data) continue
            let ev
            try {
              ev = JSON.parse(data)
            } catch {
              continue
            }
            try {
              onEvent(ev)
            } catch (e) {
              console.error('[event] handler lỗi:', e)
            }
          }
        }
      } catch (e) {
        if (signal?.aborted) return
        console.error(`[sse] mất kết nối (${e.message}); thử lại sau ${backoff}ms`)
      }
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 10_000)
    }
  }
}

/**
 * Đọc server "background service" mà TUI/desktop dùng mặc định, để bridge
 * tự động KẾT NỐI vào cùng server đó (dùng chung phiên, không cần --server).
 * Trả về { url, username, password } nếu tìm thấy và kết nối được, ngược lại null.
 */
export async function discoverService(infoPath) {
  try {
    if (!infoPath || !existsSync(infoPath)) return null
    const info = JSON.parse(readFileSync(infoPath, 'utf8'))
    if (!info?.url) return null
    const url = String(info.url).replace(/\/$/, '')
    const auth = 'Basic ' + Buffer.from(`opencode:${info.password}`).toString('base64')
    const res = await fetch(`${url}/api/session`, { headers: { authorization: auth } })
    if (!res.ok) return null
    return { url, username: 'opencode', password: info.password, pid: info.pid }
  } catch {
    return null
  }
}

/** Khởi động background service của opencode (nếu chưa chạy). */
export function startService(bin) {
  try {
    const r = spawnSync(`${bin} service start`, { stdio: 'ignore', shell: true, timeout: 30_000 })
    return r.status === 0
  } catch {
    return false
  }
}

/** Spawn `opencode serve` và trả về child process. */
export function spawnServer({ bin, port, username, password, cwd }) {
  const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)]
  const env = {
    ...process.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  }
  // Windows: opencode là một .cmd -> phải chạy qua shell, truyền 1 chuỗi lệnh
  // (tránh cảnh báo DEP0190 khi truyền mảng args kèm shell: true).
  const isWin = process.platform === 'win32'
  const child = isWin
    ? spawn(`${bin} ${args.join(' ')}`, { cwd, env, stdio: 'inherit', shell: true })
    : spawn(bin, args, { cwd, env, stdio: 'inherit' })
  child.on('exit', (code, sig) => {
    console.error(`[opencode serve] đã thoát (code=${code}, signal=${sig})`)
  })
  return child
}

/** Kiểm tra một cổng TCP đã có tiến trình lắng nghe chưa. */
export function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host })
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })
}

/** Dừng server đã spawn, giết cả cây tiến trình (Windows cần taskkill /T). */
export function killServerTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  } catch {}
}
