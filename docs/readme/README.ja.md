<p align="center">
  <img src="../../src-tauri/icons/icon.ico" alt="OxideTerm" width="128" height="128">
</p>

<h1 align="center">⚡ OxideTerm</h1>

<p align="center">
  <strong>Rustで駆動するターミナルエンジン — SSHを超えて</strong>
  <br>
  <em>130,000行以上のRust &amp; TypeScriptコード。Electron不要。SSHスタックにC依存なし。</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.19.2-blue" alt="Version">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blueviolet" alt="License">
  <img src="https://img.shields.io/badge/rust-1.75+-orange" alt="Rust">
  <img src="https://img.shields.io/badge/tauri-2.0-purple" alt="Tauri">
</p>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-Hans.md">简体中文</a> | <a href="README.zh-Hant.md">繁體中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

---

<p align="center">
  <img src="../media/ai-terminal-demo.gif" alt="OxideTerm AI デモ">
</p>
<p align="center"><em>🤖 AI アシスタント —「ローカルターミナルを開いて echo hello, world! を実行」</em></p>

## OxideTermとは？

OxideTermは、ローカルシェル、リモートSSHセッション、ファイル管理、コード編集、AI支援を単一のRustネイティブバイナリに統合した**クロスプラットフォームターミナルアプリケーション**です。Electronラッパー**ではありません** — バックエンド全体がRustで書かれており、Tauri 2.0経由で20〜35 MBのネイティブ実行ファイルとして提供されます。

### なぜ新しいターミナルが必要なのか？

| 課題 | OxideTermの解決策 |
|---|---|
| ローカルシェルが使えないSSHクライアント | ハイブリッドエンジン：ローカルPTY + リモートSSHを一つのウィンドウで |
| 再接続するとすべてが失われる | **Node-firstアーキテクチャ**：Grace Period付き自動再接続でTUIアプリを保持、フォワーディング・転送・IDEの状態を復元 |
| リモートファイル編集にVS Code Remoteが必要 | **内蔵IDEモード**：CodeMirror 6エディタをSFTP経由で動作、デフォルトでサーバーインストール不要；Linuxではオプションのリモートエージェントに対応 |
| SSHの接続再利用ができない | **SSH多重化**：ターミナル、SFTP、フォワーディングが一つの接続を共有 |
| SSHライブラリがOpenSSLに依存 | **russh 0.54**：純粋なRust SSH、`ring`暗号バックエンド、C依存なし |

---

## アーキテクチャ概観

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

**デュアルプレーン通信**：ターミナルI/OにはWebSocketバイナリフレーム（シリアライゼーションオーバーヘッドゼロ）、構造化コマンドとイベントにはTauri IPC。フロントエンドは`sessionId`や`connectionId`に直接触れません — すべて`nodeId`でアドレッシングされ、サーバー側の`NodeRouter`が解決します。

---

## 技術的ハイライト

### 🔩 純粋Rust SSH — russh 0.54

OxideTermは`ring`暗号バックエンドに対しコンパイルされた**russh 0.54**を搭載：
- SSHパスにおいて**C/OpenSSL依存ゼロ** — 暗号スタック全体がRust
- 完全なSSH2プロトコル：鍵交換、チャネル、SFTPサブシステム、ポートフォワーディング
- ChaCha20-Poly1305およびAES-GCM暗号スイート、Ed25519/RSA/ECDSA鍵

### 🔑 SSH Agent認証（AgentSigner）

カスタム`AgentSigner`がシステムSSH Agentをラップし、russhの`Signer`トレイトを実装：

```rust
// Solves the RPITIT Send bound issue in russh 0.54
// by cloning &PublicKey to an owned value before crossing .await
pub struct AgentSigner { /* ... */ }
impl Signer for AgentSigner { /* challenge-response via Agent IPC */ }
```

- **プラットフォーム**：Unix（`SSH_AUTH_SOCK`）、Windows（`\\.\pipe\openssh-ssh-agent`）
- **プロキシチェーン**：各ホップが独立してAgent認証を使用可能
- **再接続**：再接続時に`AuthMethod::Agent`を自動リプレイ

