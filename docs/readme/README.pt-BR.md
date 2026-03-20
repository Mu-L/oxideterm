<p align="center">
  <img src="../../src-tauri/icons/icon.ico" alt="OxideTerm" width="128" height="128">
</p>

<h1 align="center">⚡ OxideTerm</h1>

<p align="center">
  <strong>Motor de Terminal em Rust — Além do SSH</strong>
  <br>
  <em>130.000+ linhas de Rust &amp; TypeScript. Zero Electron. Zero dependências C na pilha SSH.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.19.2-blue" alt="Versão">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Plataforma">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blueviolet" alt="Licença">
  <img src="https://img.shields.io/badge/rust-1.75+-orange" alt="Rust">
  <img src="https://img.shields.io/badge/tauri-2.0-purple" alt="Tauri">
</p>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-Hans.md">简体中文</a> | <a href="README.zh-Hant.md">繁體中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

---

<p align="center">
  <img src="../media/ai-terminal-demo.gif" alt="Demo IA do OxideTerm">
</p>
<p align="center"><em>🤖 Assistente IA — "Abra um terminal local e execute echo hello, world!"</em></p>

## O que é o OxideTerm?

OxideTerm é uma **aplicação de terminal multiplataforma** que unifica shells locais, sessões SSH remotas, gerenciamento de arquivos, edição de código e assistência de IA em um único binário nativo Rust. **Não** é um wrapper Electron — todo o backend é escrito em Rust, distribuído como um executável nativo de 20-35 MB via Tauri 2.0.

### Por que mais um terminal?

| Problema | Resposta do OxideTerm |
|---|---|
| Clientes SSH não fazem shell local | Motor híbrido: PTY local + SSH remoto na mesma janela |
| Reconectar = perder tudo | **Arquitetura Node-first**: reconexão automática com Grace Period preserva aplicações TUI; restaura encaminhamentos, transferências e estado do IDE |
| Edição remota precisa do VS Code Remote | **Modo IDE integrado**: editor CodeMirror 6 via SFTP, sem instalação no servidor por padrão; agente remoto opcional no Linux |
| Sem reutilização de conexão SSH | **Multiplexação SSH**: terminal, SFTP e encaminhamentos compartilham uma única conexão |
| Bibliotecas SSH dependem do OpenSSL | **russh 0.54**: SSH puro Rust, backend criptográfico `ring`, zero deps C |

---

## Arquitetura em um Olhar

```
┌─────────────────────────────────────┐
│        Frontend (React 19)          │
│                                     │
│  SessionTreeStore ──► AppStore      │    16 stores Zustand
│  IdeStore    LocalTerminalStore     │    20 diretórios de componentes
│  ReconnectOrchestratorStore         │    11 idiomas × 21 namespaces
│  PluginStore  AiChatStore  ...      │
│                                     │
│        xterm.js 6 + WebGL           │
└──────────┬──────────────┬───────────┘
           │ Tauri IPC    │ WebSocket (binário)
┌──────────▼──────────────▼───────────┐
│         Backend (Rust)              │
│                                     │
│  NodeRouter ── resolve(nodeId) ──►  │    24 módulos de comandos IPC
│  ├─ SshConnectionRegistry          │    Estado concorrente DashMap
│  ├─ SessionRegistry                │    PTY local com feature gate
│  ├─ ForwardingManager              │    Vault ChaCha20-Poly1305
│  ├─ SftpSession (nível de conexão) │    russh 0.54 (backend ring)
│  └─ LocalTerminalRegistry          │    SSH Agent (AgentSigner)
│                                     │
│  Wire Protocol v1                   │
│  [Type:1][Length:4][Payload:n]       │
└─────────────────────────────────────┘
```

**Comunicação em plano duplo**: frames binários WebSocket para I/O do terminal (zero overhead de serialização), IPC Tauri para comandos estruturados e eventos. O frontend nunca acessa `sessionId` ou `connectionId` — tudo é endereçado por `nodeId`, resolvido no lado do servidor pelo `NodeRouter`.

---

## Destaques Técnicos

### 🔩 SSH Puro Rust — russh 0.54

