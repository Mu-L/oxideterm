<p align="center">
  <img src="../../src-tauri/icons/icon.ico" alt="OxideTerm" width="128" height="128">
</p>

<h1 align="center">⚡ OxideTerm</h1>

<p align="center">
  <strong>Công Cụ Terminal Chạy Bằng Rust — Vượt Xa SSH</strong>
  <br>
  <em>Hơn 130.000 dòng mã Rust &amp; TypeScript. Không Electron. Không phụ thuộc C trong ngăn xếp SSH.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.19.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blueviolet" alt="License">
  <img src="https://img.shields.io/badge/rust-1.75+-orange" alt="Rust">
  <img src="https://img.shields.io/badge/tauri-2.0-purple" alt="Tauri">
</p>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-Hant.md">繁體中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.fr.md">Français</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

---

## OxideTerm là gì?

OxideTerm là một **ứng dụng terminal đa nền tảng** kết hợp shell cục bộ, phiên SSH từ xa, quản lý tệp, chỉnh sửa mã nguồn và hỗ trợ AI vào một tệp nhị phân gốc duy nhất được viết bằng Rust. Đây **không** phải là một wrapper Electron — toàn bộ backend được viết bằng Rust, đóng gói thành tệp thực thi gốc chỉ 20-35 MB thông qua Tauri 2.0.

### Tại sao lại cần thêm một Terminal?

| Vấn đề | Giải pháp của OxideTerm |
|---|---|
| Các SSH client không hỗ trợ shell cục bộ | Cơ chế lai: PTY cục bộ + SSH từ xa trong cùng một cửa sổ |
| Kết nối lại = mất hết mọi thứ | **Kiến trúc Node-first**: tự động kết nối lại với Grace Period bảo toàn ứng dụng TUI; khôi phục chuyển tiếp cổng, truyền tải, trạng thái IDE |
| Chỉnh sửa tệp từ xa cần VS Code Remote | **Chế độ IDE tích hợp**: trình soạn thảo CodeMirror 6 qua SFTP, mặc định không cần cài đặt trên máy chủ; hỗ trợ tùy chọn agent từ xa trên Linux |
| Không tái sử dụng kết nối SSH | **SSH multiplexing**: terminal, SFTP, chuyển tiếp cổng dùng chung một kết nối |
| Thư viện SSH phụ thuộc OpenSSL | **russh 0.54**: SSH thuần Rust, backend mã hóa `ring`, không phụ thuộc C |

---

## Tổng quan Kiến trúc

```
┌─────────────────────────────────────┐
│        Frontend (React 19)          │
│                                     │
│  SessionTreeStore ──► AppStore      │    16 Zustand stores
│  IdeStore    LocalTerminalStore     │    20 thư mục components
│  ReconnectOrchestratorStore         │    11 ngôn ngữ × 21 namespaces
│  PluginStore  AiChatStore  ...      │
│                                     │
│        xterm.js 6 + WebGL           │
└──────────┬──────────────┬───────────┘
           │ Tauri IPC    │ WebSocket (binary)
┌──────────▼──────────────▼───────────┐
│         Backend (Rust)              │
│                                     │
│  NodeRouter ── resolve(nodeId) ──►  │    24 module lệnh IPC
│  ├─ SshConnectionRegistry          │    DashMap trạng thái đồng thời
│  ├─ SessionRegistry                │    PTY cục bộ gắn feature gate
│  ├─ ForwardingManager              │    Kho bảo mật ChaCha20-Poly1305
│  ├─ SftpSession (connection-level) │    russh 0.54 (ring backend)
│  └─ LocalTerminalRegistry          │    SSH Agent (AgentSigner)
│                                     │
│  Wire Protocol v1                   │
│  [Type:1][Length:4][Payload:n]       │
└─────────────────────────────────────┘
```

**Giao tiếp hai mặt phẳng**: WebSocket binary frames cho I/O terminal (không có chi phí serialization), Tauri IPC cho lệnh cấu trúc và sự kiện. Frontend không bao giờ chạm đến `sessionId` hay `connectionId` — mọi thứ đều được định danh bằng `nodeId`, giải quyết phía server bởi `NodeRouter`.

---

## Điểm nổi bật về Kỹ thuật

### 🔩 SSH thuần Rust — russh 0.54

OxideTerm sử dụng **russh 0.54** biên dịch với backend mã hóa `ring`:
- **Không phụ thuộc C/OpenSSL** trong đường dẫn SSH — toàn bộ ngăn xếp mã hóa là Rust
- Giao thức SSH2 đầy đủ: trao đổi khóa, kênh, hệ thống con SFTP, chuyển tiếp cổng
- Bộ mã hóa ChaCha20-Poly1305 và AES-GCM, khóa Ed25519/RSA/ECDSA

