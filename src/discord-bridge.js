import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} from 'discord.js'
import { chunk, formatCost, formatTokens, summarizeToolInput, truncate } from './format.js'

const STATE_FILE = path.resolve(process.cwd(), '.state.json')
const EDIT_INTERVAL_MS = 1200

export class DiscordBridge {
  /**
   * @param {import('discord.js').Client} client
   * @param {import('./opencode.js').OpenCodeClient} oc
   * @param {object} config
   */
  constructor(client, oc, config) {
    this.client = client
    this.oc = oc
    this.config = config
    /** @type {Map<string,string>} channelId -> sessionID */
    this.sessionByChannel = new Map()
    /** @type {Map<string,string>} sessionID -> channelId */
    this.channelBySession = new Map()
    /** @type {Map<string,object>} sessionID -> run state */
    this.runs = new Map()
    /** @type {Map<string,{channelId:string, sessionID:string}>} requestID -> info */
    this.pendingPermissions = new Map()
    /** @type {Map<string,Promise>} sessionID -> hàng đợi xử lý event */
    this.queues = new Map()
    // ----- Mirror phiên ngoài (mặc định tắt) -----
    this.mirrorEnabled = false
    /** @type {Map<string,{sessionID:string,threadId:string,title:string,dir:string}>} */
    this.mirrors = new Map()
    /** @type {Set<string>} các sessionID đã thử tạo mirror (tránh thử lại) */
    this.mirrorAttempted = new Set()
    /** @type {Map<string,string>} channelId -> thư mục làm việc mong muốn */
    this.dirByChannel = new Map()
    /** @type {Map<string,string>} sessionID -> threadId (nơi đổ output, khi OUTPUT_MODE=thread) */
    this.threadBySession = new Map()
    this.controlChannel = null
    this.loadState()
  }

  // ---------- persist ----------
  loadState() {
    try {
      if (existsSync(STATE_FILE)) {
        const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
        for (const [ch, sid] of Object.entries(data.sessions || {})) {
          this.sessionByChannel.set(ch, sid)
          this.channelBySession.set(sid, ch)
        }
        this.mirrorEnabled = Boolean(data.mirror?.enabled)
        for (const m of data.mirror?.sessions || []) {
          this.mirrors.set(m.sessionID, m)
          this.mirrorAttempted.add(m.sessionID)
        }
        for (const [ch, dir] of Object.entries(data.dirs || {})) this.dirByChannel.set(ch, dir)
      }
    } catch (e) {
      console.error('[state] không đọc được .state.json:', e.message)
    }
  }

  saveState() {
    try {
      writeFileSync(
        STATE_FILE,
        JSON.stringify(
          {
            sessions: Object.fromEntries(this.sessionByChannel),
            mirror: { enabled: this.mirrorEnabled, sessions: [...this.mirrors.values()] },
            dirs: Object.fromEntries(this.dirByChannel),
          },
          null,
          2,
        ),
      )
    } catch (e) {
      console.error('[state] không ghi được .state.json:', e.message)
    }
  }

  // ---------- lifecycle ----------
  async start() {
    this.client.once(Events.ClientReady, () => {
      console.log(`[discord] đăng nhập thành công: ${this.client.user.tag}`)
    })
    this.client.on(Events.MessageCreate, (m) => this.onMessage(m).catch((e) => console.error('[message]', e)))
    this.client.on(Events.InteractionCreate, (i) => this.onInteraction(i).catch((e) => console.error('[interaction]', e)))
    await this.client.login(this.config.discord.token)
    this.controlChannel = await this.client.channels.fetch(this.config.discord.channelId)
    if (!this.controlChannel) throw new Error(`Không tìm thấy kênh Discord: ${this.config.discord.channelId}`)
    console.log(`[discord] kênh điều khiển: #${this.controlChannel.name ?? this.controlChannel.id}`)
  }

  async stop() {
    try {
      await this.client.destroy()
    } catch {}
  }

  isAllowed(userId) {
    const list = this.config.discord.allowedUserIds
    return list.length === 0 || list.includes(userId)
  }

