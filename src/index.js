import { Client, GatewayIntentBits } from 'discord.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { config, describeConfig } from './config.js'
import { OpenCodeClient, spawnServer, portInUse, killServerTree, discoverService, startService } from './opencode.js'
import { DiscordBridge } from './discord-bridge.js'

let serverChild = null
const cleanup = () => killServerTree(serverChild)
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})

/**
 * Quyết định đối tượng server để bridge nói chuyện:
 *  1. OPENCODE_URL được đặt  -> kết nối tới đó.
 *  2. Tự dò background service (chính server TUI dùng) -> kết nối, dùng chung phiên.
 *  3. Không có gì            -> tự spawn server riêng.
 */
async function resolveServer() {
  const o = config.opencode
  if (!o.spawn) {
    return { mode: 'url', url: o.url, username: o.username, password: o.password, shared: o.shared }
  }
  if (o.autoService) {
    let svc = await discoverService(o.serviceInfoPath)
    if (!svc) {
      // Chưa có server dùng chung -> thử khởi động background service rồi dò lại.
      console.log('[opencode] chưa thấy server dùng chung, thử khởi động background service...')
      startService(o.bin)
      for (let i = 0; i < 24 && !svc; i++) {
        await sleep(500)
        svc = await discoverService(o.serviceInfoPath)
      }
    }
    if (svc) return { mode: 'service', url: svc.url, username: svc.username, password: svc.password, shared: true }
  }
  return { mode: 'spawn', url: o.url, username: o.username, password: o.password, shared: o.shared }
}

async function main() {
  const resolved = await resolveServer()

  // Áp dụng lựa chọn vào config để phần còn lại (bridge, describeConfig) dùng đúng.
  config.opencode.mode = resolved.mode
  config.opencode.url = resolved.url
  config.opencode.username = resolved.username
  config.opencode.password = resolved.password
  config.opencode.spawn = resolved.mode === 'spawn'
  config.opencode.shared = resolved.shared

  console.log('=== OpenCode Remote (Discord) ===')
  console.log(describeConfig())
  console.log('')

  if (resolved.mode === 'spawn') {
    if (await portInUse(config.opencode.port)) {
      throw new Error(
        `Cổng ${config.opencode.port} đang bị chiếm. Hãy đóng tiến trình đang dùng cổng này ` +
          `hoặc đổi OPENCODE_PORT trong .env.`,
      )
    }
    console.log(`[opencode] không thấy server dùng chung -> tự khởi động: ${config.opencode.bin} serve --port ${config.opencode.port}`)
    serverChild = spawnServer({
      bin: config.opencode.bin,
      port: config.opencode.port,
      username: config.opencode.username,
      password: config.opencode.password,
      cwd: config.opencode.projectDir,
    })
    console.warn(
      '⚠️  Đang chạy server RIÊNG. Phiên do TUI/desktop mở (server khác) sẽ không dùng chung được:\n' +
        '    `!use` phiên đó có thể ĐÈ/NGẮT phiên đang chạy, và mirror không thấy gì.\n' +
        '    (Bridge tự dò server dùng chung khi có; nếu TUI đang chạy mà vẫn thấy dòng này, kiểm tra OPENCODE_SERVICE_FILE.)\n',
    )
  } else if (resolved.mode === 'service') {
    console.log('[opencode] đã tìm thấy server TUI đang dùng -> KẾT NỐI (dùng chung phiên tự động).')
  } else {
    console.log('[opencode] kết nối tới OPENCODE_URL đã cấu hình.')
  }

  const oc = new OpenCodeClient({
    baseUrl: config.opencode.url,
    username: config.opencode.username,
    password: config.opencode.password,
  })

  await oc.waitReady(40_000)
  console.log(`[opencode] server sẵn sàng tại ${config.opencode.url}`)

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  const bridge = new DiscordBridge(client, oc, config)
  await bridge.start()

  const ac = new AbortController()
  oc.subscribe((ev) => bridge.onEvent(ev), { signal: ac.signal }).catch((e) => console.error('[sse]', e))
  console.log('[sse] đã đăng ký luồng sự kiện. Sẵn sàng!')
}

main().catch((e) => {
  console.error('\nLỗi khởi động:', e.message || e)
  cleanup()
  process.exit(1)
})
