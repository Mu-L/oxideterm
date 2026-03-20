<p align="center">
  <img src="../../src-tauri/icons/icon.ico" alt="OxideTerm" width="128" height="128">
</p>

<h1 align="center">⚡ OxideTerm</h1>

<p align="center">
  <strong>Rust-Betriebener Terminal-Engine — Jenseits von SSH</strong>
  <br>
  <em>130.000+ Zeilen Rust &amp; TypeScript. Kein Electron. Keine C-Abhängigkeiten im SSH-Stack.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.19.2-blue" alt="Version">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Plattform">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blueviolet" alt="Lizenz">
  <img src="https://img.shields.io/badge/rust-1.75+-orange" alt="Rust">
  <img src="https://img.shields.io/badge/tauri-2.0-purple" alt="Tauri">
</p>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-Hans.md">简体中文</a> | <a href="README.zh-Hant.md">繁體中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

---

<p align="center">
  <img src="../media/ai-terminal-demo.gif" alt="OxideTerm KI-Demo">
</p>
<p align="center"><em>🤖 KI-Assistent — „Ein lokales Terminal öffnen und echo hello, world! ausführen"</em></p>

## Was ist OxideTerm?

OxideTerm ist eine **plattformübergreifende Terminal-Anwendung**, die lokale Shells, entfernte SSH-Sitzungen, Dateiverwaltung, Code-Bearbeitung und KI-Unterstützung in einer einzigen nativen Rust-Binärdatei vereint. Es ist **kein** Electron-Wrapper — das gesamte Backend ist in Rust geschrieben und wird als 20–35 MB große native Programmdatei über Tauri 2.0 ausgeliefert.

### Warum noch ein Terminal?

| Schwachstelle | OxideTerms Lösung |
|---|---|
| SSH-Clients ohne lokale Shells | Hybrid-Engine: lokales PTY + Remote-SSH in einem Fenster |
| Neuverbindung = alles verloren | **Node-First-Architektur**: Auto-Reconnect mit Grace Period bewahrt TUI-Apps; stellt Weiterleitungen, Transfers, IDE-Zustand wieder her |
| Remote-Dateibearbeitung braucht VS Code Remote | **Integrierter IDE-Modus**: CodeMirror 6 Editor über SFTP, standardmäßig keine Server-Installation; optionaler Remote-Agent unter Linux |
| Keine SSH-Verbindungswiederverwendung | **SSH-Multiplexing**: Terminal, SFTP, Weiterleitungen teilen eine Verbindung |
| SSH-Bibliotheken hängen von OpenSSL ab | **russh 0.54**: reines Rust-SSH, `ring`-Crypto-Backend, keine C-Abhängigkeiten |

---

## Architektur im Überblick

```
┌─────────────────────────────────────┐
│        Frontend (React 19)          │
│                                     │
│  SessionTreeStore ──► AppStore      │    16 Zustand-Stores
│  IdeStore    LocalTerminalStore     │    20 Komponentenverzeichnisse
│  ReconnectOrchestratorStore         │    11 Sprachen × 21 Namensräume
│  PluginStore  AiChatStore  ...      │
│                                     │
│        xterm.js 6 + WebGL           │
└──────────┬──────────────┬───────────┘
           │ Tauri IPC    │ WebSocket (binär)
┌──────────▼──────────────▼───────────┐
│         Backend (Rust)              │
│                                     │
│  NodeRouter ── resolve(nodeId) ──►  │    24 IPC-Befehlsmodule
│  ├─ SshConnectionRegistry          │    DashMap nebenläufiger Zustand
│  ├─ SessionRegistry                │    Feature-gated lokales PTY
│  ├─ ForwardingManager              │    ChaCha20-Poly1305-Tresor
│  ├─ SftpSession (Verbindungsebene) │    russh 0.54 (ring-Backend)
│  └─ LocalTerminalRegistry          │    SSH Agent (AgentSigner)
│                                     │
│  Wire Protocol v1                   │
│  [Type:1][Länge:4][Nutzlast:n]      │
└─────────────────────────────────────┘
```

**Dual-Plane-Kommunikation**: WebSocket-Binärframes für Terminal-I/O (keine Serialisierung), Tauri-IPC für strukturierte Befehle und Events. Das Frontend greift nie direkt auf `sessionId` oder `connectionId` zu — alles wird über `nodeId` adressiert, serverseitig vom `NodeRouter` aufgelöst.

---

## Technische Highlights

### 🔩 Reines Rust-SSH — russh 0.54