### 🧭 Node-Firstアーキテクチャ（NodeRouter）

**Oxide-Next Nodeアブストラクション**は競合状態の一つのクラス全体を排除：

```
Frontend: useNodeState(nodeId) → { readiness, sftpReady, error }
Backend:  NodeRouter.resolve(nodeId) → ConnectionEntry → SftpSession
```

- フロントエンドのSFTP/IDE操作は`nodeId`のみを渡す — `sessionId`も`connectionId`も不要
- バックエンドが`nodeId → ConnectionEntry`をアトミックに解決
- SSH再接続で`connectionId`が変わっても — SFTP/IDEは**影響を受けない**
- `NodeEventEmitter`がジェネレーションカウンター付きの型付きイベントをプッシュし順序を保証

### ⚙️ ローカルターミナル — スレッドセーフPTY

`portable-pty 0.8`によるクロスプラットフォームローカルシェル、`local-terminal`フィーチャーゲート付き：

- **スレッドセーフ**：`MasterPty`を`std::sync::Mutex`でラップし`unsafe impl Sync`
- **専用I/Oスレッド**：ブロッキングPTY読み取りがTokioイベントループに触れない
- **シェル検出**：`zsh`、`bash`、`fish`、`pwsh`、Git Bash、WSL2を自動検出
- **フィーチャーゲート**：`cargo build --no-default-features`でモバイルビルド向けにPTYを除外

### 🔌 ランタイムプラグインシステム（v1.6.2+）

セキュリティ強化された凍結APIによる動的プラグインローディング：

- **PluginContext API**：8つのネームスペース（terminal, ui, commands, settings, lifecycle, events, storage, system）
- **24のUIキットコンポーネント**：プラグインサンドボックスに注入される事前構築されたReactコンポーネント
- **セキュリティモデル**：`Object.freeze` + Proxy ACL、サーキットブレーカー、IPCホワイトリスト
- **メンブレンアーキテクチャ**：プラグインはホストへの制御されたブリッジを持つ独立したESMコンテキストで実行

### 🛡️ SSH接続プール

DashMapを使用した参照カウント型`SshConnectionRegistry`：

- 複数のターミナル、SFTP、ポートフォワーディングが**一つの物理SSH接続**を共有
- 接続ごとの独立した状態マシン（connecting → active → idle → link_down → reconnecting）
- アイドルタイムアウト（30分）、キープアライブ（15秒）、ハートビート障害検出
- WsBridgeローカルハートビート：30秒間隔、5分タイムアウト（App Napに対応）
- アイドルタイムアウト切断時にフロントエンドへ`connection_status_changed`を通知
- カスケード伝播：踏み台ホストのダウン → すべての下流ノードが`link_down`にマーク
- **インテリジェント検出**：`visibilitychange` + `online`イベント → プロアクティブSSHプローブ（受動的な15〜30秒に対し約2秒）
- **Grace Period**：破壊的再接続の前に既存の接続を回復するための30秒ウィンドウ（yazi/vimなどのTUIアプリを保持）

### 🔀 ポートフォワーディング — ロックフリーI/O

ローカル（-L）、リモート（-R）、ダイナミックSOCKS5（-D）の完全なフォワーディング：

- **メッセージパッシングアーキテクチャ**：SSH Channelは単一の`ssh_io`タスクが所有、`Arc<Mutex<Channel>>`不要
- **終了報告**：フォワーディングタスクがSSH切断時に終了理由をアクティブに報告
- **自動復元**：`Suspended`状態のフォワーディングが再接続時に再開
- **アイドルタイムアウト**：`FORWARD_IDLE_TIMEOUT`（300秒）がゾンビ接続を防止

### 🤖 AIターミナルアシスタント

プライバシーファーストの設計によるデュアルモードAI：

