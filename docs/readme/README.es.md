<p align="center">
  <img src="../../src-tauri/icons/icon.ico" alt="OxideTerm" width="128" height="128">
</p>

<h1 align="center">⚡ OxideTerm</h1>

<p align="center">
  <strong>Motor de Terminal en Rust — Más Allá del SSH</strong>
  <br>
  <em>130.000+ líneas de Rust &amp; TypeScript. Sin Electron. Sin dependencias C en la pila SSH.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.19.2-blue" alt="Versión">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Plataforma">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blueviolet" alt="Licencia">
  <img src="https://img.shields.io/badge/rust-1.75+-orange" alt="Rust">
  <img src="https://img.shields.io/badge/tauri-2.0-purple" alt="Tauri">
</p>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-Hans.md">简体中文</a> | <a href="README.zh-Hant.md">繁體中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

---

<p align="center">
  <img src="../media/ai-terminal-demo.gif" alt="Demo IA de OxideTerm">
</p>
<p align="center"><em>🤖 Asistente IA — «Abre un terminal local y ejecuta echo hello, world!»</em></p>

## ¿Qué es OxideTerm?

OxideTerm es una **aplicación de terminal multiplataforma** que unifica shells locales, sesiones SSH remotas, gestión de archivos, edición de código y asistencia de IA en un solo binario nativo de Rust. **No** es un envoltorio de Electron — todo el backend está escrito en Rust y se distribuye como un ejecutable nativo de 20-35 MB vía Tauri 2.0.

### ¿Por qué otro terminal?

| Punto de dolor | Respuesta de OxideTerm |
|---|---|
| Los clientes SSH no hacen shell local | Motor híbrido: PTY local + SSH remoto en una misma ventana |
| Reconectar = perderlo todo | **Arquitectura Node-first**: reconexión automática con Grace Period preserva aplicaciones TUI; restaura reenvíos, transferencias y estado del IDE |
| La edición remota requiere VS Code Remote | **Modo IDE integrado**: editor CodeMirror 6 sobre SFTP, sin instalación en el servidor por defecto; agente remoto opcional en Linux |
| Sin reutilización de conexiones SSH | **Multiplexación SSH**: terminal, SFTP y reenvíos comparten una sola conexión |
| Las bibliotecas SSH dependen de OpenSSL | **russh 0.54**: SSH puro en Rust, backend criptográfico `ring`, cero dependencias C |

---

## Arquitectura de un vistazo

```
┌─────────────────────────────────────┐
│        Frontend (React 19)          │
│                                     │
│  SessionTreeStore ──► AppStore      │    16 stores Zustand
│  IdeStore    LocalTerminalStore     │    20 directorios de componentes
│  ReconnectOrchestratorStore         │    11 idiomas × 21 espacios de nombres
│  PluginStore  AiChatStore  ...      │
│                                     │
│        xterm.js 6 + WebGL           │
└──────────┬──────────────┬───────────┘
           │ Tauri IPC    │ WebSocket (binario)
┌──────────▼──────────────▼───────────┐
│         Backend (Rust)              │
│                                     │
│  NodeRouter ── resolve(nodeId) ──►  │    24 módulos de comandos IPC
│  ├─ SshConnectionRegistry          │    Estado concurrente DashMap
│  ├─ SessionRegistry                │    PTY local con feature gate
│  ├─ ForwardingManager              │    Bóveda ChaCha20-Poly1305
│  ├─ SftpSession (nivel conexión)   │    russh 0.54 (backend ring)
│  └─ LocalTerminalRegistry          │    SSH Agent (AgentSigner)
│                                     │
│  Wire Protocol v1                   │
│  [Type:1][Length:4][Payload:n]       │
└─────────────────────────────────────┘
```

**Comunicación de doble plano**: tramas binarias WebSocket para I/O de terminal (sin sobrecarga de serialización), IPC de Tauri para comandos estructurados y eventos. El frontend nunca accede a `sessionId` ni a `connectionId` — todo se direcciona por `nodeId`, resuelto del lado del servidor por el `NodeRouter`.

---

## Aspectos técnicos destacados

### 🔩 SSH puro en Rust — russh 0.54