OxideTerm wird mit **russh 0.54** ausgeliefert, kompiliert gegen das `ring`-Crypto-Backend:
- **Keine C/OpenSSL-Abhängigkeiten** im SSH-Pfad — der gesamte Crypto-Stack ist Rust
- Vollständiges SSH2-Protokoll: Schlüsselaustausch, Kanäle, SFTP-Subsystem, Portweiterleitung
- ChaCha20-Poly1305- und AES-GCM-Cipher-Suites, Ed25519/RSA/ECDSA-Schlüssel

### 🔑 SSH-Agent-Authentifizierung (AgentSigner)

Ein maßgeschneiderter `AgentSigner` kapselt den System-SSH-Agent und erfüllt das `Signer`-Trait von russh:

```rust
// Löst das RPITIT Send bound Problem in russh 0.54
// durch Klonen von &PublicKey zu einem eigenen Wert vor dem .await
pub struct AgentSigner { /* ... */ }
impl Signer for AgentSigner { /* Challenge-Response über Agent IPC */ }
```

- **Plattformen**: Unix (`SSH_AUTH_SOCK`), Windows (`\\.\pipe\openssh-ssh-agent`)
- **Proxy-Ketten**: jeder Hop kann unabhängig Agent-Auth verwenden
- **Reconnect**: `AuthMethod::Agent` wird bei Neuverbindung automatisch wiederholt

### 🧭 Node-First-Architektur (NodeRouter)

Die **Oxide-Next-Knotenabstraktion** eliminiert eine ganze Klasse von Race Conditions:

```
Frontend: useNodeState(nodeId) → { readiness, sftpReady, error }
Backend:  NodeRouter.resolve(nodeId) → ConnectionEntry → SftpSession
```

- Frontend-SFTP/IDE-Operationen übergeben nur `nodeId` — keine `sessionId`, keine `connectionId`
- Das Backend löst `nodeId → ConnectionEntry` atomar auf
- SSH-Reconnect ändert die `connectionId` — SFTP/IDE sind **nicht betroffen**
- `NodeEventEmitter` sendet typisierte Events mit Generationszählern zur Ordnung

### ⚙️ Lokales Terminal — Thread-sicheres PTY

Plattformübergreifende lokale Shell über `portable-pty 0.8`, geschützt durch das Feature `local-terminal`:

- **Thread-Sicherheit**: `MasterPty` in `std::sync::Mutex` mit `unsafe impl Sync`
- **Dedizierte I/O-Threads**: blockierende PTY-Lesevorgänge berühren nie die Tokio-Event-Loop
- **Shell-Erkennung**: erkennt automatisch `zsh`, `bash`, `fish`, `pwsh`, Git Bash, WSL2
- **Feature Gate**: `cargo build --no-default-features` entfernt PTY für Mobile-Builds

### 🔌 Laufzeit-Plugin-System (v1.6.2+)

Dynamisches Plugin-Laden mit eingefrorener, sicherheitsgehärteter API:

- **PluginContext-API**: 8 Namensräume (terminal, ui, commands, settings, lifecycle, events, storage, system)
- **24 UI-Kit-Komponenten**: vorgefertigte React-Komponenten, in Plugin-Sandboxen injiziert
- **Sicherheitsmodell**: `Object.freeze` + Proxy-ACL, Circuit Breaker, IPC-Whitelist
- **Membran-Architektur**: Plugins laufen in isolierten ESM-Kontexten mit kontrollierter Brücke zum Host

### 🛡️ SSH-Verbindungspool

Referenzgezählte `SshConnectionRegistry` mit DashMap:

- Mehrere Terminals, SFTP, Portweiterleitungen teilen sich **eine einzige physische SSH-Verbindung**
- Unabhängige Zustandsmaschinen pro Verbindung (connecting → active → idle → link_down → reconnecting)
- Leerlauf-Timeout (30 Min.), Keep-Alive (15s), Heartbeat-Fehlererkennung
- WsBridge lokaler Heartbeat: 30s-Intervall, 5 Min. Timeout (toleriert App Nap)
- Leerlauf-Timeout-Trennung sendet `connection_status_changed` an das Frontend
- Kaskadenpropagation: Jump-Host ausgefallen → alle nachgelagerten Knoten als `link_down` markiert
- **Intelligente Erkennung**: `visibilitychange` + `online`-Event → proaktive SSH-Prüfung (~2s vs. 15–30s passiv)
- **Grace Period**: 30s-Fenster zur Wiederherstellung bestehender Verbindungen vor destruktivem Reconnect (bewahrt TUI-Apps wie yazi/vim)

### 🔀 Portweiterleitung — Lock-freie I/O

Vollständige lokale (-L), entfernte (-R) und dynamische SOCKS5-Weiterleitung (-D):