- **インラインパネル**（`⌘I`）：クイックコマンド、ブラケットペーストで注入
- **サイドバーチャット**：履歴付きの持続的な会話
- **コンテキスト取得**：Terminal Registryがアクティブまたは全分割ペインからバッファを収集
- **マルチソースコンテキスト**：IDEファイル、SFTPパス、Gitステータスを自動的にAI会話に注入
- **ツール利用**：40以上の組み込みツール（ファイル操作、プロセス管理、ネットワーク、TUI操作）をAIが自律的に実行
- **MCPサポート**：外部の[Model Context Protocol](https://modelcontextprotocol.io)サーバー（stdio & SSE）を接続してサードパーティツールでAIを拡張 — 設定で管理
- **互換性**：OpenAI、Ollama、DeepSeek、OneAPI、任意の`/v1/chat/completions`エンドポイント
- **セキュア**：APIキーはOSキーチェーン（macOS Keychain / Windows Credential Manager）に保存；macOSでは読み取りに**Touch ID**認証が必要（`LAContext`によるバイオメトリクスゲート — エンタイトルメントやコード署名は不要）

### � RAG 運用ナレッジベース (v0.20)

ローカルファーストの検索拡張生成システム、運用ドキュメント向け：

- **ドキュメントコレクション**：Markdown/TXT 形式のランブック、SOP、デプロイガイドをスコープ別コレクションにインポート（グローバルまたは接続単位）
- **ハイブリッド検索**：BM25 キーワードインデックス + ベクトルコサイン類似度、Reciprocal Rank Fusion (RRF) で統合
- **Markdown 対応チャンキング**：見出し階層で分割、セクションパスを保持（例：「デプロイ > Docker > トラブルシューティング」）
- **CJK サポート**：中日韓バイグラムトークナイザー + ラテン文字空白分割
- **AI 統合**：`search_docs` ツールが AI 会話中に関連ドキュメントを自動検索——手動操作不要
- **外部編集**：システムエディタでドキュメントを開き、ウィンドウフォーカス時に自動同期、楽観的バージョンロック
- **リインデックス**：BM25 完全再構築、リアルタイムプログレスバー、キャンセル対応
- **エンベディングパイプライン**：フロントエンドが AI プロバイダー経由でベクトルを生成、バックエンドに保存してハイブリッド検索を実現
- **ストレージ**：redb 組み込みデータベース、9 テーブル、MessagePack シリアライゼーション、大容量チャンク自動圧縮

### �💻 IDEモード — リモート編集

SFTP経由のCodeMirror 6エディタ — デフォルトではサーバー側のインストール不要；Linuxでは軽量リモートエージェントのオプション対応で拡張機能を提供：

- **ファイルツリー**：Git状態インジケーター付き遅延読み込み
- **30以上の言語モード**：16のネイティブCodeMirror + レガシーモード
- **コンフリクト解決**：楽観的mtimeロッキング
- **イベント駆動Git**：保存、作成、削除、リネーム、ターミナルEnterで自動リフレッシュ
- **State Gating**：`readiness !== 'ready'`の場合にIOをブロック、再接続時にKey-Driven Reset
- **Linuxリモートエージェント（オプション）**：約1 MBのRustバイナリ、x86_64/aarch64で自動デプロイ。追加アーキテクチャ（ARMv7、RISC-V64、LoongArch64、s390xなど）は`agents/extra/`で手動アップロード可能

### 🔐 .oxide暗号化エクスポート

ポータブルな接続バックアップ形式：

- **ChaCha20-Poly1305 AEAD**認証暗号化
- **Argon2id KDF**（256 MBメモリ、4イテレーション）— GPU総当たり攻撃耐性
- **SHA-256**整合性チェックサム
- **オプションの鍵埋め込み**：秘密鍵をbase64エンコードして暗号化ペイロードに内包
- **事前フライト分析**：認証タイプの内訳、不足キーの検出

### 📡 ProxyJump — トポロジー対応マルチホップ

- 無制限のチェーン深度：`Client → Jump A → Jump B → … → Target`
- SSH Config自動解析、トポロジーグラフ構築、Dijkstra経路計算
- 踏み台ノードを独立セッションとして再利用可能
- 自動下流状態同期によるカスケード障害伝播

### 📊 リソースプロファイラ

持続的SSHシェルチャネルによるリモートホストのライブ監視：

- `/proc/stat`、`/proc/meminfo`、`/proc/loadavg`、`/proc/net/dev`を読み取り
- デルタベースのCPU%およびネットワークスループット計算
- 単一チャネル — MaxSessonsの枯渇を回避
- 非Linuxまたは連続失敗時にRTTのみモードに自動デグレード

### 🖼️ 背景画像ギャラリー

タブごとの透過制御を備えたマルチ画像背景システム：

- **ギャラリー管理**：複数画像のアップロード、サムネイルクリックで切替、画像ごとの削除または一括クリア
- **マスタートグル**：画像を削除せずにグローバルで背景を有効/無効化
- **タブごとの制御**：13種類のタブタイプを個別に切替可能（ターミナル、SFTP、IDE、設定、トポロジーなど）
- **カスタマイズ**：不透明度（3〜50％）、ブラー（0〜20px）、フィットモード（cover/contain/fill/tile）
- **プラットフォーム対応**：macOS透過サポート；Windows WSLgパスは除外（不透明なVNCキャンバス）
- **セキュリティ**：パス正規化による削除でディレクトリトラバーサルを防止；Rustバックエンドからの完全なエラー伝播

### 🖥️ アダプティブレンダリング — 動的リフレッシュレート

固定RAFバッチングに代わる3段階レンダースケジューラ。大量出力時の応答性を向上させ、アイドル時のGPU/バッテリー消費を削減：

| 段階 | トリガー | 実効レート | メリット |
|---|---|---|---|
| **Boost** | フレームデータ ≥ 4 KB | 120 Hz+（RAF / ProMotionネイティブ） | 高速出力時のスクロール遅延を解消 |
| **Normal** | 標準的な入力 / 軽量I/O | 60 Hz（RAF） | スムーズなベースラインインタラクション |
| **Idle** | 3秒間I/Oなし、ページ非表示、またはウィンドウブラー | 1〜15 Hz（タイマー、指数的に増加） | GPU負荷ほぼゼロ、バッテリー節約 |

- **自動モード**：データ量、ユーザー入力、Page Visibility APIにより遷移が駆動 — 手動調整不要
- **バックグラウンド安全**：タブが非表示の場合、受信リモートデータはアイドルタイマーで継続的にフラッシュ — RAFは起動されず、バックグラウンドタブでのpending-buffer蓄積を防止
- **設定**：3つのモード（Auto / Always 60 Hz / Off）を設定 → ターミナル → レンダラーで選択
- **ライブ診断**：**FPSオーバーレイ表示**を有効にすると、リアルタイムのティアバッジ（`B`=boost · `N`=normal · `I`=idle）、フレームレート、書き込み/秒カウンターがターミナル隅にフローティング表示

### 🎨 カスタムテーマエンジン

プリセットパレットを超えた全レベルのテーマカスタマイズ：

- **30以上の組み込みテーマ**：Oxide、Dracula、Nord、Catppuccin、Spring Rice、Tokyo Nightなど
- **カスタムテーマエディタ**：全フィールドに対応したビジュアルカラーピッカー + 16進RGBの入力
- **ターミナルカラー**：全22のxterm.jsフィールド（背景、前景、カーソル、選択、16のANSIカラー）
- **UIクロームカラー**：5カテゴリにわたる19のCSS変数 — 背景（5）、テキスト（3）、ボーダー（3）、アクセント（4）、セマンティックステータスカラー（4）
- **自動導出**：ターミナルパレットからUIカラーをワンクリック生成
- **ライブプレビュー**：編集中にリアルタイムのミニターミナル + UIクロームプレビュー
- **複製して拡張**：組み込みまたはカスタムテーマを複製して新しいテーマを作成
- **永続化**：カスタムテーマはlocalStorageに保存、アプリ更新後も維持

### 🪟 Windows深層最適化

- **ネイティブConPTY統合**：Windows Pseudo Console（ConPTY）APIを直接呼び出し、完全なTrueColorとANSIエスケープシーケンスをサポート — 旧式のWinPTY不要。
- **インテリジェントシェル検出**：内蔵スキャナーが**PowerShell 7（pwsh）**、**Git Bash**、**WSL2**、レガシーCMDをレジストリとPATHから自動検出。
- **ネイティブ体験**：Rustが直接ウィンドウイベントを処理 — 応答速度はElectronアプリを大幅に上回る。

### 📊 バックエンドスクロールバッファ

- **大容量永続化**：デフォルト**100,000行**のターミナル出力、ディスクにシリアライズ可能（MessagePackフォーマット）。
- **高性能検索**：`spawn_blocking`で正規表現検索タスクを分離、Tokioランタイムのブロッキングを回避。
- **メモリ効率**：循環バッファ設計で最古のデータを自動的に消去、メモリ使用量を制御。

### ⚛️ マルチストアステートアーキテクチャ

フロントエンドは大きく異なるステートドメインを処理するために**マルチストア**パターン（16ストア）を採用：

| ストア | 役割 |
|---|---|
| **SessionTreeStore** | ユーザーインテント — ツリー構造、接続フロー、セッション組織 |
| **AppStore** | ファクトレイヤー — `connections` Mapを介した実際のSSH接続状態、SessionTreeStoreから同期 |
| **IdeStore** | IDEモード — リモートファイル編集、Gitステータス、マルチタブエディタ |
| **LocalTerminalStore** | ローカルPTYライフサイクル、シェルプロセス監視、独立I/O |
| **ReconnectOrchestratorStore** | 自動再接続パイプライン（snapshot → grace-period → ssh-connect → await-terminal → restore） |
| **TransferStore** | SFTP転送キューと進捗 |
| **PluginStore** | プラグインランタイム状態とUIレジストリ |
| **ProfilerStore** | リソースプロファイラメトリクス |
| **AiChatStore** | AIチャット会話状態 |
| **SettingsStore** | アプリケーション設定 |
| **BroadcastStore** | ブロードキャスト入力 — 複数ペインへのキーストローク複製 |
| **CommandPaletteStore** | コマンドパレットの開閉状態 |
| **EventLogStore** | 接続ライフサイクルと再接続イベントログ |
| **LauncherStore** | プラットフォームアプリケーションランチャー状態 |
| **RecordingStore** | ターミナルセッションの録画と再生 |
| **UpdateStore** | 自動更新ライフサイクル（check → download → install） |

異なるステートソースにもかかわらず、レンダリングロジックは`TerminalView`と`IdeView`コンポーネントを通じて統一されています。

---

## 技術スタック

| レイヤー | 技術 | 詳細 |
|---|---|---|
| **フレームワーク** | Tauri 2.0 | ネイティブバイナリ、約15 MB、Electron不要 |
| **ランタイム** | Tokio + DashMap 6 | ロックフリー並行マップによる完全な非同期 |
| **SSH** | russh 0.54（`ring`） | 純粋Rust、C依存ゼロ、SSH Agent |
| **ローカルPTY** | portable-pty 0.8 | フィーチャーゲート、WindowsではConPTY |
| **フロントエンド** | React 19.1 + TypeScript 5.8 | Vite 7、Tailwind CSS 4 |
| **ステート** | Zustand 5 | 16の特化ストア、イベント駆動同期 |
| **ターミナル** | xterm.js 6 + WebGL | GPU加速、60fps以上 |
| **エディタ** | CodeMirror 6 | 16言語パック + レガシーモード |
| **暗号化** | ChaCha20-Poly1305 + Argon2id | AEAD + メモリハードKDF |
| **ストレージ** | redb 2.1 | セッション、フォワーディング、転送用の組み込みDB |
| **シリアライゼーション** | MessagePack（rmp-serde） | バイナリバッファ/状態永続化 |
| **i18n** | i18next 25 | 11言語 × 21ネームスペース |
| **SFTP** | russh-sftp 2.0 | SSH File Transfer Protocol |
| **WebSocket** | tokio-tungstenite 0.24 | ターミナルデータプレーン用非同期WebSocket |
| **プロトコル** | Wire Protocol v1 | WebSocket上のバイナリ`[Type:1][Length:4][Payload:n]` |
| **プラグイン** | ESMランタイム | 凍結されたPluginContext + 24 UIキットコンポーネント |

---

## 機能マトリクス

| カテゴリ | 機能 |
|---|---|
| **ターミナル** | ローカルPTY、SSHリモート、分割ペイン（水平/垂直）、セッション録画/再生（asciicast v2）、クロスペインAIコンテキスト、WebGLレンダリング、背景画像ギャラリー、30以上のテーマ + カスタムテーマエディタ、コマンドパレット（`⌘K`）、禅モード（`⌘⇧Z`）、フォントサイズショートカット（`⌘+`/`⌘-`） |
| **SSH** | 接続プール、多重化、ProxyJump（無制限ホップ）、トポロジーグラフ、自動再接続パイプライン |
| **認証** | パスワード、SSH鍵（RSA/Ed25519/ECDSA）、SSH Agent、証明書、Keyboard-Interactive（2FA）、Known Hosts |
| **ファイル** | デュアルペインSFTPブラウザ、ドラッグ＆ドロップ、プレビュー（画像/動画/音声/PDF/コード/Hex）、転送キュー |
| **IDE** | ファイルツリー、CodeMirrorエディタ、マルチタブ、Gitステータス、コンフリクト解決、統合ターミナル |
| **フォワーディング** | ローカル（-L）、リモート（-R）、ダイナミックSOCKS5（-D）、自動復元、終了報告、ロックフリーI/O |
| **AI** | インラインパネル + サイドバーチャット、SSEストリーミング、コード挿入、40以上のツール利用、MCPサーバー統合、マルチソースコンテキスト、RAG ナレッジベース、OpenAI/Ollama/DeepSeek |
| **プラグイン** | ランタイムESMローディング、8つのAPIネームスペース、24 UIキット、サンドボックス、サーキットブレーカー |
| **WSL Graphics** ⚠️ | 内蔵VNCビューア（実験的）：デスクトップモード（9種DE）+ アプリモード（単一GUIアプリ）、WSLg検出、Xtigervnc + noVNC、再接続、フィーチャーゲート |
| **セキュリティ** | .oxide暗号化、OSキーチェーン、`zeroize`メモリ、ホストキーTOFU |
| **i18n** | EN、简体中文、繁體中文、日本語、FR、DE、ES、IT、한국어、PT-BR、VI |

---

## 機能ハイライト

### 🚀 ハイブリッドターミナル体験
- **ゼロレイテンシのローカルシェル**：ローカルプロセスとの直接IPC、ほぼゼロのレイテンシ。
- **高性能リモートSSH**：WebSocketバイナリストリーム、従来のHTTPオーバーヘッドをバイパス。
- **完全な環境継承**：PATH、HOME、及びすべての環境変数を継承 — システムターミナルと同等の体験。

### 🔐 多様な認証方式
- **パスワード**：システムキーチェーンに安全に保存。
- **鍵認証**：RSA / Ed25519 / ECDSA、`~/.ssh/id_*`を自動スキャン。
- **SSH Agent**：`AgentSigner`によるシステムエージェント（macOS/Linux/Windows）。
- **証明書**：OpenSSH証明書。
- **2FA/MFA**：Keyboard-Interactive認証。
- **Known Hosts**：TOFUと`~/.ssh/known_hosts`によるホストキー検証。

### 🔍 全文検索
インテリジェントキャッシュ付きのプロジェクト全体のファイルコンテンツ検索：
- **リアルタイム検索**：300ms デバウンス入力で即時結果。
- **結果キャッシュ**：60秒TTLキャッシュで繰り返しスキャンを回避。
- **結果グルーピング**：行番号位置付きでファイルごとにグループ化。
- **ハイライトマッチング**：プレビュースニペットで検索語をハイライト表示。
- **自動クリア**：ファイル変更時にキャッシュを無効化。

### 📦 高度なファイル管理
- **SFTP v3プロトコル**：完全なデュアルペインファイルマネージャ。
- **ドラッグ＆ドロップ**：マルチファイルおよびフォルダのバッチ操作。
- **インテリジェントプレビュー**：
  - 🎨 画像（JPEG/PNG/GIF/WebP）
  - 🎬 動画（MP4/WebM）内蔵プレーヤー付き
  - 🎵 音声（MP3/WAV/OGG/FLAC）メタデータ表示付き
  - 💻 コードハイライト（30以上の言語）
  - 📄 PDFドキュメント
  - 🔍 Hexビューア（バイナリファイル）
- **進捗追跡**：リアルタイム速度、プログレスバー、ETA。

### 🌍 国際化（i18n）
- **11言語対応**：English、简体中文、繁體中文、日本語、Français、Deutsch、Español、Italiano、한국어、Português、Tiếng Việt。
- **動的ローディング**：i18nextによるオンデマンド言語パック。
- **型安全**：すべての翻訳キーに対するTypeScript定義。

<details>
<summary>📸 11言語のインターフェース</summary>
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

### 🌐 ネットワーク最適化
- **デュアルプレーンアーキテクチャ**：データプレーン（WebSocket直接接続）とコントロールプレーン（Tauri IPC）を分離。
- **カスタムバイナリプロトコル**：`[Type:1][Length:4][Payload:n]`、JSONシリアライゼーションのオーバーヘッドなし。
- **バックプレッシャー制御**：バーストトラフィック時のメモリオーバーフローを防止。
- **自動再接続**：指数バックオフリトライ、最大5回。

### 🖥️ WSL Graphics（⚠️ 実験的）
- **デスクトップモード**：ターミナルタブ内でフルLinux GUIデスクトップ — 9つのデスクトップ環境（Xfce / GNOME / KDE Plasma / MATE / LXDE / Cinnamon / Openbox / Fluxbox / IceWM）、自動検出。
- **アプリモード**：フルデスクトップなしで単一GUIアプリを起動（例：`gedit`、`firefox`）— 軽量Xtigervnc + オプションのOpenbox WM、アプリ終了時に自動クリーンアップ。
- **WSLg検出**：ディストリビューションごとのWSLg可用性（Wayland / X11ソケット）を自動検出、UIにバッジで表示。
- **Xtigervnc + noVNC**：スタンドアロンXサーバーをアプリ内`<canvas>`でレンダリング、`scaleViewport`と`resizeSession`対応。
- **セキュリティ**：`argv`配列インジェクション（シェルパーシング不要）、`env_clear()` + 最小ホワイトリスト、`validate_argv()` 6ルール防衛、並行制限（ディストリビューションあたり4アプリセッション、グローバル8）。
- **再接続**：VNCセッションを終了せずにWebSocketブリッジを再確立。
- **フィーチャーゲート**：`wsl-graphics` Cargoフィーチャー、非Windowsプラットフォームではスタブコマンド。

---

## クイックスタート

### 前提条件

- **Rust** 1.75以上
- **Node.js** 18以上（pnpm推奨）
- **プラットフォームツール**：
  - macOS：Xcode Command Line Tools
  - Windows：Visual Studio C++ Build Tools
  - Linux：`build-essential`、`libwebkit2gtk-4.1-dev`、`libssl-dev`

### 開発

```bash
git clone https://github.com/AnalyseDeCircuit/OxideTerm.git
cd OxideTerm && pnpm install

# フルアプリ（フロントエンド + Rustバックエンド + ローカルPTY）
pnpm tauri dev

# フロントエンドのみ（ポート1420でホットリロード）
pnpm dev

# プロダクションビルド
pnpm tauri build

# 軽量カーネル — モバイル向けにローカルPTYを除外
cd src-tauri && cargo build --no-default-features --release
```

---

## プロジェクト構成

```
OxideTerm/
├── src/                            # フロントエンド — 83K行 TypeScript
│   ├── components/                 # 20ディレクトリ
│   │   ├── terminal/               #   ターミナルビュー、分割ペイン、検索
│   │   ├── sftp/                   #   デュアルペインファイルブラウザ
│   │   ├── ide/                    #   エディタ、ファイルツリー、Gitダイアログ
│   │   ├── ai/                     #   インライン + サイドバーチャット
│   │   ├── graphics/               #   WSL Graphics（VNCデスクトップ + アプリビューア）
│   │   ├── plugin/                 #   プラグインマネージャ & ランタイムUI
│   │   ├── forwards/               #   ポートフォワーディング管理
│   │   ├── connections/            #   接続CRUD & インポート
│   │   ├── topology/               #   ネットワークトポロジーグラフ
│   │   ├── layout/                 #   サイドバー、ヘッダー、分割ペイン
│   │   └── ...                     #   sessions、settings、modalsなど
│   ├── store/                      # 16 Zustand stores
│   ├── lib/                        # APIレイヤー、AIプロバイダー、プラグインランタイム
│   ├── hooks/                      # React hooks（イベント、キーボード、トースト）
│   ├── types/                      # TypeScript型定義
│   └── locales/                    # 11言語 × 21ネームスペース
│
├── src-tauri/                      # バックエンド — 51K行 Rust
│   └── src/
│       ├── router/                 #   NodeRouter（nodeId → リソース）
│       ├── ssh/                    #   SSHクライアント（Agent含む12モジュール）
│       ├── local/                  #   ローカルPTY（フィーチャーゲート）
│       ├── graphics/               #   WSL Graphics（フィーチャーゲート）
│       ├── bridge/                 #   WebSocketブリッジ & Wire Protocol v1
│       ├── session/                #   セッション管理（16モジュール）
│       ├── forwarding/             #   ポートフォワーディング（6モジュール）
│       ├── sftp/                   #   SFTP実装
│       ├── config/                 #   Vault、キーチェーン、SSH config
│       ├── oxide_file/             #   .oxide暗号化（ChaCha20）
│       ├── commands/               #   24 Tauri IPCコマンドモジュール
│       └── state/                  #   グローバル状態型
│
└── docs/                           # 27以上のアーキテクチャ & 機能ドキュメント
```

---

## ロードマップ

### 🚧 進行中 (v0.20)

- [ ] RAG 運用ナレッジベース——ローカルドキュメントコレクション、BM25 + ベクトルハイブリッド検索、AI 統合検索
- [ ] セッション検索 & クイック切替

### 📋 計画中

- [ ] SSH Agentフォワーディング

---

## セキュリティ

| 項目 | 実装 |
|---|---|
| **パスワード** | OSキーチェーン（macOS Keychain / Windows Credential Manager / Linux libsecret） |
| **AI APIキー** | `com.oxideterm.ai`サービス配下のOSキーチェーン；macOSではキーの読み取りに**Touch ID**が必要（`LocalAuthentication.framework`によるバイオメトリクスゲート、data-protectionエンタイトルメント不要）— キーは初回認証後にメモリにキャッシュされるため、Touch IDはセッションごとに1回のみプロンプト |
| **設定ファイル** | `~/.oxideterm/connections.json` — キーチェーン参照IDのみを保存 |
| **エクスポート** | .oxide：ChaCha20-Poly1305 + Argon2id、オプションの鍵埋め込み |
| **メモリ** | `zeroize`が機密データをクリア；Rustがメモリ安全性を保証 |
| **ホストキー** | `~/.ssh/known_hosts`を使用したTOFU |
| **プラグイン** | Object.freeze + Proxy ACL、サーキットブレーカー、IPCホワイトリスト |

---

## ライセンス

**PolyForm Noncommercial 1.0.0**

- ✅ 個人 / 非営利利用：無料
- 🚫 商用利用：ライセンスが必要
- ⚖️ 特許防衛条項（Nuclear Clause）

全文：https://polyformproject.org/licenses/noncommercial/1.0.0/

---

## 謝辞

- [russh](https://github.com/warp-tech/russh) — 純粋Rust SSH
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty) — クロスプラットフォームPTY
- [Tauri](https://tauri.app/) — ネイティブアプリフレームワーク
- [xterm.js](https://xtermjs.org/) — ターミナルエミュレータ
- [CodeMirror](https://codemirror.net/) — コードエディタ
- [Radix UI](https://www.radix-ui.com/) — アクセシブルUIプリミティブ

---

<p align="center">
  <sub>RustとTauriで構築 — 130,000行以上のコード</sub>
</p>
