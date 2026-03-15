<p align="center">
  <img src="../../src-tauri/icons/icon.ico" alt="OxideTerm" width="128" height="128">
</p>

<h1 align="center">⚡ OxideTerm</h1>

<p align="center">
  <strong>Rust 기반 터미널 엔진 — SSH를 넘어서</strong>
  <br>
  <em>130,000줄 이상의 Rust &amp; TypeScript 코드. Electron 없음. SSH 스택에 C 의존성 없음.</em>
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

## OxideTerm이란?

OxideTerm은 로컬 셸, 원격 SSH 세션, 파일 관리, 코드 편집, AI 어시스턴트를 하나의 Rust 네이티브 바이너리로 통합한 **크로스 플랫폼 터미널 애플리케이션**입니다. Electron 래퍼가 **아닙니다** — 백엔드 전체가 Rust로 작성되었으며, Tauri 2.0을 통해 20~35 MB의 네이티브 실행 파일로 제공됩니다.

### 왜 또 다른 터미널인가?

| 문제점 | OxideTerm의 해결책 |
|---|---|
| 로컬 셸을 지원하지 않는 SSH 클라이언트 | 하이브리드 엔진: 하나의 창에서 로컬 PTY + 원격 SSH 동시 사용 |
| 재연결 시 모든 것을 잃음 | **노드 우선 아키텍처**: Grace Period를 통한 자동 재연결로 TUI 앱 보존; 포워드, 전송, IDE 상태 복원 |
| 원격 파일 편집에 VS Code Remote 필요 | **내장 IDE 모드**: SFTP 기반 CodeMirror 6 에디터, 기본적으로 서버 설치 불필요; Linux에서는 선택적 원격 에이전트 지원 |
| SSH 연결 재사용 불가 | **SSH 다중화**: 터미널, SFTP, 포워드가 하나의 연결 공유 |
| OpenSSL에 의존하는 SSH 라이브러리 | **russh 0.54**: 순수 Rust SSH, `ring` 암호화 백엔드, C 의존성 없음 |

---

## 아키텍처 개요

```
┌─────────────────────────────────────┐
│        Frontend (React 19)          │
│                                     │
│  SessionTreeStore ──► AppStore      │    16 Zustand stores
│  IdeStore    LocalTerminalStore     │    20 component directories
│  ReconnectOrchestratorStore         │    11 languages × 21 namespaces
│  PluginStore  AiChatStore  ...      │
│                                     │
│        xterm.js 6 + WebGL           │
└──────────┬──────────────┬───────────┘
           │ Tauri IPC    │ WebSocket (binary)
┌──────────▼──────────────▼───────────┐
│         Backend (Rust)              │
│                                     │
│  NodeRouter ── resolve(nodeId) ──►  │    24 IPC command modules
│  ├─ SshConnectionRegistry          │    DashMap concurrent state
│  ├─ SessionRegistry                │    Feature-gated local PTY
│  ├─ ForwardingManager              │    ChaCha20-Poly1305 vault
│  ├─ SftpSession (connection-level) │    russh 0.54 (ring backend)
│  └─ LocalTerminalRegistry          │    SSH Agent (AgentSigner)
│                                     │
│  Wire Protocol v1                   │
│  [Type:1][Length:4][Payload:n]       │
└─────────────────────────────────────┘
```

**이중 평면 통신**: 터미널 I/O를 위한 WebSocket 바이너리 프레임(직렬화 오버헤드 제로), 구조화된 명령과 이벤트를 위한 Tauri IPC. 프론트엔드는 `sessionId`나 `connectionId`를 직접 다루지 않으며, 모든 것이 `nodeId`로 주소화되어 서버 측 `NodeRouter`가 해석합니다.

---

## 기술적 하이라이트

### 🔩 순수 Rust SSH — russh 0.54

OxideTerm은 `ring` 암호화 백엔드로 컴파일된 **russh 0.54**를 탑재합니다:
- SSH 경로에 **C/OpenSSL 의존성 제로** — 전체 암호화 스택이 Rust
- 완전한 SSH2 프로토콜: 키 교환, 채널, SFTP 서브시스템, 포트 포워딩
- ChaCha20-Poly1305 및 AES-GCM 암호 제품군, Ed25519/RSA/ECDSA 키

### 🔑 SSH Agent 인증 (AgentSigner)

시스템 SSH Agent를 래핑하고 russh의 `Signer` 트레이트를 구현하는 커스텀 `AgentSigner`:

