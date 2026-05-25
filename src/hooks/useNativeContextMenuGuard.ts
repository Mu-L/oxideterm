// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect } from 'react';

export function preventNativeContextMenu(event: MouseEvent) {
  if (event.defaultPrevented) {
    return;
  }

  // WebView native menus include browser actions such as Refresh, which reloads
  // the whole React runtime and drops in-memory SSH/session state.
  event.preventDefault();
}

export function useNativeContextMenuGuard() {
  useEffect(() => {
    document.addEventListener('contextmenu', preventNativeContextMenu);

    return () => {
      document.removeEventListener('contextmenu', preventNativeContextMenu);
    };
  }, []);
}