OxideTerm incluye **russh 0.54** compilado con el backend criptográfico `ring`:
- **Cero dependencias C/OpenSSL** en la ruta SSH — toda la pila criptográfica es Rust
- Protocolo SSH2 completo: intercambio de claves, canales, subsistema SFTP, reenvío de puertos
- Suites ChaCha20-Poly1305 y AES-GCM, claves Ed25519/RSA/ECDSA

### 🔑 Autenticación con SSH Agent (AgentSigner)

Un `AgentSigner` personalizado envuelve el SSH Agent del sistema y satisface el trait `Signer` de russh:

```rust
// Resuelve el problema de RPITIT Send bound en russh 0.54
// clonando &PublicKey a un valor propio antes de cruzar el .await
pub struct AgentSigner { /* ... */ }
impl Signer for AgentSigner { /* desafío-respuesta vía IPC del Agent */ }
```

- **Plataformas**: Unix (`SSH_AUTH_SOCK`), Windows (`\\.\pipe\openssh-ssh-agent`)
- **Cadenas proxy**: cada salto puede usar autenticación Agent de forma independiente
- **Reconexión**: `AuthMethod::Agent` se reproduce automáticamente al reconectar

### 🧭 Arquitectura Node-First (NodeRouter)

La **abstracción de nodos Oxide-Next** elimina toda una clase de condiciones de carrera:

```
Frontend: useNodeState(nodeId) → { readiness, sftpReady, error }
Backend:  NodeRouter.resolve(nodeId) → ConnectionEntry → SftpSession
```

- Las operaciones SFTP/IDE del frontend solo transmiten `nodeId` — sin `sessionId`, sin `connectionId`
- El backend resuelve `nodeId → ConnectionEntry` de forma atómica
- La reconexión SSH cambia `connectionId` — SFTP/IDE **no se ven afectados**
- `NodeEventEmitter` emite eventos tipados con contadores de generación para el ordenamiento

### ⚙️ Terminal local — PTY seguro para hilos

Shell local multiplataforma mediante `portable-pty 0.8`, protegido tras el feature gate `local-terminal`:

- **Seguridad de hilos**: `MasterPty` envuelto en `std::sync::Mutex` con `unsafe impl Sync`
- **Hilos de I/O dedicados**: las lecturas bloqueantes del PTY nunca tocan el bucle de eventos de Tokio
- **Detección de shell**: detecta automáticamente `zsh`, `bash`, `fish`, `pwsh`, Git Bash, WSL2
- **Feature gate**: `cargo build --no-default-features` elimina el PTY para compilaciones móviles

### 🔌 Sistema de plugins en tiempo de ejecución (v1.6.2+)

Carga dinámica de plugins con API congelada y reforzada en seguridad:

- **API PluginContext**: 8 espacios de nombres (terminal, ui, commands, settings, lifecycle, events, storage, system)
- **24 componentes UI Kit**: componentes React preconstruidos inyectados en los sandboxes de plugins
- **Modelo de seguridad**: `Object.freeze` + Proxy ACL, circuit breaker, lista blanca de IPC
- **Arquitectura Membrane**: los plugins se ejecutan en contextos ESM aislados con un puente controlado al host

### 🛡️ Pool de conexiones SSH

`SshConnectionRegistry` con conteo de referencias, basado en DashMap:

- Múltiples terminales, SFTP y reenvíos de puertos comparten **una sola conexión SSH física**
- Máquinas de estado independientes por conexión (connecting → active → idle → link_down → reconnecting)
- Tiempo de inactividad (30 min), keep-alive (15s), detección de fallos por heartbeat
- Heartbeat local del WsBridge: intervalo de 30s, timeout de 5 min (tolera App Nap)
- La desconexión por inactividad emite `connection_status_changed` para notificar al frontend
- Propagación en cascada: host de salto caído → todos los nodos aguas abajo marcados como `link_down`
- **Detección inteligente**: `visibilitychange` + evento `online` → sondeo SSH proactivo (~2s vs 15-30s pasivo)
- **Grace Period**: ventana de 30s para recuperar la conexión existente antes de reconectar destructivamente (preserva aplicaciones TUI como yazi/vim)

### 🔀 Reenvío de puertos — I/O sin bloqueos

Reenvío completo local (-L), remoto (-R) y SOCKS5 dinámico (-D):