### 🔑 Xác thực SSH Agent (AgentSigner)

`AgentSigner` tùy chỉnh bọc SSH Agent hệ thống và triển khai trait `Signer` của russh:

```rust
// Solves the RPITIT Send bound issue in russh 0.54
// by cloning &PublicKey to an owned value before crossing .await
pub struct AgentSigner { /* ... */ }
impl Signer for AgentSigner { /* challenge-response via Agent IPC */ }
```

- **Nền tảng**: Unix (`SSH_AUTH_SOCK`), Windows (`\\.\pipe\openssh-ssh-agent`)
- **Chuỗi proxy**: mỗi bước nhảy có thể độc lập sử dụng xác thực Agent
- **Kết nối lại**: `AuthMethod::Agent` được phát lại tự động khi kết nối lại

### 🧭 Kiến trúc Node-First (NodeRouter)

**Hệ thống trừu tượng hóa Node Oxide-Next** loại bỏ hoàn toàn một lớp race conditions:

```
Frontend: useNodeState(nodeId) → { readiness, sftpReady, error }
Backend:  NodeRouter.resolve(nodeId) → ConnectionEntry → SftpSession
```

- Các thao tác SFTP/IDE phía Frontend chỉ truyền `nodeId` — không có `sessionId`, không có `connectionId`
- Backend giải quyết `nodeId → ConnectionEntry` một cách nguyên tử
- Khi SSH kết nối lại thay đổi `connectionId` — SFTP/IDE **không bị ảnh hưởng**
- `NodeEventEmitter` đẩy sự kiện có kiểu kèm bộ đếm thế hệ để sắp xếp thứ tự

### ⚙️ Terminal cục bộ — PTY an toàn luồng

Shell cục bộ đa nền tảng qua `portable-pty 0.8`, được gắn feature gate `local-terminal`:

- **An toàn luồng**: `MasterPty` được bọc trong `std::sync::Mutex` với `unsafe impl Sync`
- **Luồng I/O chuyên dụng**: thao tác đọc PTY chặn không bao giờ chạm vào vòng lặp sự kiện Tokio
- **Phát hiện shell**: tự động tìm `zsh`, `bash`, `fish`, `pwsh`, Git Bash, WSL2
- **Feature gate**: `cargo build --no-default-features` loại bỏ PTY cho bản build di động

### 🔌 Hệ thống Plugin động (v1.6.2+)

Tải plugin động với API được đóng băng và bảo mật:

- **PluginContext API**: 8 namespaces (terminal, ui, commands, settings, lifecycle, events, storage, system)
- **24 thành phần UI Kit**: các React components dựng sẵn được inject vào sandbox plugin
- **Mô hình bảo mật**: `Object.freeze` + Proxy ACL, circuit breaker, IPC whitelist
- **Kiến trúc membrane**: plugin chạy trong ngữ cảnh ESM cách ly với cầu nối được kiểm soát đến host

### 🛡️ SSH Connection Pool

`SshConnectionRegistry` có đếm tham chiếu với DashMap:

- Nhiều terminal, SFTP, chuyển tiếp cổng dùng chung **một kết nối SSH vật lý**
- Máy trạng thái độc lập cho mỗi kết nối (connecting → active → idle → link_down → reconnecting)
- Thời gian chờ nhàn rỗi (30 phút), keep-alive (15 giây), phát hiện lỗi heartbeat
- WsBridge heartbeat cục bộ: chu kỳ 30 giây, thời gian chờ 5 phút (chịu được App Nap)
- Ngắt kết nối khi hết thời gian nhàn rỗi phát sự kiện `connection_status_changed` để thông báo frontend
- Lan truyền cascade: jump host gặp sự cố → tất cả node hạ nguồn được đánh dấu `link_down`
- **Phát hiện thông minh**: `visibilitychange` + sự kiện `online` → thăm dò SSH chủ động (~2 giây so với 15-30 giây thụ động)
- **Grace Period**: cửa sổ 30 giây để khôi phục kết nối hiện tại trước khi kết nối lại phá hủy (bảo toàn ứng dụng TUI như yazi/vim)

### 🔀 Chuyển tiếp cổng — I/O không khóa

Chuyển tiếp cổng đầy đủ: local (-L), remote (-R), và dynamic SOCKS5 (-D):

- **Kiến trúc truyền thông điệp**: SSH Channel được sở hữu bởi một task `ssh_io` duy nhất, không dùng `Arc<Mutex<Channel>>`
- **Báo cáo kết thúc**: task chuyển tiếp chủ động báo cáo lý do kết thúc khi SSH ngắt kết nối
- **Tự động khôi phục**: các chuyển tiếp `Suspended` được tiếp tục khi kết nối lại
- **Thời gian chờ nhàn rỗi**: `FORWARD_IDLE_TIMEOUT` (300 giây) ngăn kết nối zombie