- **Message-Passing-Architektur**: SSH-Kanal wird von einer einzelnen `ssh_io`-Task gehalten, kein `Arc<Mutex<Channel>>`
- **Ausfallberichterstattung**: Weiterleitungs-Tasks melden aktiv den Beendigungsgrund bei SSH-Trennung
- **Auto-Wiederherstellung**: `Suspended`-Weiterleitungen werden nach Reconnect fortgesetzt
- **Leerlauf-Timeout**: `FORWARD_IDLE_TIMEOUT` (300s) verhindert Zombie-Verbindungen

### 🤖 KI-Terminal-Assistent

Dual-Mode-KI mit datenschutzorientiertem Design:

- **Inline-Panel** (`⌘I`): Schnellbefehle, per Bracketed Paste eingefügt
- **Seitenleisten-Chat**: persistente Konversation mit Verlauf
- **Kontexterfassung**: Terminal Registry sammelt Buffer von aktiven oder allen geteilten Fenstern
- **Multi-Quellen-Kontext**: automatische Injektion von IDE-Dateien, SFTP-Pfaden und Git-Status in KI-Konversationen
- **Werkzeugnutzung**: 40+ eingebaute Werkzeuge (Dateioperationen, Prozessverwaltung, Netzwerk, TUI-Interaktion), die die KI eigenständig ausführen kann
- **MCP-Unterstützung**: externe [Model Context Protocol](https://modelcontextprotocol.io)-Server (stdio & SSE) verbinden, um die KI mit Drittanbieter-Werkzeugen zu erweitern — verwaltet in den Einstellungen
- **Kompatibel**: OpenAI, Ollama, DeepSeek, OneAPI, jeder `/v1/chat/completions`-Endpunkt
- **Sicher**: API-Schlüssel im Betriebssystem-Schlüsselbund (macOS Keychain / Windows Credential Manager); unter macOS wird der Lesezugriff durch **Touch ID** über `LAContext` geschützt — keine Entitlements oder Code-Signierung erforderlich

### � RAG-Betriebswissensdatenbank (v0.20)

Local-first Retrieval-Augmented Generation für Betriebsdokumentation:

- **Dokumentensammlungen**: Importieren Sie Markdown/TXT-Runbooks, SOPs und Deployment-Anleitungen in bereichsbezogene Sammlungen (global oder pro Verbindung)
- **Hybridsuche**: BM25-Schlüsselwortindex + Vektor-Kosinusähnlichkeit, vereint durch Reciprocal Rank Fusion (RRF)
- **Markdown-bewusstes Chunking**: Aufteilung nach Überschriftenhierarchie, Beibehaltung der Abschnittspfade (z.B. „Deployment > Docker > Fehlerbehebung")
- **CJK-Unterstützung**: Bigramm-Tokenizer für Chinesisch/Japanisch/Koreanisch + Leerzeichen-Tokenisierung für lateinische Schriften
- **KI-Integration**: Das `search_docs`-Tool ruft während KI-Gesprächen automatisch relevanten Dokumentenkontext ab — kein manuelles Auslösen erforderlich
- **Externe Bearbeitung**: Dokumente im Systemeditor öffnen, automatische Synchronisierung bei Fensterfokus mit optimistischer Versionssperre
- **Neuindexierung mit Fortschritt**: Vollständiger BM25-Neuaufbau mit Echtzeit-Fortschrittsbalken und Abbruch-Unterstützung
- **Embedding-Pipeline**: Frontend generiert Vektoren über KI-Anbieter, im Backend gespeichert für hybride Suche
- **Speicher**: redb eingebettete Datenbank, 9 Tabellen, MessagePack-Serialisierung mit automatischer Komprimierung für große Chunks

### �💻 IDE-Modus — Remote-Bearbeitung

CodeMirror 6 Editor über SFTP — standardmäßig keine serverseitige Installation erforderlich; Linux unterstützt einen optionalen leichtgewichtigen Remote-Agent für erweiterte Funktionen:

- **Dateibaum**: Lazy-Loading mit Git-Statusindikatoren
- **30+ Sprachmodi**: 16 native CodeMirror-Packs + Legacy-Modi
- **Konfliktlösung**: optimistisches Locking per `mtime`
- **Ereignisgesteuertes Git**: automatische Aktualisierung bei Speichern, Erstellen, Löschen, Umbenennen, Terminal-Enter
- **State Gating**: I/O blockiert wenn `readiness !== 'ready'`, Key-Driven Reset bei Reconnect
- **Linux-Remote-Agent (optional)**: ~1 MB Rust-Binärdatei, automatisches Deployment auf x86_64/aarch64. Zusätzliche Architekturen (ARMv7, RISC-V64, LoongArch64, s390x, etc.) in `agents/extra/` für manuellen Upload verfügbar

### 🔐 .oxide verschlüsselter Export

Portables Verbindungs-Backup-Format:

- **ChaCha20-Poly1305 AEAD** authentifizierte Verschlüsselung
- **Argon2id KDF** (256 MB Speicher, 4 Iterationen) — GPU-Brute-Force-resistent
- **SHA-256**-Integritätsprüfsumme
- **Optionale Schlüsseleinbettung**: private Schlüssel base64-kodiert in verschlüsselter Nutzlast
- **Vorabanalyse**: Aufschlüsselung der Auth-Typen, Erkennung fehlender Schlüssel

### 📡 ProxyJump — Topologie-bewusstes Multi-Hop

- Unbegrenzte Kettentiefe: `Client → Sprung A → Sprung B → … → Ziel`
- Auto-Parse von SSH Config, Aufbau des Topologiegraphen, Dijkstra-Pfadberechnung
- Sprungknoten als unabhängige Sitzungen wiederverwendbar
- Kaskadierende Fehlerpropagation mit automatischer Downstream-Statussynchronisation

### 📊 Ressourcen-Profiler

Live-Überwachung entfernter Hosts über persistenten SSH-Shell-Kanal:

- Liest `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/net/dev`
- Delta-basierte CPU-% und Netzwerkdurchsatzberechnung
- Einzelner Kanal — vermeidet MaxSessions-Erschöpfung
- Automatischer Fallback auf RTT-only bei Nicht-Linux oder aufeinanderfolgenden Fehlern

### 🖼️ Hintergrundbild-Galerie

Multi-Bild-Hintergrundsystem mit Tab-spezifischer Transparenzsteuerung:

- **Galerieverwaltung**: mehrere Bilder hochladen, Miniaturansichten zum Wechseln anklicken, Einzellöschung oder Gesamtlöschung
- **Hauptschalter**: Hintergrund global aktivieren/deaktivieren, ohne Bilder zu löschen
- **Tab-Steuerung**: 13 Tab-Typen einzeln konfigurierbar (Terminal, SFTP, IDE, Einstellungen, Topologie, etc.)
- **Anpassung**: Deckkraft (3–50%), Unschärfe (0–20px), Anpassungsmodus (Abdecken/Einpassen/Füllen/Kacheln)
- **Plattformbewusst**: macOS-Transparenzunterstützung; Windows-WSLg-Pfad ausgeschlossen (opaker VNC-Canvas)
- **Sicherheit**: pfadkanonisiertes Löschen verhindert Verzeichnistraversierung; vollständige Fehlerpropagation aus dem Rust-Backend

### 🖥️ Adaptives Rendering — Dynamische Bildwiederholrate

Ein dreistufiger Render-Scheduler ersetzt festes RAF-Batching, verbessert die Reaktionsfähigkeit bei intensiver Ausgabe und reduziert GPU-/Batterielast im Leerlauf:

| Stufe | Auslöser | Effektive Rate | Vorteil |
|---|---|---|---|
| **Boost** | Frame-Daten ≥ 4 KB | 120 Hz+ (RAF / ProMotion nativ) | Eliminiert Scroll-Lag bei schneller Ausgabe |
| **Normal** | Standardeingabe / leichte I/O | 60 Hz (RAF) | Flüssige Grundinteraktion |
| **Idle** | 3 s ohne I/O, Seite verborgen oder Fenster unscharf | 1–15 Hz (Timer, exponentielles Wachstum) | Nahezu null GPU-Last, Batterieersparnis |

- **Automatischer Modus**: Übergänge gesteuert durch Datenvolumen, Benutzereingaben und Page Visibility API — keine manuelle Anpassung nötig
- **Hintergrundsicher**: wenn der Tab verborgen ist, werden eingehende Remote-Daten weiterhin über den Idle-Timer geleert — RAF wird nie geweckt, verhindert Pufferakkumulation bei Hintergrund-Tabs
- **Einstellungen**: drei Modi (Auto / Immer 60 Hz / Aus) in Einstellungen → Terminal → Renderer
- **Live-Diagnose**: **FPS-Overlay anzeigen** aktivieren für ein Echtzeit-Stufen-Badge (`B`=Boost · `N`=Normal · `I`=Idle), Bildrate und Schreibvorgänge-pro-Sekunde-Zähler in der Terminal-Ecke

### 🎨 Benutzerdefinierte Theme-Engine

Vollständige Theme-Anpassung über vordefinierte Paletten hinaus:

- **30+ integrierte Themes**: Oxide, Dracula, Nord, Catppuccin, Spring Rice, Tokyo Night und mehr
- **Visueller Theme-Editor**: Farbwähler + Hex-RGB-Eingabe für jedes Feld
- **Terminal-Farben**: alle 22 xterm.js-Felder (Hintergrund, Vordergrund, Cursor, Auswahl, 16 ANSI-Farben)
- **UI-Chrome-Farben**: 19 CSS-Variablen in 5 Kategorien — Hintergrund (5), Text (3), Rahmen (3), Akzent (4), Semantische Statusfarben (4)
- **Auto-Ableitung**: Ein-Klick-Generierung von UI-Farben aus der Terminal-Palette
- **Live-Vorschau**: Echtzeit-Mini-Terminal + UI-Chrome-Vorschau während der Bearbeitung
- **Duplizieren & Erweitern**: neue Themes durch Duplizieren jedes integrierten oder benutzerdefinierten Themes erstellen
- **Persistent**: benutzerdefinierte Themes werden im localStorage gespeichert und überdauern App-Updates

### 🪟 Tiefgreifende Windows-Optimierung

- **Native ConPTY-Integration**: direkter Aufruf der Windows Pseudo Console (ConPTY) API für perfekte TrueColor- und ANSI-Escape-Sequenz-Unterstützung — kein veraltetes WinPTY.
- **Intelligente Shell-Erkennung**: integrierter Scanner erkennt automatisch **PowerShell 7 (pwsh)**, **Git Bash**, **WSL2** und Legacy-CMD über Registry und PATH.
- **Native Erfahrung**: Rust verarbeitet Fensterereignisse direkt — Reaktionsgeschwindigkeit weit über Electron-Apps.

### 📊 Backend-Scroll-Buffer

- **Hochkapazitäts-Persistenz**: standardmäßig **100.000 Zeilen** Terminalausgabe, serialisierbar auf Festplatte (MessagePack-Format).
- **Hochleistungssuche**: `spawn_blocking` isoliert Regex-Suchaufgaben, blockiert nie die Tokio-Runtime.
- **Speichereffizient**: Ringpuffer-Design mit automatischer Verdrängung der ältesten Daten, kontrollierter Speicherverbrauch.

### ⚛️ Multi-Store-Zustandsarchitektur

Das Frontend verwendet ein **Multi-Store**-Muster (16 Stores) für grundlegend verschiedene Zustandsdomänen:

| Store | Rolle |
|---|---|
| **SessionTreeStore** | Benutzerabsicht — Baumstruktur, Verbindungsfluss, Sitzungsorganisation |
| **AppStore** | Faktenebene — tatsächlicher SSH-Verbindungszustand über `connections` Map, synchronisiert aus SessionTreeStore |
| **IdeStore** | IDE-Modus — Remote-Dateibearbeitung, Git-Status, Multi-Tab-Editor |
| **LocalTerminalStore** | Lokaler PTY-Lebenszyklus, Shell-Prozessüberwachung, unabhängige I/O |
| **ReconnectOrchestratorStore** | Auto-Reconnect-Pipeline (Snapshot → Grace-Period → SSH-Connect → Await-Terminal → Wiederherstellung) |
| **TransferStore** | SFTP-Transfer-Warteschlange und Fortschritt |
| **PluginStore** | Plugin-Laufzeitzustand und UI-Registry |
| **ProfilerStore** | Ressourcen-Profiler-Metriken |
| **AiChatStore** | KI-Chat-Konversationszustand |
| **SettingsStore** | Anwendungseinstellungen |
| **BroadcastStore** | Broadcast-Eingabe — Tastatureingaben an mehrere Fenster replizieren |
| **CommandPaletteStore** | Befehlspalette Öffnen/Schließen-Zustand |
| **EventLogStore** | Verbindungslebenszyklus- & Reconnect-Ereignisprotokoll |
| **LauncherStore** | Plattform-Anwendungsstarter-Zustand |
| **RecordingStore** | Terminal-Sitzungsaufzeichnung & -Wiedergabe |
| **UpdateStore** | Auto-Update-Lebenszyklus (Prüfen → Herunterladen → Installieren) |

Trotz verschiedener Zustandsquellen ist die Rendering-Logik durch die Komponenten `TerminalView` und `IdeView` vereinheitlicht.

---

## Tech-Stack

| Schicht | Technologie | Details |
|---|---|---|
| **Framework** | Tauri 2.0 | Native Binärdatei, ~15 MB, kein Electron |
| **Runtime** | Tokio + DashMap 6 | Vollständig asynchron mit lock-freien nebenläufigen Maps |
| **SSH** | russh 0.54 (`ring`) | Reines Rust, keine C-Abhängigkeiten, SSH Agent |
| **Lokales PTY** | portable-pty 0.8 | Feature-gated, ConPTY unter Windows |
| **Frontend** | React 19.1 + TypeScript 5.8 | Vite 7, Tailwind CSS 4 |
| **Zustand** | Zustand 5 | 16 spezialisierte Stores, ereignisgesteuerte Synchronisation |
| **Terminal** | xterm.js 6 + WebGL | GPU-beschleunigt, 60fps+ |
| **Editor** | CodeMirror 6 | 16 Sprachpakete + Legacy-Modi |
| **Verschlüsselung** | ChaCha20-Poly1305 + Argon2id | AEAD + speicherintensive KDF |
| **Speicher** | redb 2.1 | Eingebettete Datenbank für Sitzungen, Weiterleitungen, Transfers |
| **Serialisierung** | MessagePack (rmp-serde) | Binäre Buffer-/Zustandspersistenz |
| **i18n** | i18next 25 | 11 Sprachen × 21 Namensräume |
| **SFTP** | russh-sftp 2.0 | SSH-Dateiübertragungsprotokoll |
| **WebSocket** | tokio-tungstenite 0.24 | Asynchroner WebSocket für die Terminal-Datenebene |
| **Protokoll** | Wire Protocol v1 | Binär `[Type:1][Length:4][Payload:n]` über WebSocket |
| **Plugins** | ESM-Runtime | Eingefrorener PluginContext + 24 UI-Kit-Komponenten |

---

## Funktionsmatrix

| Kategorie | Funktionen |
|---|---|
| **Terminal** | Lokales PTY, SSH Remote, geteilte Fenster (H/V), Sitzungsaufzeichnung/-wiedergabe (asciicast v2), fensterübergreifender KI-Kontext, WebGL-Rendering, Hintergrundbild-Galerie, 30+ Themes + benutzerdefinierter Theme-Editor, Befehlspalette (`⌘K`), Zen-Modus (`⌘⇧Z`), Schriftgrößen-Shortcuts (`⌘+`/`⌘-`) |
| **SSH** | Verbindungspool, Multiplexing, ProxyJump (∞ Hops), Topologiegraph, Auto-Reconnect-Pipeline |
| **Auth** | Passwort, SSH-Schlüssel (RSA/Ed25519/ECDSA), SSH Agent, Zertifikat, Keyboard-Interactive (2FA), Known Hosts |
| **Dateien** | Dualer SFTP-Browser, Drag-and-Drop, Vorschau (Bilder/Video/Audio/PDF/Code/Hex), Transfer-Warteschlange |
| **IDE** | Dateibaum, CodeMirror-Editor, Multi-Tab, Git-Status, Konfliktlösung, integriertes Terminal |
| **Weiterleitung** | Lokal (-L), Remote (-R), Dynamisches SOCKS5 (-D), Auto-Wiederherstellung, Ausfallberichterstattung, lock-freie I/O |
| **KI** | Inline-Panel + Seitenleisten-Chat, SSE-Streaming, Code-Einfügung, 40+ Werkzeugnutzung, MCP-Server-Integration, Multi-Quellen-Kontext, RAG-Wissensdatenbank, OpenAI/Ollama/DeepSeek |
| **Plugins** | ESM-Laufzeit-Laden, 8 API-Namensräume, 24 UI-Kit, Sandbox-Ausführung, Circuit Breaker |
| **WSL Graphics** ⚠️ | Integrierter VNC-Viewer (Experimentell): Desktop-Modus (9 DEs) + App-Modus (einzelne GUI-App), WSLg-Erkennung, Xtigervnc + noVNC, Reconnect, Feature-gated |
| **Sicherheit** | .oxide-Verschlüsselung, Betriebssystem-Schlüsselbund, `zeroize`-Speicher, Host-Key-TOFU |
| **i18n** | EN, 简体中文, 繁體中文, 日本語, FR, DE, ES, IT, 한국어, PT-BR, VI |

---

## Funktionsübersicht

### 🚀 Hybride Terminal-Erfahrung
- **Lokale Shell ohne Latenz**: direktes IPC mit lokalen Prozessen, nahezu null Latenz.
- **Hochleistungs-Remote-SSH**: WebSocket-Binärstrom, umgeht traditionellen HTTP-Overhead.
- **Vollständige Umgebungsvererbung**: erbt PATH, HOME und alle Umgebungsvariablen — identische Erfahrung wie das Systemterminal.

### 🔐 Vielfältige Authentifizierung
- **Passwort**: sicher im Systemschlüsselbund gespeichert.
- **Schlüssel-Auth**: RSA / Ed25519 / ECDSA, automatischer Scan von `~/.ssh/id_*`.
- **SSH Agent**: System-Agent über `AgentSigner` (macOS/Linux/Windows).
- **Zertifikate**: OpenSSH Certificates.
- **2FA/MFA**: Keyboard-Interactive-Authentifizierung.
- **Known Hosts**: Host-Key-Überprüfung mit TOFU und `~/.ssh/known_hosts`.

### 🔍 Volltextsuche
Projektweite Dateiinhaltssuche mit intelligentem Caching:
- **Echtzeit-Suche**: 300ms Debounce-Eingabe mit sofortigen Ergebnissen.
- **Ergebnis-Caching**: 60-Sekunden-TTL-Cache zur Vermeidung wiederholter Scans.
- **Ergebnis-Gruppierung**: nach Datei gruppiert mit Zeilennummer-Positionierung.
- **Hervorhebung**: Suchbegriffe in Vorschau-Snippets hervorgehoben.
- **Auto-Invalidierung**: Cache wird bei Dateiänderungen geleert.

### 📦 Erweiterte Dateiverwaltung
- **SFTP v3-Protokoll**: vollständiger Dual-Pane-Dateimanager.
- **Drag-and-Drop**: Multi-Datei- und Ordner-Stapeloperationen.
- **Intelligente Vorschau**:
  - 🎨 Bilder (JPEG/PNG/GIF/WebP)
  - 🎬 Videos (MP4/WebM) mit integriertem Player
  - 🎵 Audio (MP3/WAV/OGG/FLAC) mit Metadatenanzeige
  - 💻 Code-Highlighting (30+ Sprachen)
  - 📄 PDF-Dokumente
  - 🔍 Hex-Viewer (Binärdateien)
- **Fortschrittsverfolgung**: Echtzeit-Geschwindigkeit, Fortschrittsbalken, geschätzte Restzeit.

### 🌍 Internationalisierung (i18n)
- **11 Sprachen**: English, 简体中文, 繁體中文, 日本語, Français, Deutsch, Español, Italiano, 한국어, Português, Tiếng Việt.
- **Dynamisches Laden**: Sprachpakete bei Bedarf über i18next.
- **Typsicher**: TypeScript-Definitionen für alle Übersetzungsschlüssel.

<details>
<summary>📸 Alle 11 Sprachen in Aktion</summary>
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

### 🌐 Netzwerkoptimierung
- **Dual-Plane-Architektur**: Datenebene (WebSocket direkt) und Steuerungsebene (Tauri IPC) getrennt.
- **Benutzerdefiniertes Binärprotokoll**: `[Type:1][Length:4][Payload:n]`, kein JSON-Serialisierungs-Overhead.
- **Backpressure-Kontrolle**: verhindert Speicherüberlauf bei Burst-Traffic.
- **Auto-Reconnect**: exponentieller Backoff, bis zu 5 Versuche.

### 🖥️ WSL Graphics (⚠️ Experimentell)
- **Desktop-Modus**: vollständige Linux-GUI-Desktops in einem Terminal-Tab — 9 Desktop-Umgebungen (Xfce / GNOME / KDE Plasma / MATE / LXDE / Cinnamon / Openbox / Fluxbox / IceWM), automatisch erkannt.
- **App-Modus**: einzelne GUI-Anwendung starten (z.B. `gedit`, `firefox`) ohne vollständigen Desktop — leichtgewichtiger Xtigervnc + optionaler Openbox WM, automatische Bereinigung beim App-Beenden.
- **WSLg-Erkennung**: automatische Erkennung der WSLg-Verfügbarkeit (Wayland / X11 Sockets) pro Distribution, als Badge in der Oberfläche angezeigt.
- **Xtigervnc + noVNC**: eigenständiger X-Server gerendert über In-App-`<canvas>`, mit `scaleViewport` und `resizeSession`.
- **Sicherheit**: `argv`-Array-Injektion (kein Shell-Parsing), `env_clear()` + minimale Whitelist, `validate_argv()` 6-Regel-Verteidigung, Nebenläufigkeitslimits (4 App-Sitzungen/Distro, 8 global).
- **Reconnect**: WebSocket-Brücke wiederhergestellt ohne VNC-Sitzung zu beenden.
- **Feature-gated**: Cargo-Feature `wsl-graphics`, Stub-Befehle auf Nicht-Windows-Plattformen.

---

## Schnellstart

### Voraussetzungen

- **Rust** 1.75+
- **Node.js** 18+ (pnpm empfohlen)
- **Plattform-Tools**:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio C++ Build Tools
  - Linux: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`

### Entwicklung

```bash
git clone https://github.com/AnalyseDeCircuit/OxideTerm.git
cd OxideTerm && pnpm install

# Vollständige App (Frontend + Rust-Backend + lokales PTY)
pnpm tauri dev

# Nur Frontend (Hot Reload auf Port 1420)
pnpm dev

# Produktions-Build
pnpm tauri build

# Leichtgewichtiger Kernel — lokales PTY für Mobile entfernen
cd src-tauri && cargo build --no-default-features --release
```

---

## Projektstruktur

```
OxideTerm/
├── src/                            # Frontend — 83K Zeilen TypeScript
│   ├── components/                 # 20 Verzeichnisse
│   │   ├── terminal/               #   Terminalansichten, geteilte Fenster, Suche
│   │   ├── sftp/                   #   Dual-Pane-Dateibrowser
│   │   ├── ide/                    #   Editor, Dateibaum, Git-Dialoge
│   │   ├── ai/                     #   Inline- + Seitenleisten-Chat
│   │   ├── graphics/               #   WSL Graphics (VNC-Desktop + App-Viewer)
│   │   ├── plugin/                 #   Plugin-Manager & Laufzeit-UI
│   │   ├── forwards/               #   Portweiterleitungs-Verwaltung
│   │   ├── connections/            #   Verbindungs-CRUD & Import
│   │   ├── topology/               #   Netzwerk-Topologiegraph
│   │   ├── layout/                 #   Seitenleiste, Kopfzeile, geteilte Fenster
│   │   └── ...                     #   Sitzungen, Einstellungen, Dialoge, etc.
│   ├── store/                      # 16 Zustand-Stores
│   ├── lib/                        # API-Schicht, KI-Provider, Plugin-Laufzeit
│   ├── hooks/                      # React Hooks (Events, Tastatur, Toast)
│   ├── types/                      # TypeScript-Typdefinitionen
│   └── locales/                    # 11 Sprachen × 21 Namensräume
│
├── src-tauri/                      # Backend — 51K Zeilen Rust
│   └── src/
│       ├── router/                 #   NodeRouter (nodeId → Ressource)
│       ├── ssh/                    #   SSH-Client (12 Module inkl. Agent)
│       ├── local/                  #   Lokales PTY (Feature-gated)
│       ├── graphics/               #   WSL Graphics (Feature-gated)
│       ├── bridge/                 #   WebSocket-Brücke & Wire Protocol v1
│       ├── session/                #   Sitzungsverwaltung (16 Module)
│       ├── forwarding/             #   Portweiterleitung (6 Module)
│       ├── sftp/                   #   SFTP-Implementierung
│       ├── config/                 #   Tresor, Schlüsselbund, SSH Config
│       ├── oxide_file/             #   .oxide-Verschlüsselung (ChaCha20)
│       ├── commands/               #   24 Tauri-IPC-Befehlsmodule
│       └── state/                  #   Globale Zustandstypen
│
└── docs/                           # 27+ Architektur- & Funktionsdokumente
```

---

## Fahrplan

### 🚧 In Arbeit (v0.20)

- [ ] RAG-Betriebswissensdatenbank — lokale Dokumentensammlungen mit BM25 + Vektor-Hybridsuche, KI-integrierte Suche
- [ ] Sitzungssuche & Schnellwechsel

### 📋 Geplant

- [ ] SSH-Agent-Weiterleitung

---

## Sicherheit

| Bereich | Implementierung |
|---|---|
| **Passwörter** | Betriebssystem-Schlüsselbund (macOS Keychain / Windows Credential Manager / Linux libsecret) |
| **KI-API-Schlüssel** | Betriebssystem-Schlüsselbund unter dem Dienst `com.oxideterm.ai`; unter macOS erfordert das Lesen **Touch ID** (biometrisches Gate über `LocalAuthentication.framework`, keine Data-Protection-Entitlements nötig) — Schlüssel werden nach der ersten Authentifizierung im Speicher zwischengespeichert, Touch ID wird nur einmal pro Sitzung abgefragt |
| **Konfigurationsdateien** | `~/.oxideterm/connections.json` — speichert nur Schlüsselbund-Referenz-IDs |
| **Export** | .oxide: ChaCha20-Poly1305 + Argon2id, optionale Schlüsseleinbettung |
| **Speicher** | `zeroize` löscht sensible Daten; Rust garantiert Speichersicherheit |
| **Host-Keys** | TOFU mit `~/.ssh/known_hosts` |
| **Plugins** | Object.freeze + Proxy-ACL, Circuit Breaker, IPC-Whitelist |

---

## Lizenz

**PolyForm Noncommercial 1.0.0**

- ✅ Persönliche / gemeinnützige Nutzung: kostenlos
- 🚫 Kommerzielle Nutzung: erfordert eine Lizenz
- ⚖️ Patentverteidigungsklausel (Nuklearklausel)

Vollständiger Text: https://polyformproject.org/licenses/noncommercial/1.0.0/

---

## Danksagungen

- [russh](https://github.com/warp-tech/russh) — Reines Rust-SSH
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty) — Plattformübergreifende PTY-Abstraktion
- [Tauri](https://tauri.app/) — Natives App-Framework
- [xterm.js](https://xtermjs.org/) — Terminal-Emulator
- [CodeMirror](https://codemirror.net/) — Code-Editor
- [Radix UI](https://www.radix-ui.com/) — Barrierefreie UI-Primitiven

---

<p align="center">
  <sub>Entwickelt mit Rust und Tauri — 130.000+ Zeilen Code</sub>
</p>
