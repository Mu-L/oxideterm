# Contributing to OxideTerm

## Pull requests — not accepted at this time

**We are not accepting pull requests right now.**  
**目前不接受 PR。**

### Why we close PRs / 暂不接受的原因

Accepting a pull request is not a one-time merge — it creates a **long-term maintenance burden**: future refactors, security fixes, regressions, and releases all have to **preserve and understand** code written by someone else. With **limited maintainer capacity**, we cannot sustainably review, integrate, and **carry** third-party changes across the whole codebase lifecycle. That is why we avoid merging PRs even when the initial patch looks reasonable.

**合并 PR 不是「合进去就结束」**——它意味着**长期维护责任**：之后的重构、安全修复、回归排查、发版，都要继续**理解并维护**这段外来代码。在**维护者精力有限**的前提下，我们无法长期为第三方改动做审查、集成并**持续背负**其后果，因此暂不接 PR；这与首版补丁「看起来好不好」无关。

This policy may change if maintenance capacity changes; this file will be updated if it does.

---

If you have a feature idea, consider writing a **[plugin](docs/reference/PLUGIN_DEVELOPMENT.md)** instead — it extends OxideTerm without changing core code.

If you want to propose a change to core, **open an Issue first** for discussion. Do not open a PR without prior agreement; it will be closed without review.

---

## Building from source

You may still clone and build locally for your own use or for security research (see [SECURITY.md](SECURITY.md)).

### Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Rust** | 1.75+ ([rustup](https://rustup.rs/)) |
| **Node.js** | 18+ |
| **pnpm** | `npm install -g pnpm` |
| **macOS** | Xcode Command Line Tools |
| **Windows** | Visual Studio C++ Build Tools |
| **Linux** | `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev` |

### Commands

```bash
git clone https://github.com/AnalyseDeCircuit/OxideTerm.git
cd OxideTerm
pnpm install

# Full app (frontend + Rust + local PTY)
pnpm tauri dev

# Frontend only (Vite on http://localhost:1420)
pnpm dev

# Production bundle
pnpm tauri build

# Rust only
cd src-tauri && cargo check && cargo fmt

# Lightweight backend (no local PTY)
cd src-tauri && cargo build --no-default-features --release
```

Other useful scripts: `pnpm i18n:check`, `pnpm license:check:backend`, `pnpm project:stats`.

---

## If contributions open again — expected standards

The following applies to **hypothetical** future contributions and helps you align with how the codebase is written today.

### Process

1. Discuss in an **Issue** before coding.
2. Keep PRs **small and focused**; link the Issue.
3. Read **[docs/reference/SYSTEM_INVARIANTS.md](docs/reference/SYSTEM_INVARIANTS.md)** before touching session, connection, or reconnect code.

### Internationalization (i18n)

- **No user-visible hardcoded strings** in UI code.
- Add keys to **all 11** locale files under `src/locales/{lang}/`.
- Run `pnpm i18n:check`.

### Frontend (TypeScript / React)

- Prefer `type` over `interface` unless you need `extends`.
- Use function components and hooks; merge classes with `cn()` where the project already does.
- After changing `sessionTreeStore`, sync connection state per invariants (e.g. `refreshConnections()`).

### Backend (Rust)

- Run `cargo fmt` (and `cargo clippy` if you fix warnings in touched code).
- Respect **lock ordering** documented in invariants (no Session lock while holding SessionRegistry, etc.).

### API parity

- New Tauri commands: implement in `src-tauri/src/commands/`, register in `lib.rs`, wrap in `src/lib/api.ts`, types in `src/types/` as needed.
- Keep **frontend and Rust data shapes** in sync.

### Security & hygiene

- Do not commit secrets, real hostnames, or private keys.
- Passwords and API keys belong in the **OS keychain**, not config files.

### Documentation

- Meaningful changes to architecture or behaviour should touch **`docs/reference/`** when appropriate.

---

## Questions

Use [GitHub Issues](https://github.com/AnalyseDeCircuit/OxideTerm/issues) for general questions (not for undisclosed security issues — use [SECURITY.md](SECURITY.md)).

---

## License reminder

The project is under **GPL-3.0**. By contributing (if ever accepted), you agree your contributions are licensed under the same terms unless explicitly stated otherwise.