### 🤖 Trợ lý AI cho Terminal

AI chế độ kép với thiết kế ưu tiên quyền riêng tư:

- **Bảng nội tuyến** (`⌘I`): lệnh nhanh, inject qua bracketed paste
- **Chat bên lề**: hội thoại liên tục với lịch sử
- **Bắt ngữ cảnh**: Terminal Registry thu thập buffer từ panel đang hoạt động hoặc tất cả panel chia
- **Ngữ cảnh đa nguồn**: tự động inject tệp IDE, đường dẫn SFTP, và trạng thái Git vào hội thoại AI
- **Sử dụng công cụ**: 40+ công cụ tích hợp (thao tác tệp, quản lý tiến trình, mạng, tương tác TUI) mà AI có thể tự động gọi
- **Hỗ trợ MCP**: kết nối các server [Model Context Protocol](https://modelcontextprotocol.io) bên ngoài (stdio & SSE) để mở rộng AI với công cụ bên thứ ba — quản lý trong Settings
- **Tương thích**: OpenAI, Ollama, DeepSeek, OneAPI, mọi endpoint `/v1/chat/completions`
- **Bảo mật**: API keys trong OS keychain (macOS Keychain / Windows Credential Manager); trên macOS, thao tác đọc được bảo vệ bằng **Touch ID** qua `LAContext` — không cần entitlements hay code-signing

### 💻 Chế độ IDE — Chỉnh sửa từ xa

Trình soạn thảo CodeMirror 6 qua SFTP — mặc định không cần cài đặt phía server; Linux hỗ trợ tùy chọn agent từ xa nhẹ để nâng cao khả năng:

- **Cây tệp**: tải lười với chỉ báo trạng thái Git
- **30+ chế độ ngôn ngữ**: 16 CodeMirror gốc + các chế độ kế thừa
- **Giải quyết xung đột**: khóa mtime lạc quan
- **Git hướng sự kiện**: tự động làm mới khi lưu, tạo, xóa, đổi tên, nhấn Enter trong terminal
- **State Gating**: I/O bị chặn khi `readiness !== 'ready'`, Key-Driven Reset khi kết nối lại
- **Agent từ xa Linux (tùy chọn)**: tệp nhị phân Rust ~1 MB, tự động triển khai trên x86_64/aarch64. Kiến trúc bổ sung (ARMv7, RISC-V64, LoongArch64, s390x, v.v.) có sẵn trong `agents/extra/` để tải lên thủ công

### 🔐 Xuất mã hóa .oxide

Định dạng sao lưu kết nối di động:

- **ChaCha20-Poly1305 AEAD** mã hóa có xác thực
- **Argon2id KDF** (256 MB bộ nhớ, 4 vòng lặp) — chống brute-force GPU
- **SHA-256** kiểm tra tính toàn vẹn
- **Nhúng khóa tùy chọn**: khóa riêng base64 được mã hóa vào payload đã mã hóa
- **Phân tích trước khi xuất**: phân loại phương thức xác thực, phát hiện khóa bị thiếu

### 📡 ProxyJump — Multi-Hop nhận biết topo mạng

- Độ sâu chuỗi không giới hạn: `Client → Jump A → Jump B → … → Target`
- Tự động phân tích SSH Config, xây dựng đồ thị topo, tính toán đường đi Dijkstra
- Các node nhảy có thể tái sử dụng như phiên độc lập
- Lan truyền lỗi cascade với đồng bộ trạng thái hạ nguồn tự động

### 📊 Profiler tài nguyên

Giám sát trực tiếp host từ xa qua kênh shell SSH liên tục:

- Đọc `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/net/dev`
- Tính toán CPU% và thông lượng mạng dựa trên delta
- Dùng một kênh duy nhất — tránh cạn kiệt MaxSessions
- Tự động giảm cấp về chỉ RTT khi không phải Linux hoặc liên tiếp thất bại

### 🖼️ Bộ sưu tập ảnh nền

Hệ thống nền đa ảnh với điều khiển độ trong suốt theo từng tab:

- **Quản lý gallery**: tải lên nhiều ảnh, nhấn thumbnail để chuyển, xóa từng ảnh hoặc xóa hàng loạt
- **Công tắc chính**: bật/tắt nền toàn cục mà không xóa ảnh
- **Điều khiển theo tab**: 13 loại tab có thể bật/tắt riêng (terminal, SFTP, IDE, settings, topology, v.v.)
- **Tùy chỉnh**: độ mờ (3–50%), blur (0–20px), chế độ hiển thị (cover/contain/fill/tile)
- **Nhận biết nền tảng**: hỗ trợ trong suốt macOS; loại trừ đường dẫn WSLg trên Windows (canvas VNC không trong suốt)
- **Bảo mật**: xóa đã chuẩn hóa đường dẫn để ngăn directory traversal; truyền lỗi đầy đủ từ backend Rust

### 🏎️ Kết xuất thích ứng — Tốc độ làm mới động

Bộ lập lịch kết xuất ba tầng thay thế batching RAF cố định, cải thiện khả năng phản hồi khi xuất dữ liệu nặng và giảm tải GPU/pin khi nhàn rỗi:

| Tầng | Kích hoạt | Tốc độ hiệu dụng | Lợi ích |
|---|---|---|---|
| **Boost** | Dữ liệu frame ≥ 4 KB | 120 Hz+ (RAF / ProMotion gốc) | Loại bỏ lag cuộn khi xuất nhanh |
| **Normal** | Gõ phím thường / I/O nhẹ | 60 Hz (RAF) | Tương tác mượt mà cơ bản |
| **Idle** | 3 giây không I/O, trang ẩn, hoặc cửa sổ mất focus | 1–15 Hz (timer, tăng theo hàm mũ) | Gần như không tải GPU, tiết kiệm pin |

- **Chế độ tự động**: chuyển đổi dựa trên khối lượng dữ liệu, đầu vào người dùng, và Page Visibility API — không cần điều chỉnh thủ công
- **An toàn khi chạy nền**: khi tab bị ẩn, dữ liệu từ xa tiếp tục được xả qua idle timer — RAF không bao giờ bị đánh thức, ngăn tích tụ buffer trên tab chạy nền
- **Cài đặt**: ba chế độ (Auto / Luôn 60 Hz / Tắt) trong Settings → Terminal → Renderer
- **Chẩn đoán trực tiếp**: bật **Show FPS Overlay** để xem huy hiệu tầng thời gian thực (`B`=boost · `N`=normal · `I`=idle), tốc độ frame, và bộ đếm ghi/giây nổi ở góc terminal

### 🎨 Công cụ tùy chỉnh giao diện

Tùy chỉnh giao diện chuyên sâu vượt xa các bảng màu có sẵn:

- **30+ giao diện tích hợp**: Oxide, Dracula, Nord, Catppuccin, Spring Rice, Tokyo Night, và nhiều hơn nữa
- **Trình chỉnh sửa giao diện tùy chỉnh**: bộ chọn màu trực quan + nhập hex RGB cho mọi trường
- **Màu terminal**: tất cả 22 trường xterm.js (nền, chữ, con trỏ, vùng chọn, 16 màu ANSI)
- **Màu giao diện UI**: 19 biến CSS trên 5 danh mục — Nền (5), Văn bản (3), Đường viền (3), Nhấn (4), Màu trạng thái ngữ nghĩa (4)
- **Tự động tạo**: tạo màu UI từ bảng màu terminal chỉ với một cú nhấp
- **Xem trước trực tiếp**: terminal thu nhỏ thời gian thực + xem trước giao diện UI khi chỉnh sửa
- **Nhân bản & mở rộng**: tạo giao diện mới bằng cách nhân bản bất kỳ giao diện tích hợp hoặc tùy chỉnh nào
- **Lưu trữ lâu dài**: giao diện tùy chỉnh được lưu vào localStorage, tồn tại qua các bản cập nhật

### 🪟 Tối ưu hóa chuyên sâu cho Windows

- **Tích hợp ConPTY gốc**: gọi trực tiếp API Windows Pseudo Console (ConPTY) để hỗ trợ hoàn hảo TrueColor và chuỗi thoát ANSI — không dùng WinPTY lỗi thời.
- **Phát hiện Shell thông minh**: bộ quét tích hợp tự động phát hiện **PowerShell 7 (pwsh)**, **Git Bash**, **WSL2**, và CMD kế thừa qua Registry và PATH.
- **Trải nghiệm gốc**: Rust xử lý trực tiếp sự kiện cửa sổ — tốc độ phản hồi vượt xa ứng dụng Electron.

### 📊 Bộ đệm cuộn Backend

- **Lưu trữ dung lượng cao**: mặc định **100.000 dòng** đầu ra terminal, có thể serialize ra đĩa (định dạng MessagePack).
- **Tìm kiếm hiệu năng cao**: `spawn_blocking` cách ly tác vụ tìm kiếm regex, tránh chặn runtime Tokio.
- **Hiệu quả bộ nhớ**: thiết kế bộ đệm vòng tự động loại bỏ dữ liệu cũ nhất, kiểm soát mức sử dụng bộ nhớ.

### ⚛️ Kiến trúc State đa Store

Frontend áp dụng mẫu **Multi-Store** (16 stores) để xử lý các miền trạng thái khác nhau hoàn toàn:

| Store | Vai trò |
|---|---|
| **SessionTreeStore** | Ý định người dùng — cấu trúc cây, luồng kết nối, tổ chức phiên |
| **AppStore** | Lớp thực tế — trạng thái kết nối SSH thực qua `connections` Map, đồng bộ từ SessionTreeStore |
| **IdeStore** | Chế độ IDE — chỉnh sửa tệp từ xa, trạng thái Git, trình soạn thảo đa tab |
| **LocalTerminalStore** | Vòng đời PTY cục bộ, giám sát tiến trình Shell, I/O độc lập |
| **ReconnectOrchestratorStore** | Pipeline kết nối lại tự động (snapshot → grace-period → ssh-connect → await-terminal → restore) |
| **TransferStore** | Hàng đợi truyền tải SFTP và tiến độ |
| **PluginStore** | Trạng thái runtime plugin và registry UI |
| **ProfilerStore** | Số liệu profiler tài nguyên |
| **AiChatStore** | Trạng thái hội thoại AI chat |
| **SettingsStore** | Cài đặt ứng dụng |
| **BroadcastStore** | Broadcast input — sao chép phím gõ đến nhiều panel |
| **CommandPaletteStore** | Trạng thái mở/đóng command palette |
| **EventLogStore** | Nhật ký sự kiện vòng đời kết nối & kết nối lại |
| **LauncherStore** | Trạng thái trình khởi chạy ứng dụng nền tảng |
| **RecordingStore** | Ghi & phát lại phiên terminal |
| **UpdateStore** | Vòng đời cập nhật tự động (check → download → install) |

Mặc dù nguồn trạng thái khác nhau, logic kết xuất được thống nhất qua các component `TerminalView` và `IdeView`.

---

## Ngăn xếp Công nghệ

| Lớp | Công nghệ | Chi tiết |
|---|---|---|
| **Framework** | Tauri 2.0 | Tệp nhị phân gốc, ~15 MB, không Electron |
| **Runtime** | Tokio + DashMap 6 | Bất đồng bộ hoàn toàn với bản đồ đồng thời không khóa |
| **SSH** | russh 0.54 (`ring`) | Thuần Rust, không phụ thuộc C, SSH Agent |
| **PTY cục bộ** | portable-pty 0.8 | Có feature gate, ConPTY trên Windows |
| **Frontend** | React 19.1 + TypeScript 5.8 | Vite 7, Tailwind CSS 4 |
| **State** | Zustand 5 | 16 stores chuyên biệt, đồng bộ hướng sự kiện |
| **Terminal** | xterm.js 6 + WebGL | Tăng tốc GPU, 60fps+ |
| **Trình soạn thảo** | CodeMirror 6 | 16 gói ngôn ngữ + chế độ kế thừa |
| **Mã hóa** | ChaCha20-Poly1305 + Argon2id | AEAD + KDF chống bộ nhớ cứng |
| **Lưu trữ** | redb 2.1 | DB nhúng cho phiên, chuyển tiếp, truyền tải |
| **Serialization** | MessagePack (rmp-serde) | Lưu trữ nhị phân buffer/trạng thái |
| **i18n** | i18next 25 | 11 ngôn ngữ × 21 namespaces |
| **SFTP** | russh-sftp 2.0 | Giao thức truyền tệp SSH |
| **WebSocket** | tokio-tungstenite 0.24 | WebSocket bất đồng bộ cho mặt phẳng dữ liệu terminal |
| **Giao thức** | Wire Protocol v1 | Nhị phân `[Type:1][Length:4][Payload:n]` qua WebSocket |
| **Plugin** | ESM Runtime | PluginContext đóng băng + 24 thành phần UI Kit |

---

## Ma trận tính năng

| Danh mục | Tính năng |
|---|---|
| **Terminal** | PTY cục bộ, SSH từ xa, chia panel (H/V), ghi/phát lại phiên (asciicast v2), ngữ cảnh AI xuyên panel, kết xuất WebGL, bộ sưu tập ảnh nền, 30+ giao diện + trình chỉnh sửa giao diện tùy chỉnh, command palette (`⌘K`), zen mode (`⌘⇧Z`), phím tắt cỡ chữ (`⌘+`/`⌘-`) |
| **SSH** | Connection pool, multiplexing, ProxyJump (∞ hop), đồ thị topo, pipeline kết nối lại tự động |
| **Xác thực** | Mật khẩu, SSH Key (RSA/Ed25519/ECDSA), SSH Agent, Certificate, Keyboard-Interactive (2FA), Known Hosts |
| **Tệp** | Trình duyệt SFTP hai panel, kéo thả, xem trước (ảnh/video/audio/PDF/mã nguồn/hex), hàng đợi truyền tải |
| **IDE** | Cây tệp, trình soạn thảo CodeMirror, đa tab, trạng thái Git, giải quyết xung đột, terminal tích hợp |
| **Chuyển tiếp** | Local (-L), Remote (-R), Dynamic SOCKS5 (-D), tự động khôi phục, báo cáo kết thúc, I/O không khóa |
| **AI** | Bảng nội tuyến + chat bên lề, streaming SSE, chèn mã, 40+ công cụ sử dụng, tích hợp MCP server, ngữ cảnh đa nguồn, OpenAI/Ollama/DeepSeek |
| **Plugin** | Tải ESM runtime, 8 API namespaces, 24 UI Kit, sandbox, circuit breaker |
| **WSL Graphics** ⚠️ | Trình xem VNC tích hợp (Thử nghiệm): Chế độ Desktop (9 DE) + Chế độ App (ứng dụng GUI đơn), phát hiện WSLg, Xtigervnc + noVNC, kết nối lại, gắn feature gate |
| **Bảo mật** | Mã hóa .oxide, OS keychain, xóa bộ nhớ `zeroize`, TOFU host key |
| **i18n** | EN, 简体中文, 繁體中文, 日本語, FR, DE, ES, IT, 한국어, PT-BR, VI |

---

## Tính năng nổi bật

### 🚀 Trải nghiệm Terminal lai
- **Shell cục bộ không độ trễ**: IPC trực tiếp với tiến trình cục bộ, độ trễ gần bằng không.
- **SSH từ xa hiệu năng cao**: luồng nhị phân WebSocket, bỏ qua chi phí HTTP truyền thống.
- **Kế thừa môi trường đầy đủ**: kế thừa PATH, HOME, và tất cả biến môi trường — khớp với trải nghiệm terminal hệ thống.

### 🔐 Xác thực đa dạng
- **Mật khẩu**: lưu trữ an toàn trong keychain hệ thống.
- **Xác thực bằng khóa**: RSA / Ed25519 / ECDSA, tự động quét `~/.ssh/id_*`.
- **SSH Agent**: agent hệ thống qua `AgentSigner` (macOS/Linux/Windows).
- **Certificate**: OpenSSH Certificates.
- **2FA/MFA**: xác thực Keyboard-Interactive.
- **Known Hosts**: xác minh host key với TOFU và `~/.ssh/known_hosts`.

### 🔍 Tìm kiếm toàn văn
Tìm kiếm nội dung tệp toàn dự án với bộ nhớ đệm thông minh:
- **Tìm kiếm thời gian thực**: đầu vào debounce 300ms với kết quả tức thì.
- **Bộ nhớ đệm kết quả**: cache TTL 60 giây tránh quét lặp.
- **Nhóm kết quả**: nhóm theo tệp với vị trí số dòng.
- **Đánh dấu khớp**: từ tìm kiếm được đánh dấu trong đoạn xem trước.
- **Tự động xóa**: cache bị vô hiệu khi tệp thay đổi.

### 📦 Quản lý tệp nâng cao
- **Giao thức SFTP v3**: trình quản lý tệp hai panel đầy đủ.
- **Kéo và thả**: thao tác hàng loạt nhiều tệp và thư mục.
- **Xem trước thông minh**:
  - 🎨 Hình ảnh (JPEG/PNG/GIF/WebP)
  - 🎬 Video (MP4/WebM) với trình phát tích hợp
  - 🎵 Âm thanh (MP3/WAV/OGG/FLAC) với hiển thị metadata
  - 💻 Đánh dấu mã nguồn (30+ ngôn ngữ)
  - 📄 Tài liệu PDF
  - 🔍 Trình xem Hex (tệp nhị phân)
- **Theo dõi tiến độ**: tốc độ thời gian thực, thanh tiến trình, ETA.

### 🌍 Quốc tế hóa (i18n)
- **11 Ngôn ngữ**: English, 简体中文, 繁體中文, 日本語, Français, Deutsch, Español, Italiano, 한국어, Português, Tiếng Việt.
- **Tải động**: gói ngôn ngữ theo yêu cầu qua i18next.
- **An toàn kiểu**: định nghĩa TypeScript cho tất cả khóa dịch thuật.

### 🌐 Tối ưu hóa mạng
- **Kiến trúc hai mặt phẳng**: mặt phẳng dữ liệu (WebSocket trực tiếp) và mặt phẳng điều khiển (Tauri IPC) tách biệt.
- **Giao thức nhị phân tùy chỉnh**: `[Type:1][Length:4][Payload:n]`, không có chi phí serialization JSON.
- **Kiểm soát backpressure**: ngăn tràn bộ nhớ trong lưu lượng bùng phát.
- **Tự động kết nối lại**: thử lại exponential backoff, tối đa 5 lần.

### 🖥️ WSL Graphics (⚠️ Thử nghiệm)
- **Chế độ Desktop**: môi trường desktop Linux GUI đầy đủ bên trong tab terminal — 9 môi trường desktop (Xfce / GNOME / KDE Plasma / MATE / LXDE / Cinnamon / Openbox / Fluxbox / IceWM), phát hiện tự động.
- **Chế độ App**: khởi chạy một ứng dụng GUI đơn lẻ (ví dụ: `gedit`, `firefox`) không cần desktop đầy đủ — Xtigervnc nhẹ + Openbox WM tùy chọn, tự động dọn dẹp khi ứng dụng thoát.
- **Phát hiện WSLg**: tự động phát hiện khả dụng WSLg (socket Wayland / X11) theo mỗi distro, hiển thị dưới dạng huy hiệu trên UI.
- **Xtigervnc + noVNC**: X server độc lập được kết xuất qua `<canvas>` trong ứng dụng, với `scaleViewport` và `resizeSession`.
- **Bảo mật**: inject mảng `argv` (không phân tích shell), `env_clear()` + whitelist tối thiểu, `validate_argv()` 6 quy tắc phòng thủ, giới hạn đồng thời (4 phiên app/distro, 8 toàn cục).
- **Kết nối lại**: WebSocket bridge tái thiết lập mà không dừng phiên VNC.
- **Gắn feature gate**: Cargo feature `wsl-graphics`, lệnh stub trên nền tảng không phải Windows.

---

## Bắt đầu nhanh

### Yêu cầu

- **Rust** 1.75+
- **Node.js** 18+ (khuyến nghị dùng pnpm)
- **Công cụ nền tảng**:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio C++ Build Tools
  - Linux: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`

### Phát triển

```bash
git clone https://github.com/AnalyseDeCircuit/OxideTerm.git
cd OxideTerm && pnpm install

# Ứng dụng đầy đủ (frontend + Rust backend + PTY cục bộ)
pnpm tauri dev

# Chỉ frontend (hot reload trên cổng 1420)
pnpm dev

# Build production
pnpm tauri build

# Kernel nhẹ — loại bỏ PTY cục bộ cho di động
cd src-tauri && cargo build --no-default-features --release
```

---

## Cấu trúc dự án

```
OxideTerm/
├── src/                            # Frontend — 83K dòng TypeScript
│   ├── components/                 # 20 thư mục
│   │   ├── terminal/               #   Giao diện terminal, chia panel, tìm kiếm
│   │   ├── sftp/                   #   Trình duyệt tệp hai panel
│   │   ├── ide/                    #   Trình soạn thảo, cây tệp, hộp thoại Git
│   │   ├── ai/                     #   Chat nội tuyến + bên lề
│   │   ├── graphics/               #   WSL Graphics (VNC desktop + trình xem app)
│   │   ├── plugin/                 #   Trình quản lý plugin & UI runtime
│   │   ├── forwards/               #   Quản lý chuyển tiếp cổng
│   │   ├── connections/            #   CRUD kết nối & nhập khẩu
│   │   ├── topology/               #   Đồ thị topo mạng
│   │   ├── layout/                 #   Sidebar, header, chia panel
│   │   └── ...                     #   sessions, settings, modals, v.v.
│   ├── store/                      # 16 Zustand stores
│   ├── lib/                        # Lớp API, nhà cung cấp AI, plugin runtime
│   ├── hooks/                      # React hooks (sự kiện, bàn phím, thông báo)
│   ├── types/                      # Định nghĩa kiểu TypeScript
│   └── locales/                    # 11 ngôn ngữ × 21 namespaces
│
├── src-tauri/                      # Backend — 51K dòng Rust
│   └── src/
│       ├── router/                 #   NodeRouter (nodeId → tài nguyên)
│       ├── ssh/                    #   SSH client (12 module bao gồm Agent)
│       ├── local/                  #   PTY cục bộ (gắn feature gate)
│       ├── graphics/               #   WSL Graphics (gắn feature gate)
│       ├── bridge/                 #   WebSocket bridge & Wire Protocol v1
│       ├── session/                #   Quản lý phiên (16 module)
│       ├── forwarding/             #   Chuyển tiếp cổng (6 module)
│       ├── sftp/                   #   Triển khai SFTP
│       ├── config/                 #   Vault, keychain, cấu hình SSH
│       ├── oxide_file/             #   Mã hóa .oxide (ChaCha20)
│       ├── commands/               #   24 module lệnh Tauri IPC
│       └── state/                  #   Kiểu trạng thái toàn cục
│
└── docs/                           # 27+ tài liệu kiến trúc & tính năng
```

---

## Lộ trình

### ✅ Đã phát hành (v0.14.0)

- [x] Terminal cục bộ (PTY) với feature gating
- [x] SSH connection pool & multiplexing
- [x] Xác thực SSH Agent (AgentSigner)
- [x] Kiến trúc Node-first (NodeRouter + events)
- [x] Trình điều phối kết nối lại tự động (pipeline 8 giai đoạn với Grace Period)
- [x] ProxyJump chuỗi bastion không giới hạn
- [x] Chuyển tiếp cổng — local / remote / dynamic SOCKS5
- [x] Trình quản lý tệp SFTP hai panel với xem trước
- [x] Chế độ IDE (CodeMirror 6 + trạng thái Git)
- [x] Xuất mã hóa .oxide với nhúng khóa
- [x] Trợ lý AI terminal (nội tuyến + bên lề)
- [x] AI sử dụng công cụ — 40+ công cụ tích hợp với điều khiển tự động phê duyệt
- [x] AI inject ngữ cảnh đa nguồn (IDE / SFTP / Git)
- [x] MCP (Model Context Protocol) — truyền tải stdio & SSE, UI cài đặt, khám phá công cụ theo server
- [x] Hệ thống plugin runtime (PluginContext + UI Kit)
- [x] Chia panel terminal với phím tắt
- [x] Profiler tài nguyên (CPU / bộ nhớ / mạng)
- [x] i18n — 11 ngôn ngữ × 21 namespaces
- [x] Xác thực Keyboard-Interactive (2FA/MFA)
- [x] Tìm kiếm lịch sử sâu (30K dòng, Rust regex)
- [x] WSL Graphics — chế độ desktop + chế độ app VNC viewer (⚠️ Thử nghiệm)
- [x] Bộ sưu tập ảnh nền — tải lên đa ảnh, điều khiển theo tab, công tắc chính
- [x] Xem trước media nâng cao — phát audio/video trong trình duyệt SFTP
- [x] Ghi & phát lại phiên
- [x] Công cụ tùy chỉnh giao diện — 30+ giao diện tích hợp, trình chỉnh sửa trực quan với nhập hex, 22 trường màu terminal + 19 trường UI
- [x] Command palette (`⌘K`) — tìm kiếm mờ qua kết nối, hành động, và cài đặt
- [x] Zen mode (`⌘⇧Z`) — terminal toàn màn hình không lo phân tâm, ẩn sidebar và thanh tab
- [x] Phím tắt cỡ chữ terminal (`⌘+` / `⌘-` / `⌘0`) với refit PTY trực tiếp

### 🚧 Đang phát triển

- [ ] Tìm kiếm phiên & chuyển đổi nhanh

### 📋 Kế hoạch

- [ ] Chuyển tiếp SSH Agent

---

## Bảo mật

| Mối quan tâm | Triển khai |
|---|---|
| **Mật khẩu** | OS keychain (macOS Keychain / Windows Credential Manager / Linux libsecret) |
| **API Keys AI** | OS keychain dưới dịch vụ `com.oxideterm.ai`; trên macOS, thao tác đọc khóa yêu cầu **Touch ID** (cổng sinh trắc học qua `LocalAuthentication.framework`, không cần data-protection entitlements) — khóa được cache trong bộ nhớ sau lần xác thực đầu tiên, nên Touch ID chỉ được yêu cầu một lần mỗi phiên |
| **Tệp cấu hình** | `~/.oxideterm/connections.json` — chỉ lưu ID tham chiếu keychain |
| **Xuất** | .oxide: ChaCha20-Poly1305 + Argon2id, nhúng khóa tùy chọn |
| **Bộ nhớ** | `zeroize` xóa dữ liệu nhạy cảm; Rust đảm bảo an toàn bộ nhớ |
| **Host keys** | TOFU với `~/.ssh/known_hosts` |
| **Plugin** | Object.freeze + Proxy ACL, circuit breaker, IPC whitelist |

---

## Giấy phép

**PolyForm Noncommercial 1.0.0**

- ✅ Sử dụng cá nhân / phi lợi nhuận: miễn phí
- 🚫 Sử dụng thương mại: yêu cầu giấy phép
- ⚖️ Điều khoản bảo vệ bằng sáng chế (Nuclear Clause)

Toàn văn: https://polyformproject.org/licenses/noncommercial/1.0.0/

---

## Lời cảm ơn

- [russh](https://github.com/warp-tech/russh) — SSH thuần Rust
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty) — PTY đa nền tảng
- [Tauri](https://tauri.app/) — Framework ứng dụng gốc
- [xterm.js](https://xtermjs.org/) — Trình giả lập terminal
- [CodeMirror](https://codemirror.net/) — Trình soạn thảo mã nguồn
- [Radix UI](https://www.radix-ui.com/) — UI primitives dễ tiếp cận

---

<p align="center">
  <sub>Xây dựng với Rust và Tauri — Hơn 130.000 dòng mã</sub>
</p>
