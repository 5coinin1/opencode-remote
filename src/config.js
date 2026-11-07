import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'

// Nạp .env và GHI ĐÈ biến môi trường sẵn có (để .env luôn thắng).
// Ví dụ máy có thể set sẵn AGENT=1 toàn cục; ta không muốn nó đè cấu hình.
try {
  const envPath = path.resolve(process.cwd(), '.env')
  if (existsSync(envPath)) {
    const parsed = parseEnv(readFileSync(envPath, 'utf8'))
    for (const [k, v] of Object.entries(parsed)) process.env[k] = v
  }
} catch (e) {
  console.error('[config] không đọc được .env:', e.message)
}

function req(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`)
  return v
}

const generatePassword = () => randomBytes(24).toString('base64url')

const url = (process.env.OPENCODE_URL || '').trim().replace(/\/$/, '')
const spawn = url === ''

export const config = {
  discord: {
    token: req('DISCORD_TOKEN'),
    channelId: req('DISCORD_CHANNEL_ID'),
    allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  opencode: {
    spawn,
    url: url || `http://127.0.0.1:${Number(process.env.OPENCODE_PORT) || 4097}`,
    username: process.env.OPENCODE_USERNAME || 'opencode',
    password: process.env.OPENCODE_PASSWORD || generatePassword(),
    port: Number(process.env.OPENCODE_PORT) || 4097,
    bin: process.env.OPENCODE_BIN || 'opencode',
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    // Thư mục làm việc mặc định cho phiên mới do bridge tạo (trống = theo server cwd)
    workingDir: process.env.OPENCODE_DIR || '',
    // Bạn xác nhận TUI/desktop cũng trỏ vào server này (opencode --server <url>)
    // -> tắt cảnh báo "server riêng". Đặt 1/true khi đã cấu hình.
    shared: /^(1|true|yes|on)$/i.test(process.env.OPENCODE_SHARED || ''),
    // Tự dò "background service" mà TUI dùng mặc định và nối vào (dùng chung phiên).
    // Mặc định BẬT. Đặt 0 để tắt và luôn tự spawn server riêng.
    autoService: !/^(0|false|no|off)$/i.test(process.env.OPENCODE_AUTO_SERVICE || 'true'),
    serviceInfoPath:
      process.env.OPENCODE_SERVICE_FILE ||
      path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json'),
  },
  agent: process.env.OPENCODE_AGENT || 'build',
  // 'thread' (mặc định): output agent đổ vào thread riêng, lệnh ở kênh chính.
  // 'channel': quay lại hành vi cũ — output ngay trong kênh chính.
  outputMode: process.env.OUTPUT_MODE === 'channel' ? 'channel' : 'thread',
  mirror: {
    // Chỉ mirror phiên ngoài thuộc thư mục này (so khớp chuỗi con). Trống = mọi thư mục.
    dir: process.env.MIRROR_DIR || '',
    // Giới hạn số phiên ngoài được mirror (chống spam thread).
    max: Number(process.env.MIRROR_MAX) || 25,
  },
}

export function describeConfig() {
  const o = config.opencode
  const modeLabel =
    o.mode === 'service'
      ? `DÙNG CHUNG — tự dò server TUI (${o.url})`
      : o.mode === 'url'
        ? `KẾT NỐI (${o.url})`
        : `TỰ SPAWN server riêng (${o.bin} serve --port ${o.port})`
  return [
    `Discord channel : ${config.discord.channelId}`,
    `Allowlist users : ${config.discord.allowedUserIds.length ? config.discord.allowedUserIds.join(', ') : '(mọi người trong kênh)'}`,
    `OpenCode mode   : ${modeLabel}`,
    `Chia sẻ server  : ${o.shared ? 'CÓ (dùng chung phiên với TUI)' : 'không'}`,
    `Project dir     : ${o.projectDir}`,
    `Agent           : ${config.agent}`,
    `Output mode     : ${config.outputMode === 'channel' ? 'CHANNEL (output trong kênh chính)' : 'THREAD (output trong thread riêng)'}`,
    `Mirror dir      : ${config.mirror.dir || '(mọi thư mục)'}`,
  ].join('\n')
}
