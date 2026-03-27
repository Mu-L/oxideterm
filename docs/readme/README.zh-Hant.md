<p align="center">
  <img src="../../src-tauri/icons/icon.ico" alt="OxideTerm" width="128" height="128">
</p>

<h1 align="center">⚡ OxideTerm</h1>

<p align="center">
  <strong>本機終端 + SSH + SFTP + AI，一個原生應用全搞定。</strong>
  <br>
  <em>零 Electron。零 OpenSSL。純 Rust SSH 堆疊。</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.20.2-blue" alt="Version">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blueviolet" alt="License">
  <img src="https://img.shields.io/badge/rust-1.75+-orange" alt="Rust">
  <img src="https://img.shields.io/badge/tauri-2.0-purple" alt="Tauri">
</p>

<p align="center">
  <a href="https://github.com/AnalyseDeCircuit/oxideterm/releases/latest">
    <img src="https://img.shields.io/github/v/release/AnalyseDeCircuit/oxideterm?label=%E4%B8%8B%E8%BC%89%E6%9C%80%E6%96%B0%E7%89%88&style=for-the-badge&color=brightgreen" alt="下載最新版">
  </a>
</p>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-Hans.md">简体中文</a> | <a href="README.zh-Hant.md">繁體中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

---

<div align="center">

https://github.com/user-attachments/assets/4ba033aa-94b5-4ed4-980c-5c3f9f21db7e

*🤖 OxideSens —「開啟一個本機終端並執行 echo hello, world!」*

</div>

## OxideTerm 是什麼？

OxideTerm 是一款**跨平台終端應用**，將本地 Shell、遠端 SSH 工作階段、檔案管理、程式碼編輯和 OxideSens 整合進一個 Rust 原生二進位檔案中。它**不是** Electron 套殼——後端完全由 Rust 撰寫，透過 Tauri 2.0 封裝為約 20-35 MB 的原生可執行檔。

### 為什麼需要 OxideTerm？

| 痛點 | OxideTerm 的解答 |
|---|---|
| SSH 客戶端不支援本地 Shell | 混合引擎：本地 PTY + 遠端 SSH 在同一視窗 |
| 斷線重連 = 遺失一切 | **Node-first 架構**：自動重連帶寬限期保護 TUI 應用；恢復轉發、傳輸、IDE 狀態 |
| 遠端編輯需要 VS Code Remote | **內建 IDE 模式**：CodeMirror 6 基於 SFTP，預設零安裝；Linux 可選部署遠端 Agent 增強體驗 |
| SSH 連線不可複用 | **SSH 多路複用**：終端、SFTP、轉發共享一條連線 |
| SSH 函式庫依賴 OpenSSL | **russh 0.54**：純 Rust SSH，`ring` 密碼學後端，無 C 依賴 |

---

## 截圖展示

<table>
<tr>
<td align="center"><strong>SSH 終端 + OxideSens AI</strong><br/><br/><img src="../screenshots/terminal/SSHTERMINAL.png" alt="SSH 終端與 OxideSens AI 側邊欄" /></td>
<td align="center"><strong>SFTP 檔案管理器</strong><br/><br/><img src="../screenshots/sftp/sftp.png" alt="SFTP 雙欄檔案管理器與傳輸佇列" /></td>
</tr>
<tr>
<td align="center"><strong>內建 IDE（CodeMirror 6）</strong><br/><br/><img src="../screenshots/miniIDE/miniide.png" alt="內建 IDE 模式，CodeMirror 6 編輯器" /></td>
<td align="center"><strong>智慧端口轉發</strong><br/><br/><img src="../screenshots/PORTFORWARD/PORTFORWARD.png" alt="智慧端口轉發與自動偵測" /></td>
</tr>
</table>

---

## 架構概覽

