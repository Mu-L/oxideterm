# Security policy

## Supported versions

Security fixes are applied to the **latest release on `main`** when practical. Older tags may not receive backports unless the maintainer explicitly publishes a patch release.

## Reporting a vulnerability

**Do not** open a **public** GitHub Issue for undisclosed security vulnerabilities (remote code execution, credential theft, crypto breaks, etc.). Public issues make it easier for others to exploit the flaw before a fix exists.

### Preferred: private reporting on GitHub

1. Open the repository on GitHub: [AnalyseDeCircuit/OxideTerm](https://github.com/AnalyseDeCircuit/OxideTerm).
2. Use **Security → Report a vulnerability** (private vulnerability reporting), if enabled for this repository.  
   - Shortcut (when logged in): [Report a vulnerability](https://github.com/AnalyseDeCircuit/OxideTerm/security/advisories/new).

If private reporting is disabled, enable it under **Settings → General → Security → Private vulnerability reporting**, or contact the maintainer through another **private** channel they publish on their profile or README.

### What to include

- Description of the issue and its impact.
- Steps to reproduce (minimal proof-of-concept if possible).
- Affected component (e.g. SSH, WebSocket bridge, SFTP, plugin loader, MCP, updater).
- Versions / commit SHA if you built from source.

### What **not** to include

- **Live production credentials**, API keys, SSH private keys, or real customer data.
- Full dumps of `connections.json` or keychain material — describe shape and behaviour instead.

You may use **redacted** examples (e.g. replace hostnames with `example.com`).

## Scope (examples)

In scope for coordinated disclosure:

- Remote or local privilege escalation via the app or its update path.
- Breakout from the plugin sandbox or unauthorised Tauri IPC.
- SSH / TLS / crypto implementation mistakes that weaken confidentiality or integrity.
- Secrets written to disk or logs in plaintext when the design promises keychain-only storage.

Out of scope or lower priority (still report if unsure):

- Physical access to an unlocked machine with OxideTerm already running.
- Social engineering.
- Issues in **third-party** dependencies — report upstream; we still want to know if you believe we pin a vulnerable version.

## Response expectations

This is a **maintained-by-maintainer** project, not a commercial SLA. We aim to acknowledge reasonable reports when time allows and to coordinate disclosure after a fix or mitigation.

## Safe harbour

If you follow this policy and act in good faith (no data destruction, no abuse of user systems), we appreciate responsible research.

## More reading

- Architecture and trust boundaries: `docs/reference/` (e.g. protocol, plugin system, AI docs).
- License: [PolyForm Noncommercial 1.0.0](LICENSE) — does not waive security expectations for users.
