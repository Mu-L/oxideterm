// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import React from 'react'
import ReactDOM from 'react-dom/client'
import { create } from 'zustand'
import * as lucideReact from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import { pluginUIKit } from './lib/plugin/pluginUIKit'
import { cn } from './lib/utils'
import packageJson from '../package.json'
import App from './App'
import './styles.css'
import { i18nReady } from './i18n'
import './bootstrap/initKeybindings'
import { initializeSettings } from './store/settingsStore'

// Dev-only: register fault injection API (window.__faultInjection)
import './lib/faultInjection'

// Expose shared modules so plugins can externalize react/zustand/lucide-react
// and avoid dual-instance hooks crashes.
// Note: `import *` is needed here because plugins rely on deprecated icon aliases
// (e.g. CheckCircle2, XCircle) which exist as named exports but not in `icons`.
// The manualChunks config isolates lucide-react into its own chunk regardless.

// Proxy wrapper: when a plugin destructures an icon name that doesn't exist
// (e.g. future icon or typo), return the Puzzle fallback instead of undefined.
const safeLucideReact = new Proxy(lucideReact, {
  get(target, prop, receiver) {
    const val = Reflect.get(target, prop, receiver);
    if (val !== undefined) return val;
    // Only intercept PascalCase names (icon components), not internal fields
    if (typeof prop === 'string' && /^[A-Z]/.test(prop)) {
      console.warn(`[OxideTerm] Unknown lucide icon "${prop}", using Puzzle fallback`);
      return lucideReact.Puzzle;
    }
    return val;
  },
});

window.__OXIDE__ = {
  React,
  ReactDOM: { createRoot: ReactDOM.createRoot },
  zustand: { create },
  lucideIcons: lucideReact.icons,
  lucideReact: safeLucideReact,
  ui: pluginUIKit,
  clsx,
  cn,
  useTranslation,
  version: packageJson.version,
  pluginApiVersion: 3,
}

// Initialize settings (including theme) before rendering
// This loads from oxide-settings-v2, applies theme, and cleans up legacy keys
initializeSettings()

// Wait for i18n resources to load before rendering
i18nReady.then(() => {
  const root = ReactDOM.createRoot(document.getElementById('root')!)

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )

  // Cleanup on window close to prevent memory leaks
  // NOTE: UI state (sidebar) is now automatically persisted by settingsStore
  window.addEventListener('beforeunload', () => {
    root.unmount()
  })
}).catch((err) => {
  console.error('Failed to initialize i18n:', err)
  // 降级渲染：即使 i18n 加载失败也要呈现界面（翻译字符串会显示 key）
  const root = ReactDOM.createRoot(document.getElementById('root')!)
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