```
┌─────────────────────────────────────┐
│        前端 (React 19)              │
│                                     │
│  SessionTreeStore ──► AppStore      │    16 個 Zustand Store
│  IdeStore    LocalTerminalStore     │    20 個元件目錄
│  ReconnectOrchestratorStore         │    11 種語言 × 21 命名空間
│  PluginStore  AiChatStore  ...      │
│                                     │
│        xterm.js 6 + WebGL           │
└──────────┬──────────────┬───────────┘
           │ Tauri IPC    │ WebSocket (二進位)
┌──────────▼──────────────▼───────────┐
│         後端 (Rust)                 │
│                                     │
│  NodeRouter ── resolve(nodeId) ──►  │    24 個 IPC 命令模組
│  ├─ SshConnectionRegistry          │    DashMap 併發狀態
│  ├─ SessionRegistry                │    Feature-gated 本地 PTY
│  ├─ ForwardingManager              │    ChaCha20-Poly1305 保險庫
│  ├─ SftpSession (連線級)            │    russh 0.54 (ring 後端)
│  └─ LocalTerminalRegistry          │    SSH Agent (AgentSigner)
│                                     │
│  Wire Protocol v1                   │
│  [Type:1][Length:4][Payload:n]       │
└─────────────────────────────────────┘
```

**雙平面通訊**：WebSocket 二進位幀承載終端 I/O（零序列化開銷），Tauri IPC 承載結構化命令和事件。前端從不接觸 `sessionId` 或 `connectionId`——一切透過 `nodeId` 定址，由後端 `NodeRouter` 解析。

---

## 核心技術亮點

### 🔩 純 Rust SSH — russh 0.54

OxideTerm 搭載 **russh 0.54**，編譯使用 `ring` 密碼學後端：
- SSH 路徑中**零 C/OpenSSL 依賴**——整個密碼學堆疊純 Rust 實作
- 完整 SSH2 協定：金鑰交換、通道、SFTP 子系統、連接埠轉發
- ChaCha20-Poly1305 和 AES-GCM 密碼套件，Ed25519/RSA/ECDSA 金鑰

### 🔑 SSH Agent 認證 (AgentSigner)

自研 `AgentSigner` 封裝系統 SSH Agent，滿足 russh 的 `Signer` trait：

```rust
// 通過將 &PublicKey 克隆為 owned 值，解決 russh 0.54 中
// RPITIT Send bound 跨 .await 借用問題
pub struct AgentSigner { /* ... */ }
impl Signer for AgentSigner { /* 通過 Agent IPC 完成挑戰-回應簽章 */ }
```

- **平台支援**：Unix (`SSH_AUTH_SOCK`)、Windows (`\\.\pipe\openssh-ssh-agent`)
- **代理鏈支援**：每一跳可獨立使用 Agent 認證
- **重連韌性**：重連時自動重放 `AuthMethod::Agent`

### 🧭 Node-First 架構 (NodeRouter)

**Oxide-Next 節點抽象**消滅了一整類競態條件：

```
前端: useNodeState(nodeId) → { readiness, sftpReady, error }
後端: NodeRouter.resolve(nodeId) → ConnectionEntry → SftpSession
```

- 前端 SFTP/IDE 操作只傳 `nodeId`——不傳 `sessionId`，不傳 `connectionId`
- 後端原子解析 `nodeId → ConnectionEntry`
- SSH 重連導致 `connectionId` 變化——SFTP/IDE **無感知**
- `NodeEventEmitter` 推送帶 generation 計數器的型別化事件，保證有序性

### ⚙️ 本地終端 — 執行緒安全 PTY

基於 `portable-pty 0.8` 的跨平台本地 Shell，透過 `local-terminal` Feature Gate 控制：

- **執行緒安全**：`std::sync::Mutex` 封裝 `MasterPty` + `unsafe impl Sync`
- **專用 I/O 執行緒**：阻塞式 PTY 讀取不干擾 Tokio 事件迴圈
- **Shell 探測**：自動識別 `zsh`、`bash`、`fish`、`pwsh`、Git Bash、WSL2
- **Feature Gate**：`cargo build --no-default-features` 可剝離 PTY，為行動端鋪路

### 🔌 執行時期插件系統 (v1.6.2+)

動態插件載入，凍結 API，安全加固：

- **PluginContext API**：8 個命名空間（terminal, ui, commands, settings, lifecycle, events, storage, system）
- **24 個 UI Kit 元件**：預建構 React 元件注入插件沙箱
- **安全模型**：`Object.freeze` + Proxy 存取控制、熔斷器機制、IPC 白名單
- **Membrane 架構**：插件在隔離 ESM 上下文中執行，透過受控橋接存取宿主

### 🛡️ SSH 智慧連線池

基於參考計數的 `SshConnectionRegistry`，底層 DashMap：

