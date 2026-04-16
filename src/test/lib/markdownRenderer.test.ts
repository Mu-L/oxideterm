import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '@/lib/markdownRenderer';

describe('renderMarkdown', () => {
  it('preserves the character before inline code while protecting code spans', () => {
    const html = renderMarkdown('Run `echo $HOME` now.');

    expect(html).toContain('Run ');
    expect(html).toContain('<code class="md-inline-code">echo $HOME</code>');
    expect(html).not.toContain('md-math');
  });

  it('preserves the character before inline math and renders math placeholders', () => {
    const html = renderMarkdown('Value(x) = $x + 1$.');

    expect(html).toContain('Value(x) = ');
    expect(html).toContain('class="md-math md-math-inline"');
    expect(html).toContain('data-math="x + 1"');
  });

  it('supports inline code and inline math at the start of the string', () => {
    const codeHtml = renderMarkdown('`echo test` starts here.');
    const mathHtml = renderMarkdown('$x + 1$ starts here.');

    expect(codeHtml).toContain('<code class="md-inline-code">echo test</code>');
    expect(mathHtml).toContain('class="md-math md-math-inline"');
    expect(mathHtml).toContain('data-math="x + 1"');
  });

  it('does not treat escaped backticks or prices as code or math', () => {
    const html = renderMarkdown(String.raw`Use \`literal\` and pay $10 today.`);

    expect(html).not.toContain('<code>literal</code>');
    expect(html).not.toContain('md-math');
    expect(html).toContain('$10');
  });
});