```rust
// Solves the RPITIT Send bound issue in russh 0.54
// by cloning &PublicKey to an owned value before crossing .await
pub struct AgentSigner { /* ... */ }
impl Signer for AgentSigner { /* challenge-response via Agent IPC */ }
```

- **플랫폼**: Unix (`SSH_AUTH_SOCK`), Windows (`\\.\pipe\openssh-ssh-agent`)
- **프록시 체인**: 각 호프가 독립적으로 Agent 인증 사용 가능
- **재연결**: 재연결 시 `AuthMethod::Agent`가 자동으로 재실행

### 🧭 노드 우선 아키텍처 (NodeRouter)

**Oxide-Next 노드 추상화**는 경쟁 조건의 한 분류 전체를 제거합니다:

```
Frontend: useNodeState(nodeId) → { readiness, sftpReady, error }
Backend:  NodeRouter.resolve(nodeId) → ConnectionEntry → SftpSession
```

- 프론트엔드 SFTP/IDE 작업은 `nodeId`만 전달 — `sessionId`, `connectionId` 불필요
- 백엔드가 `nodeId → ConnectionEntry`를 원자적으로 해석
- SSH 재연결로 `connectionId`가 변경되어도 SFTP/IDE는 **영향 없음**
- `NodeEventEmitter`가 순서 보장을 위해 generation 카운터가 포함된 타입 이벤트를 전송

### ⚙️ 로컬 터미널 — 스레드 안전 PTY

`portable-pty 0.8`을 통한 크로스 플랫폼 로컬 셸, `local-terminal` 피처 게이트:

- **스레드 안전성**: `MasterPty`를 `std::sync::Mutex`로 래핑, `unsafe impl Sync`
- **전용 I/O 스레드**: 블로킹 PTY 읽기가 Tokio 이벤트 루프를 침범하지 않음
- **셸 감지**: `zsh`, `bash`, `fish`, `pwsh`, Git Bash, WSL2 자동 탐지
- **피처 게이트**: `cargo build --no-default-features`로 모바일 빌드 시 PTY 제거

### 🔌 런타임 플러그인 시스템 (v1.6.2+)

동결된 보안 강화 API를 통한 동적 플러그인 로딩:

- **PluginContext API**: 8개 네임스페이스 (terminal, ui, commands, settings, lifecycle, events, storage, system)
- **24개 UI Kit 컴포넌트**: 플러그인 샌드박스에 주입되는 사전 빌드된 React 컴포넌트
- **보안 모델**: `Object.freeze` + Proxy ACL, 서킷 브레이커, IPC 화이트리스트
- **멤브레인 아키텍처**: 플러그인이 호스트와의 제어된 브릿지를 가진 격리된 ESM 컨텍스트에서 실행

### 🛡️ SSH 연결 풀

DashMap 기반 참조 카운트 `SshConnectionRegistry`:

- 여러 터미널, SFTP, 포트 포워드가 **하나의 물리적 SSH 연결** 공유
- 연결별 독립 상태 머신 (connecting → active → idle → link_down → reconnecting)
- 유휴 타임아웃 (30분), keep-alive (15초), 하트비트 장애 감지
- WsBridge 로컬 하트비트: 30초 간격, 5분 타임아웃 (App Nap 허용)
- 유휴 타임아웃 연결 해제 시 프론트엔드 알림을 위해 `connection_status_changed` 이벤트 전송
- 캐스케이드 전파: 점프 호스트 다운 → 모든 다운스트림 노드 `link_down` 표시
- **지능형 감지**: `visibilitychange` + `online` 이벤트 → 능동적 SSH 프로브 (수동 대비 ~2초 vs 15~30초)
- **Grace Period**: 파괴적 재연결 전 기존 연결 복구를 위한 30초 대기 (yazi/vim 같은 TUI 앱 보존)

### 🔀 포트 포워딩 — 무잠금 I/O

로컬 (-L), 원격 (-R), 동적 SOCKS5 (-D) 포워딩 완벽 지원:

- **메시지 전달 아키텍처**: 단일 `ssh_io` 태스크가 SSH Channel을 소유, `Arc<Mutex<Channel>>` 불필요
- **종료 보고**: 포워드 태스크가 SSH 연결 해제 시 종료 사유를 능동적으로 보고
- **자동 복원**: `Suspended` 포워드가 재연결 시 재개
- **유휴 타임아웃**: `FORWARD_IDLE_TIMEOUT` (300초)으로 좀비 연결 방지

### 🤖 AI 터미널 어시스턴트