  // ---------- messages ----------
  async onMessage(message) {
    if (message.author.bot) return
    const controlId = this.config.discord.channelId
    const isControl = message.channelId === controlId
    const threadSession = this.sessionForThread(message.channelId)
    if (!isControl && !threadSession) return // không phải kênh chính, cũng không phải thread output
    if (!this.isAllowed(message.author.id)) {
      await message.reply('⛔ Bạn không nằm trong danh sách được phép.')
      return
    }
    const content = message.content.trim()
    if (!content) return

    if (content.startsWith('!')) {
      await this.handleCommand(message, content)
      return
    }

    // Nhập trong thread output -> gửi thẳng vào phiên của thread đó
    if (threadSession) await this.dispatchPrompt(threadSession, content)
    else await this.sendPrompt(message.channel, content)
  }

  async handleCommand(message, content) {
    const [cmd, ...rest] = content.slice(1).split(/\s+/)
    const arg = rest.join(' ')
    const ch = message.channel
    const controlId = this.config.discord.channelId
    const inControl = ch.id === controlId
    // Phiên hiện tại: theo kênh chính hoặc theo thread output
    const sid0 = this.sessionForChannel(ch.id)

    switch (cmd.toLowerCase()) {
      case 'help':
        await ch.send(
          [
            '**OpenCode Remote — lệnh**',
            '`!new` — reset phiên (phiên mới tạo khi bạn gửi tin tiếp theo)',
            '`!abort` — dừng phiên đang chạy',
            '`!cd <đường dẫn>` — đổi thư mục làm việc của phiên',
            '`!status` — phiên hiện tại + thư mục thật + thông tin server',
            '`!sessions` — liệt kê 20 phiên gần nhất',
            '`!use <sessionID>` — gắn vào một phiên có sẵn',
            '`!queue` — xem hàng đợi tin nhắn (kèm nút 🗑 huỷ)',
            '`!cancel <id>` — huỷ 1 tin đang chờ theo id',
            '`!sync [on|off]` — bật/tắt mirror phiên ngoài (TUI/CLI) vào thread riêng',
            '`!ping` — kiểm tra kết nối',
            '',
            'Bạn có thể nhập tin nhắn/lệnh **ngay trong thread output** hoặc ở kênh chính.',
            'Gửi tin nhắn thường (không bắt đầu bằng `!`) để hỏi agent.',
          ].join('\n'),
        )
        break
      case 'ping': {
        const t = Date.now()
        await this.oc.listSessions()
        await ch.send(`🏓 Pong — server OK (${Date.now() - t}ms)`)
        break
      }
      case 'new': {
        if (!inControl) return void (await ch.send('Lệnh `!new` chỉ dùng ở kênh chính.'))
        // Reset theo kiểu "lazy": không tạo phiên rỗng; phiên mới sinh khi gửi tin tiếp theo.
        const old = this.sessionByChannel.get(controlId)
        if (old) this.channelBySession.delete(old)
        this.sessionByChannel.delete(controlId)
        this.saveState()
        const dir = this.dirByChannel.get(controlId)
        await ch.send(
          '🆕 Đã reset. Phiên mới sẽ được tạo khi bạn gửi tin nhắn tiếp theo.' +
            (dir ? `\n📁 Thư mục: \`${dir}\`` : '') +
            '\n_(dùng `!cd <đường dẫn>` để đổi thư mục trước khi gửi)_',
        )
        break
      }
      case 'abort': {
        const sid = sid0
        if (!sid) return void (await ch.send('Chưa có phiên nào.'))
        try {
          await this.oc.interrupt(sid)
          await ch.send('🛑 Đã gửi lệnh dừng.')
        } catch (e) {
          await ch.send(`❌ Không dừng được: ${e.message}`)
        }
        break
      }
      case 'sessions': {
        const list = await this.oc.listSessions()
        const arr = Array.isArray(list) ? list : []
        const lines = arr.slice(0, 20).map((s) => `\`${s.id}\` — ${truncate(s.title || '(chưa có tiêu đề)', 60)}`)
        await ch.send(lines.length ? lines.join('\n') : 'Không có phiên nào.')
        break
      }
      case 'use': {
        if (!arg) return void (await ch.send('Dùng: `!use <sessionID>`'))
        if (!inControl) return void (await ch.send('Lệnh `!use` chỉ dùng ở kênh chính.'))
        this.bindSession(controlId, arg.trim())
        this.saveState()
        const warn =
          this.config.opencode.spawn && !this.config.opencode.shared
            ? '\n\n⚠️ Bridge đang chạy **server riêng** và chưa xác nhận dùng chung. Nếu phiên này do server khác (TUI/desktop) chạy, gửi prompt có thể **đè/ngắt** nó.\n→ Mở TUI bằng `opencode --server http://127.0.0.1:' +
              this.config.opencode.port +
              '` rồi đặt `OPENCODE_SHARED=1` trong .env.'
            : ''
        await ch.send(`🔗 Đã gắn vào phiên \`${arg.trim()}\`${warn}`)
        break
      }
      case 'status': {
        const sid = sid0
        let dir = this.dirByChannel.get(controlId) || this.config.opencode.workingDir || this.config.opencode.projectDir
        let title = '(sẽ tạo phiên khi bạn gửi tin tiếp theo)'
        if (sid) {
          try {
            const s = await this.oc.getSession(sid)
            dir = s?.location?.directory || dir
            title = s?.title || '(chưa có tiêu đề)'
          } catch (e) {
            title = `(không đọc được phiên: ${e.message})`
          }
        }
        await ch.send(
          [
            `Phiên hiện tại: ${sid ? `\`${sid}\`` : '(chưa có)'}`,
            `Tiêu đề: ${truncate(title, 80)}`,
            `📁 Thư mục làm việc: \`${dir}\``,
            `OpenCode: ${this.config.opencode.url}`,
            `Agent: ${this.config.agent}`,
          ].join('\n'),
        )
        break
      }
      case 'cd': {
        const p = arg.trim().replace(/^["']|["']$/g, '')
        if (!p) return void (await ch.send('Dùng: `!cd <đường dẫn tuyệt đối>`'))
        if (!existsSync(p)) return void (await ch.send(`❌ Không thấy thư mục: \`${p}\``))
        const sid = sid0
        try {
          if (sid) {
            await this.oc.moveSession(sid, p)
            const s = await this.oc.getSession(sid)
            const real = s?.location?.directory || p
            this.dirByChannel.set(controlId, real)
            await ch.send(`📁 Đã đổi thư mục phiên hiện tại: \`${real}\``)
          } else {
            this.dirByChannel.set(controlId, p)
            await ch.send(`📁 Đã đặt thư mục cho phiên mới: \`${p}\``)
          }
          this.saveState()
        } catch (e) {
          await ch.send(`❌ Không đổi được thư mục: ${e.message}`)
        }
        break
      }
      case 'queue': {
        const sid = sid0
        if (!sid) return void (await ch.send('Chưa có phiên.'))
        try {
          const items = (await this.oc.listInbox(sid)) || []
          if (!items.length) return void (await ch.send('📭 Hàng đợi trống.'))
          const shown = items.slice(0, 20)
          const lines = shown.map((it, i) => `${i + 1}. \`${it.id}\` — ${truncate(it.payload?.text ?? it.text ?? '', 70)}`)
          const rows = []
          for (const it of shown.slice(0, 5)) {
            const label = '🗑 ' + (truncate(it.payload?.text ?? it.id, 74) || it.id)
            rows.push(
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`cancel:${it.id}`).setLabel(label).setStyle(ButtonStyle.Danger),
              ),
            )
          }
          await ch.send({
            content: `📥 **Hàng đợi (${items.length})**\n${lines.join('\n')}\n\n_Bấm 🗑 để huỷ, hoặc dùng \`!cancel <id>\`._`,
            components: rows,
          })
        } catch (e) {
          await ch.send(`❌ ${e.message}`)
        }
        break
      }
      case 'cancel': {
        const id = arg.trim()
        const sid = sid0
        if (!sid) return void (await ch.send('Chưa có phiên.'))
        if (!id) return void (await ch.send('Dùng: `!cancel <inboxID>` (xem `!queue`)'))
        try {
          await this.oc.cancelInbox(sid, id)
          await ch.send(`🗑 Đã huỷ \`${id}\``)
        } catch (e) {
          await ch.send(`❌ Không huỷ được: ${e.message}`)
        }
        break
      }
      case 'sync': {
        const a = arg.trim().toLowerCase()
        if (a === 'on' || a === 'off') {
          this.mirrorEnabled = a === 'on'
          this.saveState()
          await ch.send(`🔁 Mirror phiên ngoài: **${this.mirrorEnabled ? 'BẬT' : 'TẮT'}**`)
        } else {
          await ch.send(
            `🔁 Mirror đang **${this.mirrorEnabled ? 'BẬT' : 'TẮT'}**.\nDùng \`!sync on\` / \`!sync off\`.\n` +
              `_(chỉ hoạt động khi bridge dùng chung server với TUI — xem README)_`,
          )
        }
        break
      }
      default:
        await ch.send(`Lệnh không rõ: \`!${cmd}\`. Gõ \`!help\`.`)
    }
  }

  bindSession(channelId, sessionID) {
    const old = this.sessionByChannel.get(channelId)
    if (old) this.channelBySession.delete(old)
    this.sessionByChannel.set(channelId, sessionID)
    this.channelBySession.set(sessionID, channelId)
  }

  async sendPrompt(channel, text) {
    const controlId = this.config.discord.channelId
    let sid = this.sessionByChannel.get(controlId)
    if (!sid) {
      const dir = this.dirByChannel.get(controlId) || this.config.opencode.workingDir || ''
      const body = dir ? { location: { directory: dir } } : {}
      const s = await this.oc.createSession(body)
      sid = s.id
      this.bindSession(controlId, sid)
      this.saveState()
    }
    await this.dispatchPrompt(sid, text)
  }

  /** Gửi prompt tới một phiên cụ thể (dùng chung cho kênh chính và thread output). */
  async dispatchPrompt(sid, text) {
    const controlId = this.config.discord.channelId
    this.channelBySession.set(sid, controlId) // event luôn route về kênh chính
    // Ở chế độ thread: tạo thread + ghi lại câu hỏi để thread đọc độc lập được
    if (this.config.outputMode !== 'channel') {
      try {
        const run = this.getRun(sid, controlId)
        const out = await this.outputOf(run)
        await out.send(`👤 ${truncate(text, 400)}`)
      } catch (e) {
        console.error('[prompt echo]', e.message)
      }
    }
    try {
      await this.oc.prompt(sid, text, { agent: this.config.agent })
    } catch (e) {
      try {
        const ch = await this.client.channels.fetch(controlId)
        await ch.send(`❌ Không gửi được prompt: ${e.message}`)
      } catch {}
    }
  }

  // ---------- run state ----------
  getRun(sessionID, channelId) {
    let run = this.runs.get(sessionID)
    if (!run) {
      run = {
        sessionID,
        channelId,
        activityMsg: null,
        activityLines: [],
        activityTimer: null,
        text: null,
      }
      this.runs.set(sessionID, run)
    }
    if (channelId) run.channelId = channelId
    return run
  }

  async channelOf(run) {
    return this.client.channels.fetch(run.channelId)
  }

  /** Kênh nhận output của run: kênh chính (channel mode) hoặc thread riêng (thread mode). */
  async outputOf(run) {
    if (this.config.outputMode === 'channel') return this.channelOf(run)
    return this.ensureOutputThread(run)
  }

  async ensureOutputThread(run) {
    const cached = this.threadBySession.get(run.sessionID)
    if (cached) {
      try {
        const t = await this.client.channels.fetch(cached)
        if (t) return t
      } catch {
        this.threadBySession.delete(run.sessionID)
      }
    }
    const ch = await this.channelOf(run)
    let name = run.sessionID
    try {
      const s = await this.oc.getSession(run.sessionID)
      if (s?.title) name = s.title
    } catch {}
    const thread = await ch.threads.create({
      name: truncate(name, 100) || run.sessionID,
      autoArchiveDuration: 10080,
      reason: 'Output phiên OpenCode',
    })
    this.threadBySession.set(run.sessionID, thread.id)
    await thread.send(`🧵 **Output phiên:** ${truncate(name, 120)}\n\`${run.sessionID}\``).catch(() => {})
    return thread
  }

  /** Tìm sessionID từ channel/thread id (dùng cho nút bấm). */
  sessionForChannel(channelId) {
    const direct = this.sessionByChannel.get(channelId)
    if (direct) return direct
    for (const [sid, tid] of this.threadBySession) if (tid === channelId) return sid
    return null
  }

  /** Nếu channelId là một thread output đã biết -> trả về sessionID tương ứng. */
  sessionForThread(channelId) {
    for (const [sid, tid] of this.threadBySession) if (tid === channelId) return sid
    return null
  }

  scheduleActivity(run) {
    if (run.activityTimer) return
    run.activityTimer = setTimeout(() => {
      run.activityTimer = null
      this.flushActivity(run).catch((e) => console.error('[activity]', e))
    }, EDIT_INTERVAL_MS)
  }

  async ensureActivity(run) {
    if (!run.activityMsg) {
      const ch = await this.outputOf(run)
      run.activityMsg = await ch.send('⏳ Đang xử lý…')
    }
    return run.activityMsg
  }

  async pushActivity(run, line) {
    run.activityLines.push(line)
    await this.ensureActivity(run)
    this.scheduleActivity(run)
  }

  async flushActivity(run) {
    if (!run.activityMsg || run.activityLines.length === 0) return
    const body = run.activityLines.slice(-25).join('\n')
    await run.activityMsg.edit(truncate(body, 1900)).catch(() => {})
  }

  // ---------- events ----------
  // Mọi event của một phiên được xử lý TUẦN TỰ để tránh race khi stream.
  enqueue(sessionID, fn) {
    const prev = this.queues.get(sessionID) ?? Promise.resolve()
    const next = prev.then(fn).catch((e) => console.error('[queue]', e))
    this.queues.set(sessionID, next)
    next.then(() => {
      if (this.queues.get(sessionID) === next) this.queues.delete(sessionID)
    })
  }

  onEvent(ev) {
    const d = ev.data
    const sid = d?.sessionID || ev.sessionID
    if (!sid) {
      if (ev.type === 'server.connected') console.log('[sse] server.connected')
      return
    }
    const channelId = this.channelBySession.get(sid)
    if (channelId) {
      this.enqueue(sid, () => this.handleEvent(ev, sid, channelId))
      return
    }
    // Phiên không do bridge quản lý -> mirror nếu được bật
    if (this.mirrorEnabled) {
      this.enqueue('mirror:' + sid, () => this.handleMirrorEvent(ev, sid))
    }
  }

  async handleEvent(ev, sid, channelId) {
    const d = ev.data || {}
    const run = this.getRun(sid, channelId)
    switch (ev.type) {
      case 'session.execution.started':
        await this.onExecutionStarted(run)
        break
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.error':
        await this.onExecutionEnded(run, ev)
        break
      case 'session.reasoning.started':
        run.activityLines.push('🧠 suy luận…')
        this.scheduleActivity(run)
        break
      case 'session.text.started':
        await this.startText(run, d)
        break
      case 'session.text.delta':
        await this.appendText(run, d.delta)
        break
      case 'session.text.ended':
        await this.endText(run, d.text)
        break
      case 'session.tool.input.started':
        await this.pushActivity(run, `🔧 gọi tool \`${d.name ?? '?'}\``)
        break
      case 'session.tool.called':
        await this.pushActivity(
          run,
          `┣ \`${d.name ?? d.tool ?? 'tool'}\` ${summarizeToolInput(d.input) ? '· ' + summarizeToolInput(d.input) : ''}`,
        )
        break
      case 'session.tool.success':
        await this.pushActivity(run, '┗ ✅ xong')
        break
      case 'session.tool.failure':
      case 'session.tool.error':
        await this.pushActivity(run, `┗ ❌ lỗi (${d.metadata?.status ?? 'error'})`)
        break
      case 'session.error':
        await this.pushActivity(run, `⚠️ lỗi phiên: ${truncate(d.message ?? JSON.stringify(d), 120)}`)
        break
      default:
        if (/permission/i.test(ev.type)) {
          await this.onPermission(run, d, ev).catch((e) => console.error('[permission]', e))
        } else if (/form/i.test(ev.type) && d?.formID) {
          await this.onForm(run, d).catch((e) => console.error('[form]', e))
        }
        break
    }
  }

  // ---------- mirror phiên ngoài (rút gọn: chỉ text) ----------
  async ensureMirror(sid, ev) {
    if (this.mirrors.has(sid)) return this.mirrors.get(sid)
    if (this.mirrorAttempted.has(sid)) return null
    this.mirrorAttempted.add(sid)
    if (!this.controlChannel) return null
    const mcfg = this.config.mirror || {}
    if (this.mirrors.size >= (mcfg.max ?? 25)) {
      console.warn(`[mirror] đã đạt giới hạn ${mcfg.max ?? 25} phiên, bỏ qua ${sid}`)
      return null
    }
    try {
      const s = await this.oc.getSession(sid)
      const dir = s?.location?.directory || ''
      if (mcfg.dir && !dir.toLowerCase().includes(String(mcfg.dir).toLowerCase())) return null
      const title = s?.title || sid
      const thread = await this.controlChannel.threads.create({
        name: truncate(title, 100) || sid,
        autoArchiveDuration: 1440,
        reason: 'Mirror phiên OpenCode',
      })
      const mirror = { sessionID: sid, threadId: thread.id, title, dir }
      this.mirrors.set(sid, mirror)
      this.saveState()
      await thread.send(`🧵 **Phiên ngoài:** ${title}\n📁 \`${dir || '(không rõ)'}\``)
      return mirror
    } catch (e) {
      console.error('[mirror] không tạo được thread:', e.message)
      return null
    }
  }

  async handleMirrorEvent(ev, sid) {
    const d = ev.data || {}
    const mirror = await this.ensureMirror(sid, ev)
    if (!mirror) return
    switch (ev.type) {
      case 'session.execution.started':
        await this.mirrorSend(mirror, '▶️ bắt đầu')
        break
      case 'session.text.ended':
        if (d.text) await this.mirrorSend(mirror, d.text)
        break
      case 'session.execution.succeeded':
        await this.mirrorSend(mirror, '✅ xong')
        break
      case 'session.execution.failed':
      case 'session.execution.error':
        await this.mirrorSend(mirror, '❌ kết thúc lỗi')
        break
      case 'session.error':
        await this.mirrorSend(mirror, `⚠️ ${truncate(d.message ?? JSON.stringify(d), 300)}`)
        break
      case 'session.renamed':
        if (d.title && mirror.title !== d.title) {
          mirror.title = d.title
          this.saveState()
          try {
            const th = await this.client.channels.fetch(mirror.threadId)
            await th.setName(truncate(d.title, 100))
          } catch {}
        }
        break
    }
  }

  async mirrorSend(mirror, text) {
    try {
      const thread = await this.client.channels.fetch(mirror.threadId)
      for (const part of chunk(text)) await thread.send(part)
    } catch (e) {
      console.error('[mirror] gửi lỗi:', e.message)
    }
  }

  async onExecutionStarted(run) {
    run.activityLines = ['⏳ Đang xử lý…']
    if (run.activityMsg) {
      await run.activityMsg.edit('⏳ Đang xử lý…').catch(() => {})
    } else {
      await this.ensureActivity(run)
    }
  }

  async onExecutionEnded(run, ev) {
    const d = ev.data || {}
    const ok = ev.type === 'session.execution.succeeded'
    const bits = []
    if (d.cost != null) bits.push(formatCost(d.cost))
    if (d.tokens) bits.push(formatTokens(d.tokens))
    run.activityLines.push(`${ok ? '✅ hoàn tất' : '❌ kết thúc lỗi'}${bits.length ? ' · ' + bits.join(' · ') : ''}`)
    await this.flushActivity(run)
    // dừng stream text nếu còn treo
    if (run.text?.timer) {
      clearTimeout(run.text.timer)
      run.text.timer = null
    }
    // activity giữ lại làm log; xoá text state
    run.text = null
  }

  // ---------- text streaming ----------
  async startText(run, d) {
    if (run.text && run.text.assistantMessageID !== d.assistantMessageID) {
      await this.endText(run, run.text.buf, true)
    }
    if (!run.text) {
      run.text = { assistantMessageID: d.assistantMessageID, msg: null, buf: '', timer: null }
    } else {
      run.text.assistantMessageID = d.assistantMessageID
    }
  }

  async appendText(run, delta) {
    if (!delta) return
    if (!run.text) run.text = { assistantMessageID: null, msg: null, buf: '', timer: null }
    run.text.buf += delta
    if (!run.text.msg) {
      const ch = await this.outputOf(run)
      run.text.msg = await ch.send(truncate(run.text.buf, 1900) || '…')
      return
    }
    if (run.text.timer) return
    run.text.timer = setTimeout(() => {
      run.text.timer = null
      this.flushText(run).catch(() => {})
    }, EDIT_INTERVAL_MS)
  }

  async flushText(run) {
    const t = run.text
    if (!t?.msg) return
    const tail = t.buf.length > 1900 ? '…' + t.buf.slice(-1899) : t.buf
    await t.msg.edit(tail).catch(() => {})
  }

  async endText(run, fullText, silent = false) {
    const t = run.text
    if (!t) return
    if (t.timer) {
      clearTimeout(t.timer)
      t.timer = null
    }
    const text = fullText ?? t.buf
    if (t.msg) {
      if (text.length <= 1900) {
        await t.msg.edit(text || '_(trống)_').catch(() => {})
      } else {
        // Xoá bản streaming rồi gửi đầy đủ theo chunk
        await t.msg.delete().catch(() => {})
        const ch = await this.outputOf(run)
        for (const part of chunk(text)) {
          await ch.send(part).catch(() => {})
        }
      }
    } else if (!silent && text) {
      const ch = await this.outputOf(run)
      for (const part of chunk(text)) await ch.send(part).catch(() => {})
    }
    run.text = null
  }

  // ---------- permissions / forms ----------
  async onPermission(run, d, ev) {
    const requestID = d?.requestID ?? d?.id
    console.log('[permission] event:', JSON.stringify(ev).slice(0, 300))
    if (!requestID) return
    this.pendingPermissions.set(requestID, { channelId: run.channelId, sessionID: run.sessionID })
    const ch = await this.outputOf(run)
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${requestID}`).setLabel('Cho phép').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${requestID}`).setLabel('Từ chối').setStyle(ButtonStyle.Danger),
    )
    const label = d?.permission ?? d?.tool ?? d?.name ?? 'hành động'
    await ch.send({ content: `🔐 Yêu cầu quyền: **${label}**`, components: [row] })
  }

  async onForm(run, d) {
    const ch = await this.outputOf(run)
    await ch.send(`❓ Agent đang hỏi: ${truncate(JSON.stringify(d.form ?? d), 500)}`)
  }

  async onInteraction(interaction) {
    if (!interaction.isButton()) return
    const [kind, ...rest] = interaction.customId.split(':')

    if (kind === 'perm') {
      const [action, requestID] = rest
      const info = this.pendingPermissions.get(requestID)
      if (!info) {
        await interaction.reply({ content: 'Yêu cầu này đã hết hạn.', ephemeral: true })
        return
      }
      try {
        await this.oc.replyPermission(info.sessionID, requestID, action)
        this.pendingPermissions.delete(requestID)
        await interaction.reply({ content: action === 'allow' ? '✅ Đã cho phép' : '⛔ Đã từ chối' })
      } catch (e) {
        await interaction.reply({ content: `❌ Lỗi: ${e.message}`, ephemeral: true })
      }
      return
    }

    if (kind === 'cancel') {
      const inboxID = rest.join(':')
      const sid = this.sessionForChannel(interaction.channelId)
      if (!sid) {
        await interaction.reply({ content: 'Không xác định được phiên của kênh này.', ephemeral: true })
        return
      }
      try {
        await this.oc.cancelInbox(sid, inboxID)
        await interaction.update({ content: `🗑 Đã huỷ tin đang chờ \`${inboxID}\`.`, components: [], embeds: [] })
      } catch (e) {
        await interaction.reply({ content: `❌ Không huỷ được: ${e.message}`, ephemeral: true })
      }
    }
  }
}
