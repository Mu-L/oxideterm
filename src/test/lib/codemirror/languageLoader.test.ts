import { describe, expect, it } from 'vitest';

import { loadLanguage } from '@/lib/codemirror/languageLoader';

describe('CodeMirror language loader', () => {
  it('loads PHP without the split-Lezer parser crash', async () => {
    const support = await loadLanguage('php');
    expect(support).not.toBeNull();

    const tree = support!.language.parser.parse('<?php echo("welcome");');
    expect(tree.length).toBeGreaterThan(0);
  });
});