- 多終端、SFTP、連接埠轉發共享**同一條實體 SSH 連線**
- 每連線獨立狀態機（connecting → active → idle → link_down → reconnecting）
- 閒置逾時（可設定：5 分鐘 / 15 分鐘 / 30 分鐘 / 1 小時 / 永不逾時）、心跳保活 (15 秒)、心跳驅動的故障偵測
- WsBridge 本地心跳：30 秒間隔、5 分鐘逾時（容忍 App Nap）
- 閒置逾時斷線發 `connection_status_changed` 事件通知前端
- 級聯傳播：跳板機斷線 → 所有下游節點標記 `link_down`
- **智慧感知**：`visibilitychange` + `online` 事件 → 主動 SSH 探測（~2 秒 vs 被動 15-30 秒）
- **寬限期**：30 秒視窗嘗試恢復現有連線，避免破壞性重連殺死 TUI 應用（yazi/vim/htop）

### 🔀 連接埠轉發 — 無鎖 I/O

完整的本地 (-L)、遠端 (-R) 和動態 SOCKS5 (-D) 轉發：

- **訊息傳遞架構**：SSH Channel 由單一 `ssh_io` 任務持有，無 `Arc<Mutex<Channel>>`
- **死亡報告**：轉發任務在 SSH 斷開時主動上報退出原因
- **自動恢復**：`Suspended` 狀態的轉發規則在重連後自動恢復
- **閒置逾時**：`FORWARD_IDLE_TIMEOUT` (300 秒) 防止殭屍連線

### 🤖 OxideSens

雙模式 AI，隱私優先：