프라이버시 우선 설계의 이중 모드 AI:

- **인라인 패널** (`⌘I`): 빠른 명령, 괄호 붙여넣기로 삽입
- **사이드바 채팅**: 히스토리를 갖춘 지속적 대화
- **컨텍스트 캡처**: Terminal Registry가 활성 또는 전체 분할 창에서 버퍼 수집
- **멀티 소스 컨텍스트**: IDE 파일, SFTP 경로, Git 상태를 AI 대화에 자동 주입
- **도구 사용**: AI가 자율적으로 호출할 수 있는 40+ 내장 도구 (파일 작업, 프로세스 관리, 네트워크, TUI 상호작용)
- **MCP 지원**: 외부 [Model Context Protocol](https://modelcontextprotocol.io) 서버 (stdio & SSE)를 연결하여 서드파티 도구로 AI 확장 — 설정에서 관리
- **호환성**: OpenAI, Ollama, DeepSeek, OneAPI, 모든 `/v1/chat/completions` 엔드포인트
- **보안**: API 키는 OS 키체인에 저장 (macOS Keychain / Windows Credential Manager); macOS에서는 읽기 시 `LAContext`를 통한 **Touch ID** 인증 — 엔타이틀먼트나 코드 서명 불필요

### 💻 IDE 모드 — 원격 편집

SFTP 기반 CodeMirror 6 에디터 — 기본적으로 서버 측 설치 불필요; Linux에서는 향상된 기능을 위한 선택적 경량 원격 에이전트를 지원합니다:

- **파일 트리**: Git 상태 표시기가 포함된 지연 로딩
- **30+ 언어 모드**: 16개 네이티브 CodeMirror + 레거시 모드
- **충돌 해결**: 낙관적 mtime 잠금
- **이벤트 기반 Git**: 저장, 생성, 삭제, 이름 변경, 터미널 Enter 시 자동 새로고침
- **상태 게이팅**: `readiness !== 'ready'`일 때 I/O 차단, 재연결 시 Key-Driven Reset
- **Linux 원격 에이전트 (선택적)**: ~1 MB Rust 바이너리, x86_64/aarch64에서 자동 배포. 추가 아키텍처 (ARMv7, RISC-V64, LoongArch64, s390x 등)는 `agents/extra/`에서 수동 업로드 가능

### 🔐 .oxide 암호화 내보내기

이식 가능한 연결 백업 형식:

- **ChaCha20-Poly1305 AEAD** 인증 암호화
- **Argon2id KDF** (256 MB 메모리, 4회 반복) — GPU 무차별 대입 공격 저항
- **SHA-256** 무결성 체크섬
- **선택적 키 임베딩**: 개인 키를 base64 인코딩하여 암호화 페이로드에 포함
- **사전 분석**: 인증 유형 분류, 누락 키 감지

### 📡 ProxyJump — 토폴로지 인식 멀티 홉

- 무제한 체인 깊이: `Client → Jump A → Jump B → … → Target`
- SSH Config 자동 파싱, 토폴로지 그래프 구축, Dijkstra 경로 계산
- 점프 노드를 독립 세션으로 재사용 가능
- 캐스케이드 장애 전파 및 다운스트림 상태 자동 동기화

### 📊 리소스 프로파일러

지속적 SSH 셸 채널을 통한 원격 호스트 실시간 모니터링:

- `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/net/dev` 읽기
- 델타 기반 CPU% 및 네트워크 처리량 계산
- 단일 채널 — MaxSessions 고갈 방지
- 비 Linux 환경이나 연속 실패 시 RTT 전용으로 자동 격하

### 🖼️ 배경 이미지 갤러리

탭별 투명도 제어가 가능한 다중 이미지 배경 시스템:

- **갤러리 관리**: 여러 이미지 업로드, 썸네일 클릭으로 전환, 개별 또는 일괄 삭제
- **마스터 토글**: 이미지 삭제 없이 배경을 전역적으로 활성화/비활성화
- **탭별 제어**: 13가지 탭 유형 개별 토글 (터미널, SFTP, IDE, 설정, 토폴로지 등)
- **커스터마이징**: 불투명도 (3~50%), 블러 (0~20px), 맞춤 모드 (cover/contain/fill/tile)
- **플랫폼 인식**: macOS 투명도 지원; Windows WSLg 경로 제외 (불투명 VNC 캔버스)
- **보안**: 경로 정규화 삭제로 디렉터리 탐색 방지; Rust 백엔드에서의 완전한 오류 전파

### 🏎️ 적응형 렌더링 — 동적 리프레시 레이트

고정 RAF 일괄 처리를 대체하는 3단계 렌더 스케줄러로, 대량 출력 시 응답성을 개선하고 유휴 시 GPU/배터리 부하를 줄입니다:

| 단계 | 트리거 | 실효 레이트 | 이점 |
|---|---|---|---|
| **Boost** | 프레임 데이터 ≥ 4 KB | 120 Hz+ (RAF / ProMotion 네이티브) | 빠른 출력 시 스크롤 지연 제거 |
| **Normal** | 일반 입력 / 경량 I/O | 60 Hz (RAF) | 부드러운 기본 상호작용 |
| **Idle** | 3초간 I/O 없음, 페이지 숨김, 또는 창 포커스 해제 | 1~15 Hz (타이머, 지수 증가) | GPU 부하 거의 제로, 배터리 절약 |

- **자동 모드**: 데이터 양, 사용자 입력, Page Visibility API에 의한 전환 — 수동 조정 불필요
- **백그라운드 안전**: 탭이 숨겨져 있을 때 수신 원격 데이터가 유휴 타이머로 계속 처리 — RAF를 깨우지 않아 백그라운드 탭에서 대기 버퍼 누적 방지
- **설정**: 3가지 모드 (자동 / 항상 60 Hz / 끄기) — 설정 → 터미널 → 렌더러
- **실시간 진단**: **FPS 오버레이 표시**를 활성화하면 터미널 모서리에 실시간 단계 배지 (`B`=boost · `N`=normal · `I`=idle), 프레임 레이트, 초당 쓰기 수 카운터가 표시

### 🎨 커스텀 테마 엔진

프리셋 팔레트를 넘어서는 완전한 테마 커스터마이징:

- **30+ 내장 테마**: Oxide, Dracula, Nord, Catppuccin, Spring Rice, Tokyo Night 등
- **커스텀 테마 에디터**: 모든 필드에 대한 시각적 컬러 피커 + 16진수 RGB 입력
- **터미널 색상**: 22가지 xterm.js 필드 전체 (배경, 전경, 커서, 선택, 16 ANSI 색상)
- **UI 크롬 색상**: 5개 카테고리에 걸친 19가지 CSS 변수 — 배경 (5), 텍스트 (3), 테두리 (3), 액센트 (4), 시맨틱 상태 색상 (4)
- **자동 생성**: 터미널 팔레트에서 원클릭으로 UI 색상 생성
- **실시간 미리보기**: 편집 중 실시간 미니 터미널 + UI 크롬 미리보기
- **복제 & 확장**: 내장 또는 커스텀 테마를 복제하여 새 테마 생성
- **영구 저장**: 커스텀 테마가 localStorage에 저장되어 앱 업데이트 후에도 유지

### 🪟 Windows 심층 최적화

- **네이티브 ConPTY 통합**: Windows Pseudo Console (ConPTY) API를 직접 호출하여 완벽한 TrueColor 및 ANSI 이스케이프 시퀀스 지원 — 구식 WinPTY 미사용.
- **지능형 셸 감지**: 내장 스캐너가 레지스트리 및 PATH를 통해 **PowerShell 7 (pwsh)**, **Git Bash**, **WSL2**, 레거시 CMD를 자동 감지.
- **네이티브 경험**: Rust가 윈도우 이벤트를 직접 처리 — Electron 앱보다 훨씬 빠른 응답 속도.

### 📊 백엔드 스크롤 버퍼

- **대용량 영속성**: 기본 **100,000줄**의 터미널 출력, 디스크에 직렬화 가능 (MessagePack 형식).
- **고성능 검색**: `spawn_blocking`으로 정규식 검색 태스크를 격리하여 Tokio 런타임 블로킹 방지.
- **메모리 효율**: 순환 버퍼 설계로 가장 오래된 데이터를 자동 제거하여 메모리 사용량 제어.

### ⚛️ 멀티 스토어 상태 아키텍처

프론트엔드는 **멀티 스토어** 패턴 (16개 스토어)을 채택하여 크게 다른 상태 도메인을 처리합니다:

| 스토어 | 역할 |
|---|---|
| **SessionTreeStore** | 사용자 의도 — 트리 구조, 연결 흐름, 세션 구성 |
| **AppStore** | 사실 계층 — `connections` Map을 통한 실제 SSH 연결 상태, SessionTreeStore에서 동기화 |
| **IdeStore** | IDE 모드 — 원격 파일 편집, Git 상태, 멀티 탭 에디터 |
| **LocalTerminalStore** | 로컬 PTY 라이프사이클, 셸 프로세스 모니터링, 독립 I/O |
| **ReconnectOrchestratorStore** | 자동 재연결 파이프라인 (snapshot → grace-period → ssh-connect → await-terminal → restore) |
| **TransferStore** | SFTP 전송 큐 및 진행 상황 |
| **PluginStore** | 플러그인 런타임 상태 및 UI 레지스트리 |
| **ProfilerStore** | 리소스 프로파일러 메트릭 |
| **AiChatStore** | AI 채팅 대화 상태 |
| **SettingsStore** | 앱 설정 |
| **BroadcastStore** | 브로드캐스트 입력 — 여러 창에 키 입력 복제 |
| **CommandPaletteStore** | 커맨드 팔레트 열기/닫기 상태 |
| **EventLogStore** | 연결 라이프사이클 및 재연결 이벤트 로그 |
| **LauncherStore** | 플랫폼 앱 런처 상태 |
| **RecordingStore** | 터미널 세션 녹화 및 재생 |
| **UpdateStore** | 자동 업데이트 라이프사이클 (check → download → install) |

상태 소스가 다르지만 렌더링 로직은 `TerminalView`와 `IdeView` 컴포넌트를 통해 통합됩니다.

---

## 기술 스택

| 계층 | 기술 | 세부사항 |
|---|---|---|
| **프레임워크** | Tauri 2.0 | 네이티브 바이너리, ~15 MB, Electron 없음 |
| **런타임** | Tokio + DashMap 6 | 완전 비동기 + 무잠금 동시 맵 |
| **SSH** | russh 0.54 (`ring`) | 순수 Rust, C 의존성 없음, SSH Agent |
| **로컬 PTY** | portable-pty 0.8 | 피처 게이트, Windows에서 ConPTY |
| **프론트엔드** | React 19.1 + TypeScript 5.8 | Vite 7, Tailwind CSS 4 |
| **상태** | Zustand 5 | 16개 특수 스토어, 이벤트 기반 동기화 |
| **터미널** | xterm.js 6 + WebGL | GPU 가속, 60fps+ |
| **에디터** | CodeMirror 6 | 16 언어 팩 + 레거시 모드 |
| **암호화** | ChaCha20-Poly1305 + Argon2id | AEAD + 메모리 하드 KDF |
| **저장소** | redb 2.1 | 세션, 포워드, 전송용 임베디드 DB |
| **직렬화** | MessagePack (rmp-serde) | 바이너리 버퍼/상태 영속성 |
| **i18n** | i18next 25 | 11개 언어 × 21개 네임스페이스 |
| **SFTP** | russh-sftp 2.0 | SSH File Transfer Protocol |
| **WebSocket** | tokio-tungstenite 0.24 | 터미널 데이터 플레인용 비동기 WebSocket |
| **프로토콜** | Wire Protocol v1 | WebSocket 상의 바이너리 `[Type:1][Length:4][Payload:n]` |
| **플러그인** | ESM Runtime | 동결된 PluginContext + 24 UI Kit 컴포넌트 |

---

## 기능 매트릭스

| 카테고리 | 기능 |
|---|---|
| **터미널** | 로컬 PTY, SSH 원격, 분할 창 (수평/수직), 세션 녹화/재생 (asciicast v2), 크로스 창 AI 컨텍스트, WebGL 렌더링, 배경 이미지 갤러리, 30+ 테마 + 커스텀 테마 에디터, 커맨드 팔레트 (`⌘K`), 젠 모드 (`⌘⇧Z`), 글꼴 크기 단축키 (`⌘+`/`⌘-`) |
| **SSH** | 연결 풀, 다중화, ProxyJump (∞ 홉), 토폴로지 그래프, 자동 재연결 파이프라인 |
| **인증** | 비밀번호, SSH 키 (RSA/Ed25519/ECDSA), SSH Agent, 인증서, Keyboard-Interactive (2FA), Known Hosts |
| **파일** | 이중 창 SFTP 브라우저, 드래그 앤 드롭, 미리보기 (이미지/비디오/오디오/PDF/코드/Hex), 전송 큐 |
| **IDE** | 파일 트리, CodeMirror 에디터, 멀티 탭, Git 상태, 충돌 해결, 통합 터미널 |
| **포워딩** | 로컬 (-L), 원격 (-R), 동적 SOCKS5 (-D), 자동 복원, 종료 보고, 무잠금 I/O |
| **AI** | 인라인 패널 + 사이드바 채팅, SSE 스트리밍, 코드 삽입, 40+ 도구 사용, MCP 서버 통합, 멀티 소스 컨텍스트, OpenAI/Ollama/DeepSeek |
| **플러그인** | 런타임 ESM 로딩, 8 API 네임스페이스, 24 UI Kit, 샌드박스, 서킷 브레이커 |
| **WSL Graphics** ⚠️ | 내장 VNC 뷰어 (실험적): 데스크톱 모드 (9 DE) + 앱 모드 (단일 GUI 앱), WSLg 감지, Xtigervnc + noVNC, 재연결, 피처 게이트 |
| **보안** | .oxide 암호화, OS 키체인, `zeroize` 메모리, 호스트 키 TOFU |
| **i18n** | EN, 简体中文, 繁體中文, 日本語, FR, DE, ES, IT, 한국어, PT-BR, VI |

---

## 주요 기능 상세

### 🚀 하이브리드 터미널 경험
- **제로 레이턴시 로컬 셸**: 로컬 프로세스와 직접 IPC, 거의 제로 지연.
- **고성능 원격 SSH**: WebSocket 바이너리 스트림, 기존 HTTP 오버헤드 우회.
- **완전한 환경 상속**: PATH, HOME 및 모든 환경 변수 상속 — 시스템 터미널과 동일한 경험.

### 🔐 다양한 인증 방식
- **비밀번호**: 시스템 키체인에 안전하게 저장.
- **키 인증**: RSA / Ed25519 / ECDSA, `~/.ssh/id_*` 자동 스캔.
- **SSH Agent**: `AgentSigner`를 통한 시스템 에이전트 (macOS/Linux/Windows).
- **인증서**: OpenSSH Certificates.
- **2FA/MFA**: Keyboard-Interactive 인증.
- **Known Hosts**: TOFU 및 `~/.ssh/known_hosts`를 통한 호스트 키 검증.

### 🔍 전문 검색
프로젝트 전체 파일 내용 검색 및 지능형 캐싱:
- **실시간 검색**: 300ms 디바운스 입력으로 즉시 결과.
- **결과 캐싱**: 반복 스캔 방지를 위한 60초 TTL 캐시.
- **결과 그룹화**: 줄 번호 위치와 함께 파일별 그룹화.
- **하이라이트 매칭**: 미리보기 스니펫에서 검색어 하이라이트.
- **자동 초기화**: 파일 변경 시 캐시 무효화.

### 📦 고급 파일 관리
- **SFTP v3 프로토콜**: 완전한 이중 창 파일 관리자.
- **드래그 앤 드롭**: 다중 파일 및 폴더 일괄 작업.
- **지능형 미리보기**:
  - 🎨 이미지 (JPEG/PNG/GIF/WebP)
  - 🎬 비디오 (MP4/WebM) 내장 플레이어
  - 🎵 오디오 (MP3/WAV/OGG/FLAC) 메타데이터 표시
  - 💻 코드 하이라이팅 (30+ 언어)
  - 📄 PDF 문서
  - 🔍 Hex 뷰어 (바이너리 파일)
- **진행 상황 추적**: 실시간 속도, 진행 바, ETA.

### 🌍 국제화 (i18n)
- **11개 언어**: English, 简体中文, 繁體中文, 日本語, Français, Deutsch, Español, Italiano, 한국어, Português, Tiếng Việt.
- **동적 로딩**: i18next를 통한 온디맨드 언어 팩.
- **타입 안전**: 모든 번역 키에 대한 TypeScript 정의.

### 🌐 네트워크 최적화
- **이중 평면 아키텍처**: 데이터 플레인 (WebSocket 직접) 및 컨트롤 플레인 (Tauri IPC) 분리.
- **커스텀 바이너리 프로토콜**: `[Type:1][Length:4][Payload:n]`, JSON 직렬화 오버헤드 없음.
- **백프레셔 제어**: 버스트 트래픽 시 메모리 오버플로 방지.
- **자동 재연결**: 지수 백오프 재시도, 최대 5회.

### 🖥️ WSL Graphics (⚠️ 실험적)
- **데스크톱 모드**: 터미널 탭 내에서 전체 Linux GUI 데스크톱 — 9가지 데스크톱 환경 (Xfce / GNOME / KDE Plasma / MATE / LXDE / Cinnamon / Openbox / Fluxbox / IceWM), 자동 감지.
- **앱 모드**: 전체 데스크톱 없이 단일 GUI 애플리케이션 실행 (예: `gedit`, `firefox`) — 경량 Xtigervnc + 선택적 Openbox WM, 앱 종료 시 자동 정리.
- **WSLg 감지**: 배포판별 WSLg 가용성 (Wayland / X11 소켓) 자동 감지, UI에 배지로 표시.
- **Xtigervnc + noVNC**: 인앱 `<canvas>`로 렌더링되는 독립 X 서버, `scaleViewport` 및 `resizeSession` 지원.
- **보안**: `argv` 배열 주입 (셸 파싱 없음), `env_clear()` + 최소 화이트리스트, `validate_argv()` 6규칙 방어, 동시성 제한 (배포판당 4 앱 세션, 전역 8).
- **재연결**: VNC 세션 종료 없이 WebSocket 브릿지 재연결.
- **피처 게이트**: `wsl-graphics` Cargo 피처, 비 Windows 플랫폼에서는 스텁 명령.

---

## 빠른 시작

### 사전 요구사항

- **Rust** 1.75+
- **Node.js** 18+ (pnpm 권장)
- **플랫폼 도구**:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio C++ Build Tools
  - Linux: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`

### 개발

```bash
git clone https://github.com/AnalyseDeCircuit/OxideTerm.git
cd OxideTerm && pnpm install

# 전체 앱 (프론트엔드 + Rust 백엔드 + 로컬 PTY)
pnpm tauri dev

# 프론트엔드만 (포트 1420에서 핫 리로드)
pnpm dev

# 프로덕션 빌드
pnpm tauri build

# 경량 커널 — 모바일용 로컬 PTY 제거
cd src-tauri && cargo build --no-default-features --release
```

---

## 프로젝트 구조

```
OxideTerm/
├── src/                            # 프론트엔드 — 83K줄 TypeScript
│   ├── components/                 # 20개 디렉터리
│   │   ├── terminal/               #   터미널 뷰, 분할 창, 검색
│   │   ├── sftp/                   #   이중 창 파일 브라우저
│   │   ├── ide/                    #   에디터, 파일 트리, Git 다이얼로그
│   │   ├── ai/                     #   인라인 + 사이드바 채팅
│   │   ├── graphics/               #   WSL Graphics (VNC 데스크톱 + 앱 뷰어)
│   │   ├── plugin/                 #   플러그인 관리자 & 런타임 UI
│   │   ├── forwards/               #   포트 포워딩 관리
│   │   ├── connections/            #   연결 CRUD & 가져오기
│   │   ├── topology/               #   네트워크 토폴로지 그래프
│   │   ├── layout/                 #   사이드바, 헤더, 분할 창
│   │   └── ...                     #   sessions, settings, modals 등
│   ├── store/                      # 16 Zustand 스토어
│   ├── lib/                        # API 계층, AI 프로바이더, 플러그인 런타임
│   ├── hooks/                      # React 훅 (이벤트, 키보드, 토스트)
│   ├── types/                      # TypeScript 타입 정의
│   └── locales/                    # 11개 언어 × 21개 네임스페이스
│
├── src-tauri/                      # 백엔드 — 51K줄 Rust
│   └── src/
│       ├── router/                 #   NodeRouter (nodeId → 리소스)
│       ├── ssh/                    #   SSH 클라이언트 (Agent 포함 12 모듈)
│       ├── local/                  #   로컬 PTY (피처 게이트)
│       ├── graphics/               #   WSL Graphics (피처 게이트)
│       ├── bridge/                 #   WebSocket 브릿지 & Wire Protocol v1
│       ├── session/                #   세션 관리 (16 모듈)
│       ├── forwarding/             #   포트 포워딩 (6 모듈)
│       ├── sftp/                   #   SFTP 구현
│       ├── config/                 #   Vault, 키체인, SSH config
│       ├── oxide_file/             #   .oxide 암호화 (ChaCha20)
│       ├── commands/               #   24 Tauri IPC 명령 모듈
│       └── state/                  #   글로벌 상태 타입
│
└── docs/                           # 27+ 아키텍처 & 기능 문서
```

---

## 로드맵

### ✅ 출시 완료 (v0.14.0)

- [x] 피처 게이팅을 통한 로컬 터미널 (PTY)
- [x] SSH 연결 풀 & 다중화
- [x] SSH Agent 인증 (AgentSigner)
- [x] 노드 우선 아키텍처 (NodeRouter + 이벤트)
- [x] 자동 재연결 오케스트레이터 (Grace Period 포함 8단계 파이프라인)
- [x] ProxyJump 무제한 배스천 체인
- [x] 포트 포워딩 — 로컬 / 원격 / 동적 SOCKS5
- [x] SFTP 이중 창 파일 관리자 및 미리보기
- [x] IDE 모드 (CodeMirror 6 + Git 상태)
- [x] .oxide 암호화 내보내기 및 키 임베딩
- [x] AI 터미널 어시스턴트 (인라인 + 사이드바)
- [x] AI 도구 사용 — 자동 승인 제어가 포함된 40+ 내장 도구
- [x] AI 멀티 소스 컨텍스트 주입 (IDE / SFTP / Git)
- [x] MCP (Model Context Protocol) — stdio & SSE 전송, 설정 UI, 서버별 도구 탐색
- [x] 런타임 플러그인 시스템 (PluginContext + UI Kit)
- [x] 키보드 단축키를 통한 터미널 분할 창
- [x] 리소스 프로파일러 (CPU / 메모리 / 네트워크)
- [x] i18n — 11개 언어 × 21개 네임스페이스
- [x] Keyboard-Interactive 인증 (2FA/MFA)
- [x] 딥 히스토리 검색 (30K줄, Rust 정규식)
- [x] WSL Graphics — 데스크톱 모드 + 앱 모드 VNC 뷰어 (⚠️ 실험적)
- [x] 배경 이미지 갤러리 — 다중 이미지 업로드, 탭별 제어, 마스터 토글
- [x] 향상된 미디어 미리보기 — SFTP 브라우저에서 오디오/비디오 재생
- [x] 세션 녹화 & 재생
- [x] 커스텀 테마 엔진 — 30+ 내장 테마, 16진수 입력 시각적 에디터, 22 터미널 + 19 UI 색상 필드
- [x] 커맨드 팔레트 (`⌘K`) — 연결, 동작, 설정에 대한 퍼지 검색
- [x] 젠 모드 (`⌘⇧Z`) — 방해 없는 전체 화면 터미널, 사이드바 및 탭 바 숨김
- [x] 터미널 글꼴 크기 단축키 (`⌘+` / `⌘-` / `⌘0`) 실시간 PTY 리핏

### 🚧 진행 중

- [ ] 세션 검색 & 빠른 전환

### 📋 계획됨

- [ ] SSH Agent 포워딩

---

## 보안

| 항목 | 구현 |
|---|---|
| **비밀번호** | OS 키체인 (macOS Keychain / Windows Credential Manager / Linux libsecret) |
| **AI API 키** | `com.oxideterm.ai` 서비스 하의 OS 키체인; macOS에서는 키 읽기에 **Touch ID** 필요 (`LocalAuthentication.framework`를 통한 생체 인증, data-protection 엔타이틀먼트 불필요) — 키는 첫 인증 후 메모리에 캐시되어 세션당 Touch ID 한 번만 표시 |
| **설정 파일** | `~/.oxideterm/connections.json` — 키체인 참조 ID만 저장 |
| **내보내기** | .oxide: ChaCha20-Poly1305 + Argon2id, 선택적 키 임베딩 |
| **메모리** | `zeroize`로 민감 데이터 삭제; Rust가 메모리 안전성 보장 |
| **호스트 키** | `~/.ssh/known_hosts`를 통한 TOFU |
| **플러그인** | Object.freeze + Proxy ACL, 서킷 브레이커, IPC 화이트리스트 |

---

## 라이선스

**PolyForm Noncommercial 1.0.0**

- ✅ 개인 / 비영리 사용: 무료
- 🚫 상업적 사용: 라이선스 필요
- ⚖️ 특허 방어 조항 (Nuclear Clause)

전문: https://polyformproject.org/licenses/noncommercial/1.0.0/

---

## 감사의 글

- [russh](https://github.com/warp-tech/russh) — 순수 Rust SSH
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty) — 크로스 플랫폼 PTY
- [Tauri](https://tauri.app/) — 네이티브 앱 프레임워크
- [xterm.js](https://xtermjs.org/) — 터미널 에뮬레이터
- [CodeMirror](https://codemirror.net/) — 코드 에디터
- [Radix UI](https://www.radix-ui.com/) — 접근성 UI 프리미티브

---

<p align="center">
  <sub>Rust와 Tauri로 구축 — 130,000줄 이상의 코드</sub>
</p>