O OxideTerm inclui o **russh 0.54** compilado com o backend criptográfico `ring`:
- **Zero dependências C/OpenSSL** no caminho SSH — toda a pilha criptográfica é em Rust
- Protocolo SSH2 completo: troca de chaves, canais, subsistema SFTP, encaminhamento de portas
- Suítes ChaCha20-Poly1305 e AES-GCM, chaves Ed25519/RSA/ECDSA

### 🔑 Autenticação SSH Agent (AgentSigner)

Um `AgentSigner` personalizado envolve o SSH Agent do sistema e satisfaz a trait `Signer` do russh:

```rust
// Resolve o problema RPITIT Send bound no russh 0.54
// clonando &PublicKey para um valor owned antes de cruzar o .await
pub struct AgentSigner { /* ... */ }
impl Signer for AgentSigner { /* challenge-response via IPC do Agent */ }
```

- **Plataformas**: Unix (`SSH_AUTH_SOCK`), Windows (`\\.\pipe\openssh-ssh-agent`)
- **Cadeias de proxy**: cada salto pode utilizar autenticação Agent de forma independente
- **Reconexão**: `AuthMethod::Agent` é reproduzido automaticamente na reconexão

### 🧭 Arquitetura Node-First (NodeRouter)

A **abstração de nós Oxide-Next** elimina uma classe inteira de condições de corrida:

```
Frontend: useNodeState(nodeId) → { readiness, sftpReady, error }
Backend:  NodeRouter.resolve(nodeId) → ConnectionEntry → SftpSession
```

- As operações SFTP/IDE do frontend passam apenas `nodeId` — sem `sessionId`, sem `connectionId`
- O backend resolve `nodeId → ConnectionEntry` atomicamente
- A reconexão SSH altera o `connectionId` — SFTP/IDE **não são afetados**
- `NodeEventEmitter` emite eventos tipados com contadores de geração para ordenação

### ⚙️ Terminal Local — PTY Thread-Safe

Shell local multiplataforma via `portable-pty 0.8`, protegido pelo feature gate `local-terminal`:

- **Thread safety**: `MasterPty` envolvido em `std::sync::Mutex` com `unsafe impl Sync`
- **Threads de I/O dedicadas**: leituras bloqueantes do PTY nunca tocam o event loop do Tokio
- **Detecção de shell**: descobre automaticamente `zsh`, `bash`, `fish`, `pwsh`, Git Bash, WSL2
- **Feature gate**: `cargo build --no-default-features` remove o PTY para builds mobile

### 🔌 Sistema de Plugins Runtime (v1.6.2+)

Carregamento dinâmico de plugins com API congelada e segurança reforçada:

- **API PluginContext**: 8 namespaces (terminal, ui, commands, settings, lifecycle, events, storage, system)
- **24 componentes UI Kit**: componentes React pré-construídos injetados nos sandboxes dos plugins
- **Modelo de segurança**: `Object.freeze` + Proxy ACL, circuit breaker, whitelist IPC
- **Arquitetura Membrane**: plugins executam em contextos ESM isolados com bridge controlado para o host

### 🛡️ Pool de Conexões SSH

`SshConnectionRegistry` com contagem de referências, baseado em DashMap:

- Múltiplos terminais, SFTP e encaminhamentos de porta compartilham **uma única conexão SSH física**
- Máquinas de estado independentes por conexão (connecting → active → idle → link_down → reconnecting)
- Timeout de inatividade (30 min), keep-alive (15s), detecção de falhas por heartbeat
- Heartbeat local WsBridge: intervalo de 30s, timeout de 5 min (tolera App Nap)
- A desconexão por inatividade emite `connection_status_changed` para notificar o frontend
- Propagação em cascata: host de salto inativo → todos os nós downstream marcados como `link_down`
- **Detecção inteligente**: `visibilitychange` + evento `online` → sondagem SSH proativa (~2s vs 15-30s passivo)
- **Grace Period**: janela de 30s para recuperar a conexão existente antes da reconexão destrutiva (preserva aplicações TUI como yazi/vim)

### 🔀 Encaminhamento de Portas — I/O Lock-Free

Encaminhamento local (-L), remoto (-R) e SOCKS5 dinâmico (-D) completo:

- **Arquitetura de troca de mensagens**: o canal SSH é propriedade de um único task `ssh_io`, sem `Arc<Mutex<Channel>>`
- **Relatório de término**: tasks de encaminhamento reportam ativamente o motivo da saída na desconexão SSH
- **Auto-restauração**: encaminhamentos `Suspended` são retomados na reconexão
- **Timeout de inatividade**: `FORWARD_IDLE_TIMEOUT` (300s) previne conexões zumbi

### 🤖 Assistente de Terminal IA

IA em modo duplo com design focado em privacidade:

- **Painel inline** (`⌘I`): comandos rápidos, injetados via bracketed paste
- **Chat lateral**: conversa persistente com histórico
- **Captura de contexto**: Terminal Registry coleta o buffer do painel ativo ou de todos os painéis divididos
- **Contexto multi-fonte**: injeção automática de arquivos IDE, caminhos SFTP e status Git nas conversas de IA
- **Uso de ferramentas**: mais de 40 ferramentas integradas (operações de arquivo, gerenciamento de processos, rede, interação TUI) que a IA pode invocar autonomamente
- **Suporte MCP**: conexão com servidores externos [Model Context Protocol](https://modelcontextprotocol.io) (stdio e SSE) para estender a IA com ferramentas de terceiros — gerenciado nas Configurações
- **Compatível**: OpenAI, Ollama, DeepSeek, OneAPI, qualquer endpoint `/v1/chat/completions`
- **Seguro**: chaves de API no chaveiro do sistema operacional (macOS Keychain / Windows Credential Manager); no macOS, leituras são protegidas pelo **Touch ID** via `LAContext` — sem necessidade de entitlements ou assinatura de código

### � Base de Conhecimento RAG para Operações (v0.20)

Geração aumentada por recuperação, local primeiro, para documentação operacional:

- **Coleções de documentos**: importe runbooks, SOPs e guias de implantação em Markdown/TXT em coleções com escopo global ou por conexão
- **Busca híbrida**: índice BM25 por palavras-chave + similaridade cosseno vetorial, fundidos via Reciprocal Rank Fusion (RRF)
- **Fragmentação consciente de Markdown**: divisão por hierarquia de cabeçalhos, preservando caminhos de seção (ex. "Implantação > Docker > Solução de problemas")
- **Suporte CJK**: tokenizador bigrama para chinês/japonês/coreano + tokenização por espaços para scripts latinos
- **Integração IA**: a ferramenta `search_docs` recupera automaticamente contexto documental relevante durante conversas de IA — sem acionamento manual
- **Edição externa**: abra documentos no editor do sistema, sincronização automática ao refocar a janela com bloqueio otimista de versão
- **Reindexação com progresso**: reconstrução completa do BM25 com barra de progresso em tempo real e suporte a cancelamento
- **Pipeline de embeddings**: o frontend gera vetores via provedor de IA, armazenados no backend para recuperação híbrida
- **Armazenamento**: banco de dados embutido redb, 9 tabelas, serialização MessagePack com compressão automática para chunks grandes

### �💻 Modo IDE — Edição Remota

Editor CodeMirror 6 via SFTP — sem necessidade de instalação no servidor por padrão; Linux suporta um agente remoto leve opcional para funcionalidades avançadas:

- **Árvore de arquivos**: carregamento lazy com indicadores de status Git
- **Mais de 30 modos de linguagem**: 16 nativos do CodeMirror + modos legados
- **Resolução de conflitos**: bloqueio otimista baseado em mtime
- **Git orientado a eventos**: atualização automática ao salvar, criar, excluir, renomear e pressionar Enter no terminal
- **State Gating**: I/O bloqueado quando `readiness !== 'ready'`, Key-Driven Reset na reconexão
- **Agente remoto Linux (opcional)**: binário Rust de ~1 MB, implantação automática em x86_64/aarch64. Arquiteturas adicionais (ARMv7, RISC-V64, LoongArch64, s390x, etc.) disponíveis em `agents/extra/` para upload manual

### 🔐 Exportação Criptografada .oxide

Formato portátil de backup de conexões:

- **ChaCha20-Poly1305 AEAD**: criptografia autenticada
- **Argon2id KDF** (256 MB de memória, 4 iterações) — resistente a brute-force via GPU
- **SHA-256**: checksum de integridade
- **Incorporação opcional de chaves**: chaves privadas codificadas em base64 no payload criptografado
- **Análise prévia**: análise dos tipos de autenticação, detecção de chaves ausentes

### 📡 ProxyJump — Multi-Hop com Topologia

- Profundidade de cadeia ilimitada: `Client → Salto A → Salto B → … → Destino`
- Análise automática do SSH Config, construção do grafo topológico, cálculo de caminho Dijkstra
- Nós de salto reutilizáveis como sessões independentes
- Propagação de falhas em cascata com sincronização automática do status downstream

### 📊 Profiler de Recursos

Monitoramento em tempo real de hosts remotos via canal shell SSH persistente:

- Lê `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/net/dev`
- Cálculo de CPU% e throughput de rede baseado em delta
- Canal único — evita exaustão de MaxSessions
- Degrada automaticamente para apenas RTT em hosts não-Linux ou após falhas consecutivas

### 🖼️ Galeria de Imagens de Fundo

Sistema multi-imagem de fundo com controle de transparência por aba:

- **Gerenciamento da galeria**: upload de múltiplas imagens, clique em miniaturas para alternar, exclusão individual ou limpeza total
- **Interruptor principal**: ativa/desativa o fundo globalmente sem excluir as imagens
- **Controle por aba**: 13 tipos de aba configuráveis individualmente (terminal, SFTP, IDE, configurações, topologia, etc.)
- **Personalização**: opacidade (3–50%), desfoque (0–20px), modo de ajuste (cover/contain/fill/tile)
- **Adaptado à plataforma**: suporte a transparência no macOS; caminho WSLg excluído no Windows (canvas VNC opaco)
- **Segurança**: exclusão com caminhos canonicalizados para prevenir travessia de diretório; propagação completa de erros do backend Rust

### 🏎️ Renderização Adaptativa — Taxa de Atualização Dinâmica

Um agendador de renderização em três camadas substitui o batching RAF fixo, melhorando a responsividade durante saída intensa e reduzindo a carga GPU/bateria durante a inatividade:

| Camada | Gatilho | Taxa Efetiva | Benefício |
|---|---|---|---|
| **Boost** | Dados de frame ≥ 4 KB | 120 Hz+ (RAF / ProMotion nativo) | Elimina lag de rolagem em saída rápida |
| **Normal** | Digitação padrão / I/O leve | 60 Hz (RAF) | Interação base fluida |
| **Inativo** | 3s sem I/O, página oculta ou janela sem foco | 1–15 Hz (timer, crescimento exponencial) | Carga GPU quase zero, economia de bateria |

- **Modo automático**: transições guiadas pelo volume de dados, input do usuário e Page Visibility API — sem necessidade de ajuste manual
- **Seguro em background**: quando a aba está oculta, dados remotos recebidos continuam sendo descarregados via timer inativo — RAF nunca é ativado, prevenindo acúmulo de buffers pendentes em abas em segundo plano
- **Configurações**: três modos (Auto / Sempre 60 Hz / Desativado) em Configurações → Terminal → Renderizador
- **Diagnóstico em tempo real**: ative **Mostrar overlay de FPS** para visualizar um badge de camada em tempo real (`B`=boost · `N`=normal · `I`=inativo), taxa de quadros e contador de escritas por segundo flutuando no canto do terminal

### 🎨 Motor de Temas Personalizados

Personalização profunda de temas além das paletas predefinidas:

- **Mais de 30 temas integrados**: Oxide, Dracula, Nord, Catppuccin, Spring Rice, Tokyo Night e outros
- **Editor de temas personalizado**: seletor visual de cores + entrada hexadecimal RGB para cada campo
- **Cores do terminal**: todos os 22 campos do xterm.js (fundo, primeiro plano, cursor, seleção, 16 cores ANSI)
- **Cores da interface**: 19 variáveis CSS em 5 categorias — Fundo (5), Texto (3), Bordas (3), Destaque (4), Cores de status semânticas (4)
- **Auto-derivar**: geração com um clique das cores da UI a partir da paleta do terminal
- **Pré-visualização ao vivo**: mini terminal em tempo real + pré-visualização da interface durante a edição
- **Duplicar e estender**: crie novos temas duplicando qualquer tema integrado ou personalizado
- **Persistente**: temas personalizados salvos no localStorage, sobrevivem a atualizações do aplicativo

### 🪟 Otimização Profunda para Windows

- **Integração nativa ConPTY**: invocação direta da API Windows Pseudo Console (ConPTY) para suporte perfeito a TrueColor e sequências de escape ANSI — sem WinPTY desatualizado.
- **Detecção inteligente de shell**: scanner integrado que detecta automaticamente **PowerShell 7 (pwsh)**, **Git Bash**, **WSL2** e CMD legado via Registro e PATH.
- **Experiência nativa**: Rust lida diretamente com eventos de janela — velocidade de resposta muito superior a aplicações Electron.

### 📊 Buffer de Rolagem Backend

- **Persistência de alta capacidade**: **100.000 linhas** padrão de saída do terminal, serializáveis em disco (formato MessagePack).
- **Busca de alto desempenho**: `spawn_blocking` isola tasks de busca com regex, evitando bloquear o runtime do Tokio.
- **Eficiência de memória**: design de buffer circular que descarta automaticamente dados mais antigos, mantendo o uso de memória controlado.

### ⚛️ Arquitetura Multi-Store

O frontend adota um padrão **Multi-Store** (16 stores) para lidar com domínios de estado drasticamente diferentes:

| Store | Função |
|---|---|
| **SessionTreeStore** | Intenção do usuário — estrutura em árvore, fluxo de conexão, organização de sessões |
| **AppStore** | Camada de fatos — estado real das conexões SSH via Map `connections`, sincronizado do SessionTreeStore |
| **IdeStore** | Modo IDE — edição remota de arquivos, status Git, editor multi-abas |
| **LocalTerminalStore** | Ciclo de vida do PTY local, monitoramento de processos shell, I/O independente |
| **ReconnectOrchestratorStore** | Pipeline de auto-reconexão (snapshot → grace-period → ssh-connect → await-terminal → restore) |
| **TransferStore** | Fila e progresso de transferências SFTP |
| **PluginStore** | Estado do runtime de plugins e registro de UI |
| **ProfilerStore** | Métricas do profiler de recursos |
| **AiChatStore** | Estado da conversa do chat IA |
| **SettingsStore** | Configurações do aplicativo |
| **BroadcastStore** | Broadcast de entrada — replica teclas em múltiplos painéis |
| **CommandPaletteStore** | Estado de abertura/fechamento da paleta de comandos |
| **EventLogStore** | Registro de eventos do ciclo de vida da conexão e da reconexão |
| **LauncherStore** | Estado do lançador de aplicações da plataforma |
| **RecordingStore** | Gravação e reprodução de sessões do terminal |
| **UpdateStore** | Ciclo de vida da atualização automática (check → download → install) |

Apesar das diferentes fontes de estado, a lógica de renderização é unificada através dos componentes `TerminalView` e `IdeView`.

---

## Pilha Tecnológica

| Camada | Tecnologia | Detalhes |
|---|---|---|
| **Framework** | Tauri 2.0 | Binário nativo, ~15 MB, sem Electron |
| **Runtime** | Tokio + DashMap 6 | Totalmente assíncrono com mapas concorrentes lock-free |
| **SSH** | russh 0.54 (`ring`) | Rust puro, zero deps C, SSH Agent |
| **PTY Local** | portable-pty 0.8 | Feature-gated, ConPTY no Windows |
| **Frontend** | React 19.1 + TypeScript 5.8 | Vite 7, Tailwind CSS 4 |
| **Estado** | Zustand 5 | 16 stores especializados, sincronização orientada a eventos |
| **Terminal** | xterm.js 6 + WebGL | Acelerado por GPU, 60fps+ |
| **Editor** | CodeMirror 6 | 16 pacotes de linguagem + modos legados |
| **Criptografia** | ChaCha20-Poly1305 + Argon2id | AEAD + KDF memory-hard |
| **Armazenamento** | redb 2.1 | Banco de dados embutido para sessões, encaminhamentos, transferências |
| **Serialização** | MessagePack (rmp-serde) | Persistência binária de buffer/estado |
| **i18n** | i18next 25 | 11 idiomas × 21 namespaces |
| **SFTP** | russh-sftp 2.0 | Protocolo de Transferência de Arquivos SSH |
| **WebSocket** | tokio-tungstenite 0.24 | WebSocket assíncrono para o plano de dados do terminal |
| **Protocolo** | Wire Protocol v1 | Binário `[Type:1][Length:4][Payload:n]` sobre WebSocket |
| **Plugins** | ESM Runtime | PluginContext congelado + 24 componentes UI Kit |

---

## Matriz de Funcionalidades

| Categoria | Funcionalidades |
|---|---|
| **Terminal** | PTY local, SSH remoto, painéis divididos (H/V), gravação/reprodução de sessões (asciicast v2), contexto IA entre painéis, renderização WebGL, galeria de imagens de fundo, 30+ temas + editor de temas personalizado, paleta de comandos (`⌘K`), modo zen (`⌘⇧Z`), atalhos de tamanho de fonte (`⌘+`/`⌘-`) |
| **SSH** | Pool de conexões, multiplexação, ProxyJump (∞ saltos), grafo topológico, pipeline de auto-reconexão |
| **Autenticação** | Senha, Chave SSH (RSA/Ed25519/ECDSA), SSH Agent, Certificado, Keyboard-Interactive (2FA), Known Hosts |
| **Arquivos** | Navegador SFTP de painel duplo, arrastar-e-soltar, pré-visualização (imagens/vídeo/áudio/PDF/código/hex), fila de transferências |
| **IDE** | Árvore de arquivos, editor CodeMirror, multi-abas, status Git, resolução de conflitos, terminal integrado |
| **Encaminhamento** | Local (-L), Remoto (-R), SOCKS5 dinâmico (-D), auto-restauração, relatório de término, I/O lock-free |
| **IA** | Painel inline + chat lateral, streaming SSE, inserção de código, mais de 40 ferramentas, integração com servidor MCP, contexto multi-fonte, base de conhecimento RAG, OpenAI/Ollama/DeepSeek |
| **Plugins** | Carregamento ESM em runtime, 8 namespaces de API, 24 UI Kit, sandboxed, circuit breaker |
| **WSL Graphics** ⚠️ | Visualizador VNC integrado (Experimental): modo desktop (9 ambientes) + modo aplicação (GUI única), detecção WSLg, Xtigervnc + noVNC, reconexão, feature-gated |
| **Segurança** | Criptografia .oxide, chaveiro do SO, memória `zeroize`, TOFU para chaves de host |
| **i18n** | EN, 简体中文, 繁體中文, 日本語, FR, DE, ES, IT, 한국어, PT-BR, VI |

---

## Destaques de Funcionalidades

### 🚀 Experiência de Terminal Híbrido
- **Shell local com latência zero**: IPC direto com processos locais, latência quase nula.
- **SSH remoto de alto desempenho**: fluxo binário WebSocket, contornando o overhead HTTP tradicional.
- **Herança completa de ambiente**: herda PATH, HOME e todas as variáveis de ambiente — experiência idêntica ao terminal do sistema.

### 🔐 Autenticação Diversificada
- **Senha**: armazenada de forma segura no chaveiro do sistema.
- **Autenticação por chave**: RSA / Ed25519 / ECDSA, varredura automática de `~/.ssh/id_*`.
- **SSH Agent**: agente do sistema via `AgentSigner` (macOS/Linux/Windows).
- **Certificado**: Certificados OpenSSH.
- **2FA/MFA**: autenticação Keyboard-Interactive.
- **Known Hosts**: verificação de chave de host com TOFU e `~/.ssh/known_hosts`.

### 🔍 Busca Full-Text
Busca de conteúdo de arquivos em todo o projeto com cache inteligente:
- **Busca em tempo real**: entrada com debounce de 300ms e resultados instantâneos.
- **Cache de resultados**: cache com TTL de 60 segundos para evitar varreduras repetidas.
- **Agrupamento de resultados**: agrupados por arquivo com posicionamento por número de linha.
- **Destaque de correspondências**: termos buscados destacados nos trechos de pré-visualização.
- **Limpeza automática**: cache invalidado na alteração de arquivos.

### 📦 Gerenciamento Avançado de Arquivos
- **Protocolo SFTP v3**: gerenciador de arquivos completo de painel duplo.
- **Arrastar-e-soltar**: operações em lote com múltiplos arquivos e pastas.
- **Pré-visualização inteligente**:
  - 🎨 Imagens (JPEG/PNG/GIF/WebP)
  - 🎬 Vídeos (MP4/WebM) com reprodutor integrado
  - 🎵 Áudio (MP3/WAV/OGG/FLAC) com exibição de metadados
  - 💻 Destaque de código (mais de 30 linguagens)
  - 📄 Documentos PDF
  - 🔍 Visualizador hexadecimal (arquivos binários)
- **Acompanhamento de progresso**: velocidade em tempo real, barras de progresso, tempo estimado.

### 🌍 Internacionalização (i18n)
- **11 Idiomas**: English, 简体中文, 繁體中文, 日本語, Français, Deutsch, Español, Italiano, 한국어, Português, Tiếng Việt.
- **Carregamento dinâmico**: pacotes de idioma sob demanda via i18next.
- **Type-safe**: definições TypeScript para todas as chaves de tradução.

<details>
<summary>📸 Todos os 11 idiomas em ação</summary>
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

### 🌐 Otimização de Rede
- **Arquitetura de plano duplo**: plano de dados (WebSocket direto) e plano de controle (IPC Tauri) separados.
- **Protocolo binário personalizado**: `[Type:1][Length:4][Payload:n]`, zero overhead de serialização JSON.
- **Controle de contrapressão**: previne estouro de memória durante tráfego em rajada.
- **Auto-reconexão**: retry com backoff exponencial, até 5 tentativas.

### 🖥️ WSL Graphics (⚠️ Experimental)
- **Modo desktop**: desktops GUI Linux completos dentro de uma aba do terminal — 9 ambientes desktop (Xfce / GNOME / KDE Plasma / MATE / LXDE / Cinnamon / Openbox / Fluxbox / IceWM), detectados automaticamente.
- **Modo aplicação**: execute uma única aplicação GUI (ex.: `gedit`, `firefox`) sem um desktop completo — Xtigervnc leve + Openbox WM opcional, limpeza automática ao fechar o aplicativo.
- **Detecção WSLg**: detecção automática da disponibilidade WSLg (sockets Wayland / X11) por distribuição, exibido como badge na interface.
- **Xtigervnc + noVNC**: servidor X autônomo renderizado via `<canvas>` integrado, com `scaleViewport` e `resizeSession`.
- **Segurança**: injeção de array `argv` (sem parsing de shell), `env_clear()` + whitelist mínima, `validate_argv()` com 6 regras de defesa, limites de concorrência (4 sessões app/distro, 8 globais).
- **Reconexão**: restabelecimento da bridge WebSocket sem encerrar a sessão VNC.
- **Feature-gated**: feature Cargo `wsl-graphics`, comandos stub em plataformas não-Windows.

---

## Início Rápido

### Pré-requisitos

- **Rust** 1.75+
- **Node.js** 18+ (pnpm recomendado)
- **Ferramentas de plataforma**:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio C++ Build Tools
  - Linux: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`

### Desenvolvimento

```bash
git clone https://github.com/AnalyseDeCircuit/OxideTerm.git
cd OxideTerm && pnpm install

# Aplicação completa (frontend + backend Rust + PTY local)
pnpm tauri dev

# Apenas frontend (hot reload na porta 1420)
pnpm dev

# Build de produção
pnpm tauri build

# Kernel leve — remove PTY local para mobile
cd src-tauri && cargo build --no-default-features --release
```

---

## Estrutura do Projeto

```
OxideTerm/
├── src/                            # Frontend — 83K linhas TypeScript
│   ├── components/                 # 20 diretórios
│   │   ├── terminal/               #   Visualizações de terminal, painéis divididos, busca
│   │   ├── sftp/                   #   Navegador de arquivos de painel duplo
│   │   ├── ide/                    #   Editor, árvore de arquivos, diálogos Git
│   │   ├── ai/                     #   Chat inline + lateral
│   │   ├── graphics/               #   WSL Graphics (desktop VNC + visualizador de app)
│   │   ├── plugin/                 #   Gerenciador de plugins e UI do runtime
│   │   ├── forwards/               #   Gerenciamento de encaminhamento de portas
│   │   ├── connections/            #   CRUD de conexões e importação
│   │   ├── topology/               #   Grafo de topologia de rede
│   │   ├── layout/                 #   Barra lateral, cabeçalho, painéis divididos
│   │   └── ...                     #   Sessões, configurações, modais, etc.
│   ├── store/                      # 16 stores Zustand
│   ├── lib/                        # Camada de API, provedores IA, runtime de plugins
│   ├── hooks/                      # Hooks React (eventos, teclado, toast)
│   ├── types/                      # Definições de tipos TypeScript
│   └── locales/                    # 11 idiomas × 21 namespaces
│
├── src-tauri/                      # Backend — 51K linhas Rust
│   └── src/
│       ├── router/                 #   NodeRouter (nodeId → recurso)
│       ├── ssh/                    #   Cliente SSH (12 módulos incl. Agent)
│       ├── local/                  #   PTY local (feature-gated)
│       ├── graphics/               #   WSL Graphics (feature-gated)
│       ├── bridge/                 #   Bridge WebSocket e Wire Protocol v1
│       ├── session/                #   Gerenciamento de sessões (16 módulos)
│       ├── forwarding/             #   Encaminhamento de portas (6 módulos)
│       ├── sftp/                   #   Implementação SFTP
│       ├── config/                 #   Vault, chaveiro, configuração SSH
│       ├── oxide_file/             #   Criptografia .oxide (ChaCha20)
│       ├── commands/               #   24 módulos de comandos IPC Tauri
│       └── state/                  #   Tipos de estado global
│
└── docs/                           # 27+ documentos de arquitetura e funcionalidades
```

---

## Roteiro

### 🚧 Em Andamento (v0.20)

- [ ] Base de conhecimento RAG — coleções de documentos locais com busca híbrida BM25 + vetorial, recuperação integrada com IA
- [ ] Busca de sessões e troca rápida

### 📋 Planejado

- [ ] Encaminhamento do SSH Agent

---

## Segurança

| Aspecto | Implementação |
|---|---|
| **Senhas** | Chaveiro do SO (macOS Keychain / Windows Credential Manager / Linux libsecret) |
| **Chaves de API IA** | Chaveiro do SO sob o serviço `com.oxideterm.ai`; no macOS, a leitura das chaves requer **Touch ID** (gate biométrico via `LocalAuthentication.framework`, sem necessidade de entitlements de proteção de dados) — as chaves são armazenadas em cache na memória após a primeira autenticação, então o Touch ID é solicitado apenas uma vez por sessão |
| **Arquivos de configuração** | `~/.oxideterm/connections.json` — armazena apenas IDs de referência ao chaveiro |
| **Exportação** | .oxide: ChaCha20-Poly1305 + Argon2id, incorporação de chaves opcional |
| **Memória** | `zeroize` limpa dados sensíveis; Rust garante segurança de memória |
| **Chaves de host** | TOFU com `~/.ssh/known_hosts` |
| **Plugins** | Object.freeze + Proxy ACL, circuit breaker, whitelist IPC |

---

## Licença

**PolyForm Noncommercial 1.0.0**

- ✅ Uso pessoal / sem fins lucrativos: gratuito
- 🚫 Uso comercial: requer licença
- ⚖️ Cláusula de defesa de patentes (Cláusula Nuclear)

Texto completo: https://polyformproject.org/licenses/noncommercial/1.0.0/

---

## Agradecimentos

- [russh](https://github.com/warp-tech/russh) — SSH puro Rust
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty) — PTY multiplataforma
- [Tauri](https://tauri.app/) — Framework para aplicações nativas
- [xterm.js](https://xtermjs.org/) — Emulador de terminal
- [CodeMirror](https://codemirror.net/) — Editor de código
- [Radix UI](https://www.radix-ui.com/) — Primitivas de UI acessíveis

---

<p align="center">
  <sub>Construído com Rust e Tauri — 130.000+ linhas de código</sub>
</p>
