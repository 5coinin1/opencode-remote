# opencode-remote

Điều khiển **OpenCode** từ xa qua **Discord**: gửi prompt từ Discord, xem agent suy luận / gọi tool / trả lời trực tiếp trên máy của bạn.

Bridge này nói chuyện trực tiếp với **OpenCode Server API** (`opencode serve`), không dùng Kimaki (vốn chỉ hỗ trợ OpenCode 1.x).

```
Discord  ──►  Bridge (bot này)  ──►  opencode serve  ──►  model/provider
   ▲                                    (API)                 │
   └────────────  SSE /api/event  ◄──────────────────────────┘
```

## Cài đặt nhanh (≈5 phút)

### 1) Yêu cầu

- **Node.js >= 20.12** (đã kiểm thử với Node 24)
- **OpenCode 2.x** trên PATH (`opencode --version`)
- Một **server Discord** + quyền tạo bot

### 2) Lấy code & cài dependency

```bash
git clone https://github.com/5coinin1/opencode-remote.git
cd opencode-remote
npm install
```

### 3) Tạo bot Discord

1. Vào https://discord.com/developers/applications → **New Application**.
2. Mục **Bot**:
   - Bật **MESSAGE CONTENT INTENT** (bắt buộc — bridge cần đọc nội dung tin nhắn), bấm **Save Changes**.
   - **Reset Token** → copy **Bot Token**.
3. Mời bot vào server — mở URL (thay `APP_ID` bằng Application ID):

   ```
   https://discord.com/api/oauth2/authorize?client_id=APP_ID&permissions=326417632320&scope=bot%20applications.commands
   ```

   `permissions=326417632320` = View Channels + Send Messages + Send Messages in Threads + Create Public Threads + Manage Threads + Read Message History + Add Reactions + Embed Links + Attach Files.

   > Đã mời bằng quyền cũ (thiếu Thread)? Mở lại URL này để cập nhật, **hoặc** vào Server Settings → Roles → vai trò bot → bật `Create Public Threads`, `Send Messages in Threads`, `Manage Threads`. Thiếu quyền này thì `OUTPUT_MODE=thread` sẽ lỗi.
4. Bật **Developer Mode** (Settings → Advanced) → chuột phải kênh muốn dùng → **Copy Channel ID**.

### 4) Cấu hình

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
```

Mở `.env`, điền **tối thiểu 2 dòng**:

```ini
DISCORD_TOKEN=<token bot>
DISCORD_CHANNEL_ID=<channel id>
```

Các biến còn lại để mặc định là chạy được:
- Bridge **tự dò server opencode đang chạy** (TUI/desktop) để dùng chung phiên; nếu không có thì tự spawn server riêng.
- `PROJECT_DIR` — thư mục agent làm việc (mặc định: thư mục hiện tại).
- `ALLOWED_USER_IDS` — chỉ những user ID này được điều khiển (khuyến nghị đặt).
- `OUTPUT_MODE` — `thread` (mặc định, output trong thread) hoặc `channel` (output trong kênh chính).

### 5) Chạy

```bash
npm start
```

Windows: có thể nháy đúp **`start-bot.cmd`**. Vào kênh đã cấu hình, gõ `!help`.

## Tự bật / tắt bot (không cần ai khác)

**Cách 1 — chạy thủ công (đơn giản nhất):**

```powershell
cd <đường-dẫn-tới-project>\opencode-remote
npm start
```

Hoặc nháy đúp **`start-bot.cmd`** trong thư mục project.
Dừng bot: bấm **Ctrl+C** trong cửa sổ đó (bridge sẽ tự kill `opencode serve` đi kèm).

**Cách 2 — tự chạy mỗi khi đăng nhập Windows:**

```powershell
cd <đường-dẫn-tới-project>\opencode-remote
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

- Chạy ngay: `Start-ScheduledTask -TaskName OpenCodeRemote`
- Dừng: `Stop-ScheduledTask -TaskName OpenCodeRemote`
- Gỡ tự chạy: `powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1`
- Log khi chạy nền: `bot.log` trong thư mục project.

**Lưu ý quan trọng:** chỉ chạy **một** instance. Bot chiếm cổng `OPENCODE_PORT` (mặc định 4097). Nếu cổng bận, bridge báo lỗi rõ ràng — hãy tắt instance cũ hoặc đổi `OPENCODE_PORT`.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| *(tin nhắn thường)* | Gửi prompt tới phiên hiện tại |
| `!new` | Reset phiên (phiên mới tạo khi gửi tin tiếp theo — không sinh phiên rỗng) |
| `!abort` | Dừng phiên đang chạy (`/interrupt`) |
| `!cd <đường dẫn>` | Đổi thư mục làm việc của phiên hiện tại (`/move`) |
| `!queue` | Xem hàng đợi tin nhắn, kèm nút 🗑 huỷ |
| `!cancel <inboxID>` | Huỷ một tin đang chờ theo id |
| `!sessions` | Liệt kê 20 phiên gần nhất |
| `!use <sessionID>` | Gắn vào một phiên có sẵn |
| `!status` | Phiên hiện tại + **thư mục làm việc thật** + thông tin server |
| `!sync [on\|off]` | Bật/tắt mirror phiên ngoài (TUI/CLI) vào thread riêng |
| `!ping` | Kiểm tra kết nối tới server |
| `!help` | Danh sách lệnh |