- **Arquitectura de paso de mensajes**: el canal SSH es propiedad de una única tarea `ssh_io`, sin `Arc<Mutex<Channel>>`
- **Reporte de muerte**: las tareas de reenvío informan activamente la razón de salida al desconectarse de SSH
- **Auto-restauración**: los reenvíos `Suspended` se reanudan al reconectar
- **Timeout de inactividad**: `FORWARD_IDLE_TIMEOUT` (300s) previene conexiones zombi

### 🤖 Asistente IA de terminal

IA de modo dual con diseño que prioriza la privacidad:

- **Panel inline** (`⌘I`): comandos rápidos, inyectados vía bracketed paste
- **Chat lateral**: conversación persistente con historial
- **Captura de contexto**: Terminal Registry recopila el buffer del panel activo o de todos los paneles divididos
- **Contexto multi-fuente**: inyección automática de archivos del IDE, rutas SFTP y estado de Git en las conversaciones de IA
- **Uso de herramientas**: más de 40 herramientas integradas (operaciones de archivos, gestión de procesos, red, interacción TUI) que la IA puede invocar de forma autónoma
- **Soporte MCP**: conexión a servidores externos de [Model Context Protocol](https://modelcontextprotocol.io) (stdio y SSE) para extender la IA con herramientas de terceros — gestionados desde Configuración
- **Compatible**: OpenAI, Ollama, DeepSeek, OneAPI, cualquier endpoint `/v1/chat/completions`
- **Seguro**: claves API en el llavero del sistema operativo (macOS Keychain / Windows Credential Manager); en macOS, las lecturas están protegidas por **Touch ID** vía `LAContext` — sin entitlements ni firma de código requerida

### � Base de Conocimiento RAG para Operaciones (v0.20)

Generación aumentada por recuperación, local primero, para documentación operativa:

- **Colecciones de documentos**: importe runbooks, SOPs y guías de despliegue en Markdown/TXT en colecciones con alcance global o por conexión
- **Búsqueda híbrida**: índice BM25 por palabras clave + similitud coseno vectorial, fusionados mediante Reciprocal Rank Fusion (RRF)
- **Fragmentación consciente de Markdown**: división por jerarquía de encabezados, preservando rutas de sección (ej. "Despliegue > Docker > Solución de problemas")
- **Soporte CJK**: tokenizador bigrama para chino/japonés/coreano + tokenización por espacios para scripts latinos
- **Integración IA**: la herramienta `search_docs` recupera automáticamente contexto documental relevante durante las conversaciones de IA — sin activación manual
- **Edición externa**: abra documentos en el editor del sistema, sincronización automática al reenfocar la ventana con bloqueo optimista de versión
- **Reindexación con progreso**: reconstrucción completa de BM25 con barra de progreso en tiempo real y soporte de cancelación
- **Pipeline de embeddings**: el frontend genera vectores a través del proveedor de IA, almacenados en el backend para recuperación híbrida
- **Almacenamiento**: base de datos embebida redb, 9 tablas, serialización MessagePack con compresión automática para fragmentos grandes

### �💻 Modo IDE — Edición remota

Editor CodeMirror 6 sobre SFTP — sin instalación del lado del servidor por defecto; Linux soporta un agente remoto ligero opcional para capacidades mejoradas:

- **Árbol de archivos**: carga diferida con indicadores de estado de Git
- **Más de 30 modos de lenguaje**: 16 nativos de CodeMirror + modos heredados
- **Resolución de conflictos**: bloqueo optimista basado en mtime
- **Git basado en eventos**: actualización automática al guardar, crear, eliminar, renombrar y al presionar Enter en terminal
- **State Gating**: I/O bloqueado cuando `readiness !== 'ready'`, Key-Driven Reset al reconectar
- **Agente remoto Linux (opcional)**: binario Rust de ~1 MB, auto-desplegado en x86_64/aarch64. Arquitecturas adicionales (ARMv7, RISC-V64, LoongArch64, s390x, etc.) disponibles en `agents/extra/` para carga manual

### 🔐 Exportación cifrada .oxide

Formato portátil de copia de seguridad de conexiones:

- **ChaCha20-Poly1305 AEAD**: cifrado autenticado
- **Argon2id KDF** (256 MB de memoria, 4 iteraciones) — resistente a fuerza bruta por GPU
- **SHA-256**: suma de verificación de integridad
- **Incrustación opcional de claves**: claves privadas codificadas en base64 dentro del payload cifrado
- **Análisis previo**: desglose de tipos de autenticación, detección de claves faltantes

### 📡 ProxyJump — Multi-salto con conciencia topológica

- Profundidad de cadena ilimitada: `Cliente → Salto A → Salto B → … → Destino`
- Análisis automático de SSH Config, construcción de grafo topológico, cálculo de ruta Dijkstra
- Los nodos de salto son reutilizables como sesiones independientes
- Propagación de fallos en cascada con sincronización automática de estado aguas abajo

### 📊 Perfilador de recursos

Monitoreo en tiempo real de hosts remotos a través de un canal SSH shell persistente:

- Lee `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/net/dev`
- Cálculo de CPU% y rendimiento de red basado en deltas
- Un solo canal — evita el agotamiento de MaxSessions
- Degrada automáticamente a solo RTT en hosts no Linux o tras fallos consecutivos

### 🖼️ Galería de imágenes de fondo

Sistema de múltiples imágenes de fondo con control de transparencia por pestaña:

- **Gestión de galería**: sube múltiples imágenes, haz clic en miniaturas para cambiar, elimina por imagen o limpia todo
- **Interruptor maestro**: activa/desactiva el fondo globalmente sin eliminar las imágenes
- **Control por pestaña**: 13 tipos de pestaña individualmente configurables (terminal, SFTP, IDE, configuración, topología, etc.)
- **Personalización**: opacidad (3–50%), desenfoque (0–20px), modo de ajuste (cover/contain/fill/tile)
- **Adaptado a la plataforma**: soporte de transparencia en macOS; se excluye la ruta WSLg en Windows (canvas VNC opaco)
- **Seguridad**: eliminación con rutas canonicalizadas para prevenir directory traversal; propagación completa de errores desde el backend Rust

### 🏎️ Renderizado adaptativo — Frecuencia de actualización dinámica

Un programador de renderizado de tres niveles reemplaza el batching RAF fijo, mejorando la capacidad de respuesta durante la salida intensa y reduciendo la carga de GPU/batería durante la inactividad:

| Nivel | Disparador | Frecuencia efectiva | Beneficio |
|---|---|---|---|
| **Boost** | Datos del frame ≥ 4 KB | 120 Hz+ (RAF / ProMotion nativo) | Elimina el lag de scroll en salida rápida |
| **Normal** | Escritura estándar / I/O ligero | 60 Hz (RAF) | Interacción base fluida |
| **Inactivo** | 3s sin I/O, página oculta o ventana sin foco | 1–15 Hz (timer, crecimiento exponencial) | Carga de GPU casi nula, ahorro de batería |

- **Modo automático**: las transiciones están impulsadas por el volumen de datos, la entrada del usuario y la Page Visibility API — sin necesidad de ajuste manual
- **Seguro en segundo plano**: cuando la pestaña está oculta, los datos remotos entrantes continúan vaciándose mediante el timer inactivo — RAF nunca se activa, evitando acumulación de buffers pendientes en pestañas en segundo plano
- **Configuración**: tres modos (Auto / Siempre 60 Hz / Desactivado) en Configuración → Terminal → Renderizador
- **Diagnósticos en vivo**: activa **Mostrar superposición FPS** para ver una insignia de nivel en tiempo real (`B`=boost · `N`=normal · `I`=inactivo), la tasa de frames y el contador de escrituras por segundo flotando en la esquina del terminal

### 🎨 Motor de temas personalizados

Personalización de temas en profundidad más allá de las paletas predefinidas:

- **Más de 30 temas integrados**: Oxide, Dracula, Nord, Catppuccin, Spring Rice, Tokyo Night y más
- **Editor de temas personalizado**: selector visual de colores + entrada hexadecimal RGB para cada campo
- **Colores del terminal**: los 22 campos de xterm.js (fondo, primer plano, cursor, selección, 16 colores ANSI)
- **Colores de la interfaz**: 19 variables CSS en 5 categorías — Fondo (5), Texto (3), Bordes (3), Acento (4), Colores de estado semántico (4)
- **Auto-derivación**: generación con un clic de colores de UI a partir de la paleta del terminal
- **Vista previa en vivo**: mini terminal en tiempo real + vista previa de la interfaz mientras se edita
- **Duplicar y extender**: crea nuevos temas duplicando cualquier tema integrado o personalizado
- **Persistente**: los temas personalizados se guardan en localStorage y sobreviven a las actualizaciones de la aplicación

### 🪟 Optimización profunda para Windows

- **Integración nativa de ConPTY**: invocación directa de la API Windows Pseudo Console (ConPTY) para soporte perfecto de TrueColor y secuencias de escape ANSI — sin el obsoleto WinPTY.
- **Detección inteligente de shell**: escáner integrado que detecta automáticamente **PowerShell 7 (pwsh)**, **Git Bash**, **WSL2** y CMD heredado a través del Registro y PATH.
- **Experiencia nativa**: Rust maneja directamente los eventos de ventana — velocidad de respuesta muy superior a las aplicaciones Electron.

### 📊 Buffer de scroll del backend

- **Persistencia de alta capacidad**: **100.000 líneas** por defecto de salida de terminal, serializable a disco (formato MessagePack).
- **Búsqueda de alto rendimiento**: `spawn_blocking` aísla las tareas de búsqueda regex, evitando bloquear el runtime de Tokio.
- **Eficiencia de memoria**: diseño de buffer circular que desaloja automáticamente los datos más antiguos, manteniendo el uso de memoria controlado.

### ⚛️ Arquitectura de estado Multi-Store

El frontend adopta un patrón **Multi-Store** (16 stores) para manejar dominios de estado drásticamente diferentes:

| Store | Rol |
|---|---|
| **SessionTreeStore** | Intención del usuario — estructura de árbol, flujo de conexión, organización de sesiones |
| **AppStore** | Capa de hechos — estado real de conexiones SSH vía Map `connections`, sincronizado desde SessionTreeStore |
| **IdeStore** | Modo IDE — edición remota de archivos, estado de Git, editor multi-pestaña |
| **LocalTerminalStore** | Ciclo de vida del PTY local, monitoreo de procesos Shell, I/O independiente |
| **ReconnectOrchestratorStore** | Pipeline de auto-reconexión (snapshot → grace-period → ssh-connect → await-terminal → restore) |
| **TransferStore** | Cola y progreso de transferencias SFTP |
| **PluginStore** | Estado en tiempo de ejecución de plugins y registro de UI |
| **ProfilerStore** | Métricas del perfilador de recursos |
| **AiChatStore** | Estado de conversación del chat IA |
| **SettingsStore** | Configuración de la aplicación |
| **BroadcastStore** | Difusión de entrada — replica pulsaciones de teclas en múltiples paneles |
| **CommandPaletteStore** | Estado de apertura/cierre de la paleta de comandos |
| **EventLogStore** | Registro de eventos del ciclo de vida de conexión y reconexión |
| **LauncherStore** | Estado del lanzador de aplicaciones de la plataforma |
| **RecordingStore** | Grabación y reproducción de sesiones de terminal |
| **UpdateStore** | Ciclo de vida de actualización automática (check → download → install) |

A pesar de las diferentes fuentes de estado, la lógica de renderizado está unificada a través de los componentes `TerminalView` e `IdeView`.

---

## Pila tecnológica

| Capa | Tecnología | Detalles |
|---|---|---|
| **Framework** | Tauri 2.0 | Binario nativo, ~15 MB, sin Electron |
| **Runtime** | Tokio + DashMap 6 | Totalmente asíncrono con mapas concurrentes sin bloqueos |
| **SSH** | russh 0.54 (`ring`) | Rust puro, cero deps C, SSH Agent |
| **PTY local** | portable-pty 0.8 | Feature-gated, ConPTY en Windows |
| **Frontend** | React 19.1 + TypeScript 5.8 | Vite 7, Tailwind CSS 4 |
| **Estado** | Zustand 5 | 16 stores especializados, sincronización basada en eventos |
| **Terminal** | xterm.js 6 + WebGL | Acelerado por GPU, 60fps+ |
| **Editor** | CodeMirror 6 | 16 paquetes de lenguaje + modos heredados |
| **Cifrado** | ChaCha20-Poly1305 + Argon2id | AEAD + KDF resistente a memoria |
| **Almacenamiento** | redb 2.1 | BD embebida para sesiones, reenvíos, transferencias |
| **Serialización** | MessagePack (rmp-serde) | Persistencia binaria de buffers/estado |
| **i18n** | i18next 25 | 11 idiomas × 21 espacios de nombres |
| **SFTP** | russh-sftp 2.0 | Protocolo de transferencia de archivos SSH |
| **WebSocket** | tokio-tungstenite 0.24 | WebSocket asíncrono para el plano de datos del terminal |
| **Protocolo** | Wire Protocol v1 | Binario `[Type:1][Length:4][Payload:n]` sobre WebSocket |
| **Plugins** | ESM Runtime | PluginContext congelado + 24 componentes UI Kit |

---

## Matriz de características

| Categoría | Características |
|---|---|
| **Terminal** | PTY local, SSH remoto, paneles divididos (H/V), grabación/reproducción de sesiones (asciicast v2), contexto IA entre paneles, renderizado WebGL, galería de imágenes de fondo, 30+ temas + editor de temas personalizado, paleta de comandos (`⌘K`), modo zen (`⌘⇧Z`), atajos de tamaño de fuente (`⌘+`/`⌘-`) |
| **SSH** | Pool de conexiones, multiplexación, ProxyJump (∞ saltos), grafo topológico, pipeline de auto-reconexión |
| **Autenticación** | Contraseña, clave SSH (RSA/Ed25519/ECDSA), SSH Agent, certificado, Keyboard-Interactive (2FA), Known Hosts |
| **Archivos** | Navegador SFTP de doble panel, arrastrar y soltar, vista previa (imágenes/vídeo/audio/PDF/código/hex), cola de transferencias |
| **IDE** | Árbol de archivos, editor CodeMirror, multi-pestaña, estado Git, resolución de conflictos, terminal integrado |
| **Reenvío** | Local (-L), Remoto (-R), SOCKS5 dinámico (-D), auto-restauración, reporte de muerte, I/O sin bloqueos |
| **IA** | Panel inline + chat lateral, streaming SSE, inserción de código, más de 40 herramientas, integración de servidores MCP, contexto multi-fuente, base de conocimiento RAG, OpenAI/Ollama/DeepSeek |
| **Plugins** | Carga ESM en runtime, 8 espacios de nombres API, 24 UI Kit, sandbox, circuit breaker |
| **WSL Graphics** ⚠️ | Visor VNC integrado (Experimental): modo escritorio (9 entornos) + modo aplicación (GUI individual), detección WSLg, Xtigervnc + noVNC, reconexión, feature-gated |
| **Seguridad** | Cifrado .oxide, llavero del SO, memoria `zeroize`, TOFU para claves de host |
| **i18n** | EN, 简体中文, 繁體中文, 日本語, FR, DE, ES, IT, 한국어, PT-BR, VI |

---

## Características destacadas

### 🚀 Experiencia de terminal híbrido
- **Shell local sin latencia**: IPC directo con procesos locales, latencia casi nula.
- **SSH remoto de alto rendimiento**: flujo binario WebSocket, evitando la sobrecarga HTTP tradicional.
- **Herencia completa de entorno**: hereda PATH, HOME y todas las variables de entorno — igualando la experiencia del terminal del sistema.

### 🔐 Autenticación diversa
- **Contraseña**: almacenada de forma segura en el llavero del sistema.
- **Autenticación por clave**: RSA / Ed25519 / ECDSA, escaneo automático de `~/.ssh/id_*`.
- **SSH Agent**: agente del sistema vía `AgentSigner` (macOS/Linux/Windows).
- **Certificado**: Certificados OpenSSH.
- **2FA/MFA**: autenticación Keyboard-Interactive.
- **Known Hosts**: verificación de clave de host con TOFU y `~/.ssh/known_hosts`.

### 🔍 Búsqueda de texto completo
Búsqueda de contenido de archivos en todo el proyecto con caché inteligente:
- **Búsqueda en tiempo real**: entrada con debounce de 300ms y resultados instantáneos.
- **Caché de resultados**: caché con TTL de 60 segundos para evitar escaneos repetidos.
- **Agrupación de resultados**: agrupados por archivo con posicionamiento por número de línea.
- **Resaltado de coincidencias**: términos de búsqueda resaltados en fragmentos de vista previa.
- **Limpieza automática**: caché invalidada al cambiar archivos.

### 📦 Gestión avanzada de archivos
- **Protocolo SFTP v3**: gestor de archivos completo de doble panel.
- **Arrastrar y soltar**: operaciones por lotes de múltiples archivos y carpetas.
- **Vista previa inteligente**:
  - 🎨 Imágenes (JPEG/PNG/GIF/WebP)
  - 🎬 Vídeos (MP4/WebM) con reproductor integrado
  - 🎵 Audio (MP3/WAV/OGG/FLAC) con visualización de metadatos
  - 💻 Resaltado de código (más de 30 lenguajes)
  - 📄 Documentos PDF
  - 🔍 Visor hexadecimal (archivos binarios)
- **Seguimiento de progreso**: velocidad en tiempo real, barras de progreso, tiempo estimado de finalización.

### 🌍 Internacionalización (i18n)
- **11 idiomas**: English, 简体中文, 繁體中文, 日本語, Français, Deutsch, Español, Italiano, 한국어, Português, Tiếng Việt.
- **Carga dinámica**: paquetes de idioma bajo demanda vía i18next.
- **Tipado seguro**: definiciones TypeScript para todas las claves de traducción.

<details>
<summary>📸 Los 11 idiomas en acción</summary>
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

### 🌐 Optimización de red
- **Arquitectura de doble plano**: plano de datos (WebSocket directo) y plano de control (IPC Tauri) separados.
- **Protocolo binario personalizado**: `[Type:1][Length:4][Payload:n]`, sin sobrecarga de serialización JSON.
- **Control de contrapresión**: previene desbordamiento de memoria durante tráfico en ráfaga.
- **Auto-reconexión**: reintento con retroceso exponencial, hasta 5 intentos.

### 🖥️ WSL Graphics (⚠️ Experimental)
- **Modo escritorio**: escritorios GUI Linux completos dentro de una pestaña de terminal — 9 entornos de escritorio (Xfce / GNOME / KDE Plasma / MATE / LXDE / Cinnamon / Openbox / Fluxbox / IceWM), detectados automáticamente.
- **Modo aplicación**: lanza una sola aplicación GUI (p. ej., `gedit`, `firefox`) sin un escritorio completo — Xtigervnc ligero + Openbox WM opcional, limpieza automática al cerrar la aplicación.
- **Detección de WSLg**: detección automática de la disponibilidad de WSLg (sockets Wayland / X11) por distribución, mostrada como insignia en la UI.
- **Xtigervnc + noVNC**: servidor X independiente renderizado vía `<canvas>` integrado, con `scaleViewport` y `resizeSession`.
- **Seguridad**: inyección de arrays `argv` (sin parsing de shell), `env_clear()` + lista blanca mínima, `validate_argv()` con 6 reglas de defensa, límites de concurrencia (4 sesiones de app/distribución, 8 globales).
- **Reconexión**: restablecimiento del puente WebSocket sin matar la sesión VNC.
- **Feature-gated**: feature de Cargo `wsl-graphics`, comandos stub en plataformas no Windows.

---

## Inicio rápido

### Requisitos previos

- **Rust** 1.75+
- **Node.js** 18+ (se recomienda pnpm)
- **Herramientas de plataforma**:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio C++ Build Tools
  - Linux: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`

### Desarrollo

```bash
git clone https://github.com/AnalyseDeCircuit/OxideTerm.git
cd OxideTerm && pnpm install

# Aplicación completa (frontend + backend Rust + PTY local)
pnpm tauri dev

# Solo frontend (hot reload en el puerto 1420)
pnpm dev

# Compilación de producción
pnpm tauri build

# Kernel ligero — elimina PTY local para móviles
cd src-tauri && cargo build --no-default-features --release
```

---

## Estructura del proyecto

```
OxideTerm/
├── src/                            # Frontend — 83K líneas TypeScript
│   ├── components/                 # 20 directorios
│   │   ├── terminal/               #   Vistas de terminal, paneles divididos, búsqueda
│   │   ├── sftp/                   #   Navegador de archivos de doble panel
│   │   ├── ide/                    #   Editor, árbol de archivos, diálogos Git
│   │   ├── ai/                     #   Chat inline + lateral
│   │   ├── graphics/               #   WSL Graphics (escritorio VNC + visor de apps)
│   │   ├── plugin/                 #   Gestor de plugins y UI de runtime
│   │   ├── forwards/               #   Gestión de reenvío de puertos
│   │   ├── connections/            #   CRUD de conexiones e importación
│   │   ├── topology/               #   Grafo de topología de red
│   │   ├── layout/                 #   Barra lateral, encabezado, paneles divididos
│   │   └── ...                     #   Sesiones, configuración, modales, etc.
│   ├── store/                      # 16 stores Zustand
│   ├── lib/                        # Capa API, proveedores IA, runtime de plugins
│   ├── hooks/                      # Hooks de React (eventos, teclado, toast)
│   ├── types/                      # Definiciones de tipos TypeScript
│   └── locales/                    # 11 idiomas × 21 espacios de nombres
│
├── src-tauri/                      # Backend — 51K líneas Rust
│   └── src/
│       ├── router/                 #   NodeRouter (nodeId → recurso)
│       ├── ssh/                    #   Cliente SSH (12 módulos incl. Agent)
│       ├── local/                  #   PTY local (feature-gated)
│       ├── graphics/               #   WSL Graphics (feature-gated)
│       ├── bridge/                 #   Puente WebSocket y Wire Protocol v1
│       ├── session/                #   Gestión de sesiones (16 módulos)
│       ├── forwarding/             #   Reenvío de puertos (6 módulos)
│       ├── sftp/                   #   Implementación SFTP
│       ├── config/                 #   Bóveda, llavero, configuración SSH
│       ├── oxide_file/             #   Cifrado .oxide (ChaCha20)
│       ├── commands/               #   24 módulos de comandos IPC Tauri
│       └── state/                  #   Tipos de estado global
│
└── docs/                           # 27+ documentos de arquitectura y características
```

---

## Hoja de ruta

### 🚧 En progreso (v0.20)

- [ ] Base de conocimiento RAG — colecciones de documentos locales con búsqueda híbrida BM25 + vectorial, recuperación integrada con IA
- [ ] Búsqueda de sesiones e intercambio rápido

### 📋 Planificado

- [ ] Reenvío de SSH Agent

---

## Seguridad

| Aspecto | Implementación |
|---|---|
| **Contraseñas** | Llavero del SO (macOS Keychain / Windows Credential Manager / Linux libsecret) |
| **Claves API de IA** | Llavero del SO bajo el servicio `com.oxideterm.ai`; en macOS, la lectura de claves requiere **Touch ID** (verificación biométrica vía `LocalAuthentication.framework`, sin necesidad de entitlements de protección de datos) — las claves se almacenan en caché en memoria después de la primera autenticación, Touch ID solo se solicita una vez por sesión |
| **Archivos de config** | `~/.oxideterm/connections.json` — almacena solo IDs de referencia al llavero |
| **Exportación** | .oxide: ChaCha20-Poly1305 + Argon2id, incrustación de claves opcional |
| **Memoria** | `zeroize` limpia datos sensibles; Rust garantiza seguridad de memoria |
| **Claves de host** | TOFU con `~/.ssh/known_hosts` |
| **Plugins** | Object.freeze + Proxy ACL, circuit breaker, lista blanca de IPC |

---

## Licencia

**PolyForm Noncommercial 1.0.0**

- ✅ Uso personal / sin fines de lucro: gratuito
- 🚫 Uso comercial: requiere licencia
- ⚖️ Cláusula de defensa de patentes (Cláusula Nuclear)

Texto completo: https://polyformproject.org/licenses/noncommercial/1.0.0/

---

## Agradecimientos

- [russh](https://github.com/warp-tech/russh) — SSH puro en Rust
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty) — PTY multiplataforma
- [Tauri](https://tauri.app/) — Framework de aplicaciones nativas
- [xterm.js](https://xtermjs.org/) — Emulador de terminal
- [CodeMirror](https://codemirror.net/) — Editor de código
- [Radix UI](https://www.radix-ui.com/) — Primitivas de UI accesibles

---

<p align="center">
  <sub>Construido con Rust y Tauri — 130.000+ líneas de código</sub>
</p>