- **內嵌面板** (`⌘I`)：快速命令，透過 Bracketed Paste 注入終端
- **側邊欄聊天**：持久化對話，支援歷史記錄
- **上下文擷取**：Terminal Registry 從活動或全部分割面板採集緩衝區
- **多源上下文**：自動注入 IDE 檔案、SFTP 路徑、Git 狀態到 AI 對話
- **工具呼叫**：40+ 內建工具（檔案操作、程序管理、網路、TUI 互動），AI 可自主呼叫
- **MCP 支援**：連接外部 [Model Context Protocol](https://modelcontextprotocol.io) 伺服器（stdio & SSE），透過第三方工具擴充 AI 能力 — 在設定中管理
- **廣泛相容**：OpenAI、Ollama、DeepSeek、OneAPI，任意 `/v1/chat/completions` 端點
- **安全儲存**：API Key 存於系統鑰匙圈（macOS Keychain / Windows Credential Manager）；macOS 下讀取 Key 時透過 **Touch ID** 生物認證（`LocalAuthentication.framework` / `LAContext`，無需程式碼簽章或 entitlement）

### 📚 RAG 運維知識庫 (v0.20)

本地優先的檢索增強生成系統，面向運維文件：

- **文件集合**：匯入 Markdown/TXT 格式的運維手冊、SOP、部署指南，支援全域或按連線作用域
- **混合搜尋**：BM25 關鍵字索引 + 向量餘弦相似度，透過倒數排名融合 (RRF) 結合
- **Markdown 感知切片**：按標題層級切分，保留段落路徑（如「部署 > Docker > 故障排除」）
- **CJK 支援**：中日韓 bigram 分詞器 + 拉丁字母空格分詞
- **AI 整合**：`search_docs` 工具在 AI 對話中自動檢索相關文件上下文——無需手動觸發
- **外部編輯**：在系統編輯器中開啟文件，視窗取得焦點時自動同步，樂觀版本鎖定
- **重建索引**：BM25 完整重建，即時進度列，支援取消
- **嵌入管線**：前端透過 AI 服務商生成向量，儲存於後端，實現混合檢索
- **儲存**：redb 嵌入式資料庫，9 張表，MessagePack 序列化，大 chunk 自動壓縮

### 💻 IDE 模式 — 遠端編輯

CodeMirror 6 編輯器透過 SFTP 操作遠端檔案——預設無需伺服器端安裝，Linux 上可選部署輕量遠端 Agent 以獲得增強體驗：

- **檔案樹**：SFTP 懶載入 + Git 狀態指示器
- **30+ 語言模式**：16 個原生 CodeMirror 語言套件 + legacy modes
- **衝突解決**：基於 `mtime` 的樂觀鎖
- **事件驅動 Git**：儲存/建立/刪除/重新命名/終端回車後自動重新整理狀態
- **狀態門禁**：`readiness !== 'ready'` 時阻斷所有 IO，重連時 Key-Driven Reset
- **Linux 遠端 Agent（可選）**：~1 MB Rust 二進位檔，x86_64/aarch64 自動部署；ARMv7、RISC-V64、LoongArch64、s390x 等額外架構可從 `agents/extra/` 手動下載上傳

### 🔐 .oxide 加密匯出

可攜式的連線備份格式：

- **ChaCha20-Poly1305 AEAD** 認證加密
- **Argon2id KDF**（256 MB 記憶體成本，4 迭代）——抗 GPU 暴力破解
- **SHA-256** 完整性校驗
- **可選金鑰內嵌**：私鑰以 base64 編碼嵌入加密酬載
- **匯出前體檢**：認證類型統計、遺失金鑰偵測

### 📡 ProxyJump — 拓撲感知的多跳連線

- 無限鏈式深度：`Client → Jump A → Jump B → … → Target`
- 自動解析 SSH Config，建構拓撲圖，Dijkstra 最佳路徑計算
- 跳板機節點可複用為獨立工作階段
- 級聯故障傳播，下游節點狀態自動同步

### 📊 資源監控器

透過持久化 SSH Shell 通道即時採集遠端主機指標：

- 讀取 `/proc/stat`、`/proc/meminfo`、`/proc/loadavg`、`/proc/net/dev`
- 基於 Delta 的 CPU% 和網路吞吐量計算
- 單通道設計——不觸發 MaxSessions 限制
- 非 Linux 主機或連續失敗時自動降級為 RTT-Only 模式

### 🖼️ 背景圖片畫廊

多圖背景系統，支援按分頁透明度控制：

- **畫廊管理**：上傳多張圖片，點擊縮圖切換，單張刪除或一鍵清除
- **總開關**：全域啟用/停用背景圖，不會刪除已上傳圖片
- **按分頁控制**：13 種分頁類型可獨立開關（終端、SFTP、IDE、設定、拓撲等）
- **自訂**：透明度 (3–50%)、模糊 (0–20px)、填充模式 (覆蓋/適應/拉伸/平鋪)
- **平台感知**：macOS 透明支援；Windows WSLg 路徑排除（VNC 畫布不支援透明）
- **安全**：路徑正規化刪除防止目錄穿越；Rust 後端完整錯誤傳播

### ⚡ 自適應渲染 — 動態重新整理率

三層渲染排程器取代固定 RAF 批次處理，在高吞吐輸出時提升回應性，閒置時降低 GPU 負載和電量消耗：

| 層級 | 觸發條件 | 實際重新整理率 | 優勢 |
|---|---|---|---|
| **Boost（高速）** | 單幀資料 ≥ 4 KB | 120 Hz+（RAF / ProMotion 原生）| 消除快速輸出時的捲動卡頓 |
| **Normal（正常）** | 一般鍵入 / 輕量 I/O | 60 Hz（RAF） | 流暢的基礎互動體驗 |
| **Idle（閒置）** | 3 秒無 I/O / 分頁隱藏 / 視窗失焦 | 1–15 Hz（計時器，指數增長）| GPU 近零負載，節省電池 |

- **自動模式**：由資料量、使用者輸入以及 Page Visibility API 事件驅動層級切換，無需手動調參
- **背景安全**：分頁隱藏時，遠端傳入資料繼續透過閒置計時器刷新 —— 不喚醒 RAF，避免背景分頁 Pending 緩衝區積壓
- **設定入口**：三種模式（自動 / 始終 60 Hz / 關閉），位於 設定 → 終端 → 渲染器
- **即時診斷**：啟用「**顯示幀率浮層**」，終端角落即時顯示層級徽章（`B`=高速 · `N`=正常 · `I`=閒置）、幀率及每秒寫入次數

### 🎨 自訂主題引擎

超越預設配色方案的全深度主題自訂：

- **30+ 內建主題**：Oxide、Dracula、Nord、Catppuccin、Spring Rice、Tokyo Night 等
- **視覺化編輯器**：顏色選取器 + RGB 十六進位輸入，覆蓋每個欄位
- **終端配色**：xterm.js 全部 22 個欄位（背景、前景、游標、選取區、16 ANSI 色）
- **UI 介面色**：19 個 CSS 變數，分 5 大類——背景(5)、文字(3)、邊框(3)、強調(4)、語義狀態色(4)
- **自動推導**：一鍵從終端配色產生全套 UI 顏色
- **即時預覽**：編輯時即時展示迷你終端 + UI 介面效果
- **複製 & 擴充**：基於任意內建或自訂主題建立新主題
- **持久儲存**：自訂主題儲存至 localStorage，跨更新保留

### 🪟 Windows 深度最佳化

- **原生 ConPTY 整合**：直接呼叫 Windows Pseudo Console (ConPTY) API，完美支援 TrueColor 和 ANSI 跳脫序列——告別過時的 WinPTY。
- **智慧 Shell 探測**：內建掃描引擎自動偵測 **PowerShell 7 (pwsh)**、**Git Bash**、**WSL2** 和傳統 CMD，透過登錄檔和 PATH 掃描。
- **原生體驗**：Rust 直接處理視窗事件——回應速度遠超 Electron 應用。

### 📊 後端捲動緩衝區

- **大容量持久化**：預設 **100,000 行**終端輸出，可序列化到磁碟（MessagePack 格式）。
- **高效能搜尋**：`spawn_blocking` 隔離正規表示式搜尋任務，避免阻塞 Tokio 執行時期。
- **記憶體高效**：環形緩衝區設計自動淘汰最舊資料，記憶體用量可控。

### ⚛️ 多 Store 狀態架構

前端採用 **Multi-Store** 模式（16 個 Store）因應差異化的狀態管理需求：

| Store | 職責 |
|---|---|
| **SessionTreeStore** | 使用者意圖層 — 樹狀結構、連線流程、工作階段組織 |
| **AppStore** | 事實層 — 透過 `connections` Map 管理實際 SSH 連線狀態，從 SessionTreeStore 同步 |
| **IdeStore** | IDE 模式 — 遠端檔案編輯、Git 狀態追蹤、多分頁編輯器 |
| **LocalTerminalStore** | 本地 PTY 生命週期、Shell 程序監控、獨立 I/O |
| **ReconnectOrchestratorStore** | 自動重連管線（snapshot → grace-period → ssh-connect → await-terminal → restore） |
| **TransferStore** | SFTP 傳輸佇列與進度 |
| **PluginStore** | 插件執行時期狀態和 UI 註冊表 |
| **ProfilerStore** | 資源監控指標 |
| **AiChatStore** | OxideSens 對話狀態 |
| **SettingsStore** | 應用設定 |
| **BroadcastStore** | 廣播輸入 — 將按鍵複製到多個面板 |
| **CommandPaletteStore** | 命令面板開關狀態 |
| **EventLogStore** | 連線生命週期 & 重連事件日誌 |
| **LauncherStore** | 平台應用啟動器狀態 |
| **RecordingStore** | 終端工作階段錄製 & 回放 |
| **UpdateStore** | 自動更新生命週期（檢查 → 下載 → 安裝） |

儘管狀態來源不同，渲染邏輯透過 `TerminalView` 和 `IdeView` 統一視圖層。
---

## 技術堆疊

| 層級 | 技術 | 說明 |
|---|---|---|
| **框架** | Tauri 2.0 | 原生二進位檔，~15 MB，零 Electron |
| **執行時期** | Tokio + DashMap 6 | 全非同步 + 無鎖併發映射 |
| **SSH** | russh 0.54 (`ring`) | 純 Rust，零 C 依賴，SSH Agent |
| **本地 PTY** | portable-pty 0.8 | Feature-gated，Windows ConPTY |
| **前端** | React 19.1 + TypeScript 5.8 | Vite 7，Tailwind CSS 4 |
| **狀態管理** | Zustand 5 | 16 個專用 Store，事件驅動同步 |
| **終端渲染** | xterm.js 6 + WebGL | GPU 加速，60fps+ |
| **編輯器** | CodeMirror 6 | 16 語言套件 + legacy modes |
| **加密** | ChaCha20-Poly1305 + Argon2id | AEAD 認證加密 + 記憶體硬化 KDF |
| **儲存** | redb 2.1 | 嵌入式資料庫（工作階段、轉發、傳輸） |
| **序列化** | MessagePack (rmp-serde) | 二進位緩衝區/狀態持久化 |
| **國際化** | i18next 25 | 11 種語言 × 21 命名空間 |
| **SFTP** | russh-sftp 2.0 | SSH 檔案傳輸協定 |
| **WebSocket** | tokio-tungstenite 0.24 | 非同步 WebSocket，終端資料平面 |
| **協定** | Wire Protocol v1 | 二進位 `[Type:1][Length:4][Payload:n]` 基於 WebSocket |
| **插件** | ESM Runtime | 凍結 PluginContext + 24 UI Kit 元件 |

---

## 功能矩陣

| 分類 | 功能 |
|---|---|
| **終端** | 本地 PTY、SSH 遠端、分割畫面 (水平/垂直)、工作階段錄製/回放 (asciicast v2)、跨分割 AI 上下文、WebGL 渲染、背景圖片畫廊、30+ 主題 + 自訂主題編輯器、命令面板 (`⌘K`)、禪模式 (`⌘⇧Z`)、字體大小快速鍵 (`⌘+`/`⌘-`) |
| **SSH** | 連線池、多路複用、ProxyJump (∞ 跳)、拓撲圖、自動重連管線 |
| **認證** | 密碼、SSH 金鑰 (RSA/Ed25519/ECDSA)、SSH Agent、憑證、Keyboard-Interactive (2FA)、Known Hosts |
| **檔案** | 雙面板 SFTP 瀏覽器、拖放傳輸、預覽 (圖片/影片/音訊/PDF/程式碼/Hex)、傳輸佇列 |
| **IDE** | 檔案樹、CodeMirror 編輯器、多分頁、Git 狀態、衝突解決、整合終端 |
| **轉發** | 本地 (-L)、遠端 (-R)、動態 SOCKS5 (-D)、自動恢復、死亡報告、無鎖 I/O |
| **AI** | 內嵌面板 + 側邊欄聊天、串流 SSE、命令插入、40+ 工具呼叫、MCP 伺服器整合、多源上下文、RAG 知識庫、OpenAI/Ollama/DeepSeek |
| **插件** | ESM 執行時期載入、8 API 命名空間、24 UI Kit、沙箱執行、熔斷器 |
| **WSL 圖形** ⚠️ | 內建 VNC 檢視器（實驗性）：桌面模式（9 種桌面環境）+ 應用模式（單 GUI 應用），WSLg 偵測，Xtigervnc + noVNC，支援重連，Feature-gated |
| **安全** | .oxide 加密匯出、系統鑰匙圈、`zeroize` 記憶體擦除、主機金鑰 TOFU |
| **國際化** | EN, 簡體中文, 繁體中文, 日本語, FR, DE, ES, IT, 한국어, PT-BR, VI |

---

## 功能特性介紹

### 🚀 混合終端體驗
- **零延遲本地 Shell**：直接 IPC 與本地程序互動，近零延遲。
- **高效能遠端 SSH**：WebSocket 二進位串流傳輸，跳過傳統 HTTP 開銷。
- **完整環境繼承**：繼承 PATH、HOME 等全部環境變數，與系統終端體驗一致。

### 🔐 多元化認證方式
- **密碼認證**：安全儲存於系統鑰匙圈。
- **金鑰認證**：支援 RSA / Ed25519 / ECDSA，自動掃描 `~/.ssh/id_*`。
- **SSH Agent**：透過 `AgentSigner` 存取系統 Agent（macOS/Linux/Windows）。
- **憑證認證**：OpenSSH Certificates。
- **2FA/MFA**：Keyboard-Interactive 認證。
- **Known Hosts**：主機金鑰 TOFU 驗證 + `~/.ssh/known_hosts`。

### 🔍 全文搜尋
專案級檔案內容搜尋，智慧快取：
- **即時搜尋**：300ms 防抖輸入，即時回傳結果。
- **結果快取**：60 秒 TTL 快取，避免重複掃描。
- **分組展示**：按檔案分組，帶行號定位。
- **高亮比對**：搜尋詞在預覽中高亮顯示。
- **自動失效**：檔案變更時自動清除快取。

### 📦 進階檔案管理
- **SFTP v3 協定**：完整雙面板檔案管理器。
- **拖放傳輸**：支援多檔案和資料夾批次操作。
- **智慧預覽**：
  - 🎨 圖片 (JPEG/PNG/GIF/WebP)
  - 🎬 影片 (MP4/WebM) 內建播放器
  - 🎵 音訊 (MP3/WAV/OGG/FLAC) 含中繼資料展示
  - 💻 程式碼高亮 (30+ 語言)
  - 📄 PDF 文件
  - 🔍 Hex 檢視器（二進位檔案）
- **進度追蹤**：即時速度、進度條、預計完成時間。

### 🌍 國際化 (i18n)
- **11 種語言**：English、簡體中文、繁體中文、日本語、Français、Deutsch、Español、Italiano、한국어、Português、Tiếng Việt。
- **動態載入**：透過 i18next 按需載入語言套件。
- **型別安全**：所有翻譯鍵均有 TypeScript 型別定義。

<details>
<summary>📸 11 種語言介面一覽</summary>
<br>
<table>
  <tr>
    <td align="center"><img src="../screenshots/overview/en.png" width="280"><br><b>English</b></td>
    <td align="center"><img src="../screenshots/overview/zhHans.png" width="280"><br><b>简体中文</b></td>
    <td align="center"><img src="../screenshots/overview/zhHant.png" width="280"><br><b>繁體中文</b></td>
  </tr>
  <tr>
    <td align="center"><img src="../screenshots/overview/ja.png" width="280"><br><b>日本語</b></td>
    <td align="center"><img src="../screenshots/overview/ko.png" width="280"><br><b>한국어</b></td>
    <td align="center"><img src="../screenshots/overview/fr.png" width="280"><br><b>Français</b></td>
  </tr>
  <tr>
    <td align="center"><img src="../screenshots/overview/de.png" width="280"><br><b>Deutsch</b></td>
    <td align="center"><img src="../screenshots/overview/es.png" width="280"><br><b>Español</b></td>
    <td align="center"><img src="../screenshots/overview/it.png" width="280"><br><b>Italiano</b></td>
  </tr>
  <tr>
    <td align="center"><img src="../screenshots/overview/pt-BR.png" width="280"><br><b>Português</b></td>
    <td align="center"><img src="../screenshots/overview/vi.png" width="280"><br><b>Tiếng Việt</b></td>
    <td></td>
  </tr>
</table>
</details>

### 🌐 網路最佳化
- **雙平面架構**：資料平面（WebSocket 直連）與控制平面（Tauri IPC）分離。
- **自訂二進位協定**：`[Type:1][Length:4][Payload:n]`，無 JSON 序列化開銷。
- **背壓控制**：突發流量時防止記憶體溢位。
- **自動重連**：指數退避重試，最多 5 次。

### 🖥️ WSL 圖形（⚠️ 實驗性）
- **桌面模式**：在終端分頁內執行完整 Linux GUI 桌面——支援 9 種桌面環境（Xfce / GNOME / KDE Plasma / MATE / LXDE / Cinnamon / Openbox / Fluxbox / IceWM），自動偵測。
- **應用模式**：無需完整桌面，直接啟動單個 GUI 應用（如 `gedit`、`firefox`）——輕量 Xtigervnc + 可選 Openbox WM，應用結束時自動清理。
- **WSLg 偵測**：自動偵測每個發行版的 WSLg 可用性（Wayland / X11 socket），UI 中顯示狀態徽章。
- **Xtigervnc + noVNC**：獨立 X 伺服器，透過應用內 `<canvas>` 渲染，支援 `scaleViewport` 和 `resizeSession`。
- **安全性**：`argv` 陣列注入（無 shell 解析），`env_clear()` + 最小白名單，`validate_argv()` 6 層防禦，併發限制（每發行版 4 個應用工作階段，全域 8 個）。
- **重連**：WebSocket 橋接可在不終止 VNC 工作階段的情況下重新建立。
- **Feature-gated**：`wsl-graphics` Cargo Feature，非 Windows 平台註冊樁命令。

---

## 快速開始

### 前置要求

- **Rust** 1.75+
- **Node.js** 18+（推薦 pnpm）
- **平台工具**：
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio C++ Build Tools
  - Linux: `build-essential`、`libwebkit2gtk-4.1-dev`、`libssl-dev`

### 開發建構

```bash
git clone https://github.com/AnalyseDeCircuit/OxideTerm.git
cd OxideTerm && pnpm install

# 完整應用（前端 + Rust 後端 + 本地 PTY）
pnpm tauri dev

# 僅前端（連接埠 1420 熱更新）
pnpm dev

# 正式建構
pnpm tauri build

# 輕量核心——剝離本地 PTY，適配行動端
cd src-tauri && cargo build --no-default-features --release
```

---

## 專案結構

```
OxideTerm/
├── src/                            # 前端 — 83K 行 TypeScript
│   ├── components/                 # 20 個目錄
│   │   ├── terminal/               #   終端視圖、分割畫面、搜尋
│   │   ├── sftp/                   #   雙面板檔案瀏覽器
│   │   ├── ide/                    #   編輯器、檔案樹、Git 對話框
│   │   ├── ai/                     #   內嵌 + 側邊欄聊天
│   │   ├── plugin/                 #   插件管理 & 執行時期 UI
│   │   ├── forwards/               #   連接埠轉發管理
│   │   ├── connections/            #   連線增刪改查 & 匯入
│   │   ├── topology/               #   網路拓撲圖
│   │   ├── layout/                 #   側邊欄、標頭、分割佈局
│   │   └── ...                     #   sessions, settings, modals 等
│   ├── store/                      # 16 個 Zustand Store
│   ├── lib/                        # API 層、AI 提供者、插件執行時期
│   ├── hooks/                      # React Hooks (事件、鍵盤、Toast)
│   ├── types/                      # TypeScript 型別定義
│   └── locales/                    # 11 種語言 × 21 命名空間
│
├── src-tauri/                      # 後端 — 51K 行 Rust
│   └── src/
│       ├── router/                 #   NodeRouter (nodeId → 資源)
│       ├── ssh/                    #   SSH 客戶端 (12 模組含 Agent)
│       ├── local/                  #   本地 PTY (feature-gated)
│       ├── graphics/               #   WSL 圖形 (feature-gated)
│       ├── bridge/                 #   WebSocket 橋接 & Wire Protocol v1
│       ├── session/                #   工作階段管理 (16 模組)
│       ├── forwarding/             #   連接埠轉發 (6 模組)
│       ├── sftp/                   #   SFTP 實作
│       ├── config/                 #   保險庫、鑰匙圈、SSH Config
│       ├── oxide_file/             #   .oxide 加密 (ChaCha20)
│       ├── commands/               #   24 個 Tauri IPC 命令模組
│       └── state/                  #   全域狀態型別
│
└── docs/                           # 27+ 架構與功能文件
```

---

## 路線圖

### 🚧 進行中 (v0.21)

- [x] RAG 運維知識庫——本地文件集合，BM25 + 向量混合搜尋，AI 整合檢索
- [x] MCP（模型上下文協議）用戶端——將 OxideSens 連接至外部工具伺服器
- [ ] 工作階段搜尋 & 快速切換

### 📋 計畫中

- [ ] SSH Agent 轉發

---

## 安全設計

| 關注點 | 實作 |
|---|---|
| **密碼** | 系統鑰匙圈 (macOS Keychain / Windows Credential Manager / Linux libsecret) |
| **AI API Key** | 系統鑰匙圈 `com.oxideterm.ai` 服務；macOS 下讀取前強制 **Touch ID** 驗證（`LAContext.evaluatePolicy`，無需 entitlement），首次認證後 Key 存入記憶體快取，同一工作階段內不再重複驗證 |
| **設定檔** | `~/.oxideterm/connections.json` — 僅儲存鑰匙圈參考 ID |
| **匯出** | .oxide: ChaCha20-Poly1305 + Argon2id，可選金鑰內嵌 |
| **記憶體** | `zeroize` 擦除敏感資料；Rust 編譯器保證記憶體安全 |
| **主機金鑰** | TOFU 模式 + `~/.ssh/known_hosts` |
| **插件** | Object.freeze + Proxy ACL、熔斷器、IPC 白名單 |

---

## 授權條款

**PolyForm Noncommercial 1.0.0**

- ✅ 個人 / 非營利使用：免費
- 🚫 商業使用：需取得商業授權
- ⚖️ 專利防禦條款 (Nuclear Clause)

完整協議：https://polyformproject.org/licenses/noncommercial/1.0.0/

---

## 致謝

- [russh](https://github.com/warp-tech/russh) — 純 Rust SSH 實作
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty) — 跨平台 PTY 抽象
- [Tauri](https://tauri.app/) — 原生應用框架
- [xterm.js](https://xtermjs.org/) — 終端模擬器
- [CodeMirror](https://codemirror.net/) — 程式碼編輯器
- [Radix UI](https://www.radix-ui.com/) — 無障礙 UI 基元

---

<p align="center">
  <sub>以 Rust 和 Tauri 建構 — 130,000+ 行程式碼</sub>
</p>
