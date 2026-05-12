// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { ImageAddon, type IImageAddonOptions } from '@xterm/addon-image';

const DEFAULT_IMAGE_ADDON_OPTIONS: IImageAddonOptions = {
  enableSizeReports: true,
  pixelLimit: 16777216,
  storageLimit: 32,
  showPlaceholder: true,
  sixelSupport: true,
  sixelScrolling: true,
  sixelPaletteLimit: 256,
  sixelSizeLimit: 25000000,
  iipSupport: true,
  iipSizeLimit: 20000000,
};

export function createTerminalImageAddon(options: Partial<IImageAddonOptions> = {}): ImageAddon {
  return new ImageAddon({
    ...DEFAULT_IMAGE_ADDON_OPTIONS,
    ...options,
  });
}