## Chế độ output: thread hay channel

Mặc định bridge đổ **output của agent** (hoạt động tool + câu trả lời) vào **một thread riêng** cho mỗi phiên; các **lệnh** (`!help`, `!queue`, `!status`…) vẫn nằm ở **kênh chính**. Nhờ vậy lệnh không chen vào giữa bài làm của agent.

```
#chung (kênh chính)         🧵 thread "Reverse ..." (output phiên)
  !use ses_abc               👤 câu hỏi của bạn
  !help                      ⏳ Đang xử lý…
  🔗 Đã gắn...               🔧 gọi tool shell
                             ✅ hoàn tất
                             <câu trả lời của agent>
```

- Khi gửi prompt, bridge ghi lại `👤 <câu hỏi>` vào thread để thread đọc độc lập được.
- Thread dùng cho cả hoạt động tool, câu trả lời, nút duyệt quyền và câu hỏi của agent.
- Nút 🗑 trong `!queue` vẫn hoạt động dù bấm trong thread.

**Quay về hành vi cũ** (output ngay trong kênh chính): sửa `.env`
```ini
OUTPUT_MODE=channel
```
rồi restart bot. (`thread` là mặc định.)

## Thư mục làm việc của phiên

Mỗi phiên opencode có `location.directory` riêng — đó là thư mục agent thực sự đọc/sửa file và chạy lệnh. Bridge đặt nó như sau:

1. Khi tạo phiên mới: dùng `OPENCODE_DIR` (nếu đặt), hoặc thư mục đã chọn bằng `!cd`, nếu không thì theo thư mục server (`PROJECT_DIR`).
2. Khi đã có phiên: `!cd <đường dẫn>` đổi thư mục của chính phiên đó (`POST /session/:id/move`).

`!status` luôn hiển thị **thư mục thật** của phiên (đọc từ `location.directory`), nên không bị "đứng" ở một giá trị cố định nữa.

Ví dụ: đổi sang repo khác trước khi làm việc —
```
!cd C:\đường\dẫn\repo-khác
!status
```

## Dùng chung phiên với TUI (tự động)

Bridge mặc định **tự dò server mà TUI/desktop đang dùng** và kết nối vào đó → **dùng chung phiên tự động**. Bạn chỉ cần bấm `start-bot`, không phải mở TUI bằng `--server` hay cấu hình gì thêm.

Thứ tự ưu tiên khi khởi động:
1. Nếu `.env` có `OPENCODE_URL` → kết nối tới URL đó.
2. Nếu không → đọc `~/.local/state/opencode/service.json` (thông tin server TUI dùng) và kết nối vào **đúng server đó**.
3. Nếu không tìm thấy → tự spawn server riêng (chế độ độc lập, chỉ điều khiển qua Discord).

Vì sao quan trọng: trạng thái "**đang bận**" và **hàng đợi** chỉ nằm trong bộ nhớ **của server đang chạy phiên**. Nếu bridge chạy server khác, nó **không biết** phiên đang bận → prompt gửi lên sẽ **đè/ngắt** phiên của TUI (đã kiểm chứng: prompt từ server B làm phiên chạy trên server A bị gián đoạn). Dùng chung server thì tin gửi lúc bận sẽ **xếp hàng đúng**.

Kiểm tra đang ở chế độ nào: xem log lúc khởi động (dòng `OpenCode mode`) hoặc gõ `!status`.

**Ép buộc chế độ (tuỳ chọn):**
- Luôn tự spawn server riêng: `OPENCODE_AUTO_SERVICE=0`.
- Chỉ định server thủ công: `OPENCODE_URL=http://127.0.0.1:4098` + `OPENCODE_PASSWORD=...`.
- (Nâng cao) Nếu buộc bridge tự spawn server riêng (`OPENCODE_AUTO_SERVICE=0`) và bạn tự trỏ TUI vào nó (`opencode --server http://127.0.0.1:<OPENCODE_PORT>`), đặt `OPENCODE_SHARED=1` để tắt cảnh báo.

> Không cần dùng chung nếu bạn chỉ điều khiển qua Discord (bridge tự tạo phiên riêng cho kênh). Khi đó đừng `!use` phiên của TUI.

## Mirror phiên ngoài (tuỳ chọn)

Tính năng phản chiếu các phiên opencode **bạn mở từ TUI/CLI** (không phải qua Discord) vào **thread riêng** trong kênh điều khiển — dạng **rút gọn**: chỉ text trả lời, bỏ qua delta/tool/reasoning. Mặc định **TẮT**, bật bằng `!sync on`.

Nội dung mỗi thread: tiêu đề phiên, `▶️ bắt đầu`, các đoạn text trả lời, `✅ xong`.

### ⚠️ Điều kiện bắt buộc: dùng chung MỘT server

Mặc định bridge **tự spawn server riêng** (cổng 4097). TUI của bạn lại dùng server khác → **bridge không thấy phiên của TUI**, nên mirror sẽ không có gì. Muốn mirror hoạt động, cả hai phải trỏ vào **cùng một server**:

```powershell
# 1) Chạy 1 server cố định (đặt mật khẩu để biết trước)
$env:OPENCODE_SERVER_PASSWORD = "matkhau-manh"
opencode serve --hostname 127.0.0.1 --port 4098

# 2) Sửa .env cho bridge KẾT NỐI vào server đó (bỏ trống đề bridge tự spawn)
#    OPENCODE_URL=http://127.0.0.1:4098
#    OPENCODE_PASSWORD=matkhau-manh

# 3) Chạy TUI trỏ vào cùng server
opencode --server http://127.0.0.1:4098

# 4) Chạy bridge rồi bật mirror trong Discord
npm start        # (cửa sổ khác)
#   -> trong kênh: !sync on
```

Từ đó, mỗi phiên bạn bắt đầu trong TUI sẽ xuất hiện thành một thread trong kênh.

### Giảm ồn / hiệu năng

- **Không tốn thêm** ở phía opencode: server vốn đã phát event ra `/api/event` sẵn.
- Tốn thực nằm ở phía Discord (rate limit khi sửa tin). Vì vậy bản mirror này **chỉ gửi text một lần khi mỗi đoạn trả lời xong**, không stream từng ký tự, không log từng dòng tool.
- Lọc theo thư mục: `MIRROR_DIR=C:\đường\dẫn\project` (so khớp chuỗi con; trống = mọi thư mục).
- Giới hạn số thread: `MIRROR_MAX=25` (mặc định).
- Tắt khi cần yên tĩnh: `!sync off`. Trạng thái được lưu qua các lần khởi động lại.

## Cách hoạt động (API)

| Việc | Endpoint |
|---|---|
| Tạo phiên | `POST /api/session` → `{ data: { id } }` |
| Gửi prompt | `POST /api/session/:id/prompt` `{ text }` |
| Dừng | `POST /api/session/:id/interrupt` |
| Đọc tin nhắn | `GET /api/session/:id/message` |
| Xoá phiên | `DELETE /api/session/:id` |
| Duyệt quyền | `POST /api/session/:id/permission/:requestID/reply` `{ response }` |
| Luồng sự kiện | `GET /api/event` (SSE) |

Event SSE dùng để stream: `session.text.delta` / `.ended` (câu trả lời), `session.tool.called` / `.success` (hoạt động tool), `session.execution.started/succeeded` (trạng thái), `session.usage.updated` (chi phí/token).

## Bảo mật

- Bot **chạy lệnh trên máy bạn**. Chỉ để trong server riêng, và nên đặt `ALLOWED_USER_IDS`.
- Server OpenCode tự sinh **Basic auth** (username `opencode`). Ở chế độ tự spawn, bridge tự đặt mật khẩu và bind `127.0.0.1` — không lộ ra LAN.
- Nếu chạy ở chế độ kết nối ra ngoài (tunnel/LAN), **luôn đặt `OPENCODE_SERVER_PASSWORD` mạnh**.

## Xử lý sự cố

- `OpenCode server không sẵn sàng` → kiểm tra `opencode serve` có chạy không, hoặc cổng `OPENCODE_PORT` bị chiếm.
- Bot không trả lời → đã bật **MESSAGE CONTENT INTENT** chưa? Đúng `DISCORD_CHANNEL_ID` chưa?
- Không thấy hoạt động tool → xem log ở terminal; mọi event lạ được in ra để bạn tinh chỉnh.
- Không tạo được thread / không gửi được trong thread → cấp quyền **Threads** cho bot (xem Bước 1).
- Log toàn bộ event: thêm tạm `console.log(ev.type, JSON.stringify(ev.data))` trong `src/discord-bridge.js` → `onEvent`.

## Giới hạn / hướng mở rộng

- Phiên điều khiển: 1 kênh = 1 phiên (dùng `!new` để đổi). Phiên **ngoài** (TUI/CLI) có thể mirror vào **thread riêng** — xem mục "Mirror phiên ngoài".
- Chưa hỗ trợ đính kèm ảnh/file, đổi model/agent bằng lệnh, và trả lời câu hỏi dạng form (`/session/:id/form/:formID/reply`) — đã đặt sẵn hook trong code.
- Xử lý permission đã có sẵn khung (nút Cho phép/Từ chối); giá trị `response` (`allow`/`deny`) có thể cần chỉnh tuỳ phiên bản OpenCode.
