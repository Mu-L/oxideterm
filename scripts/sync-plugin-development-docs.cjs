#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'docs/reference/PLUGIN_DEVELOPMENT.md');
const rootGuidePath = path.join(repoRoot, 'PLUGIN_DEVELOPMENT.md');
const webRoot = process.env.OXIDETERM_WEB_REPO || path.join(repoRoot, 'oxideterm-web');
const webZhPath = path.join(webRoot, 'src/content/docs/zh-hans/docs/plugin-development.mdx');
const webEnPath = path.join(webRoot, 'src/content/docs/docs/plugin-development.mdx');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function toZhMdx(markdown) {
  const body = normalizeNewline(markdown).replace(/^# OxideTerm Plugin Development Guide\s*\n+/, '');
  const hash = sha256(normalizeNewline(markdown));
  return `---\ntitle: 插件开发指南\ndescription: OxideTerm 插件开发完全参考 — 适用于 Plugin API v3\n---\n\n{/* AUTO-GENERATED from OxideTerm/docs/reference/PLUGIN_DEVELOPMENT.md. Do not edit manually. */}\n{/* source-sha256: ${hash} */}\n\n${body}`;
}

function writeOrCheck(file, expected) {
  const normalized = normalizeNewline(expected);
  const exists = fs.existsSync(file);
  const current = exists ? read(file) : '';

  if (current === normalized) {
    return { file, changed: false };
  }

  if (checkOnly) {
    throw new Error(`${path.relative(repoRoot, file)} is out of sync`);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, normalized);
  return { file, changed: true };
}

function checkManualTranslation(file, expectedHash) {
  if (!fs.existsSync(file)) return;

  const content = read(file);
  const match = content.match(/source-sha256:\s*([a-f0-9]{64})/);
  if (match?.[1] === expectedHash) {
    console.log(`ok ${path.relative(repoRoot, file)} manual translation marker`);
    return;
  }

  const message =
    `${path.relative(repoRoot, file)} manual translation is out of sync with ` +
    'docs/reference/PLUGIN_DEVELOPMENT.md';
  if (checkOnly) {
    throw new Error(message);
  }
  console.warn(`[sync-plugin-development-docs] ${message}`);
}

function main() {
  const source = normalizeNewline(read(sourcePath));
  const sourceHash = sha256(source);
  const results = [
    writeOrCheck(rootGuidePath, source),
  ];

  if (fs.existsSync(webRoot)) {
    results.push(writeOrCheck(webZhPath, toZhMdx(source)));
    checkManualTranslation(webEnPath, sourceHash);
  }

  for (const result of results) {
    const rel = path.relative(repoRoot, result.file);
    console.log(`${result.changed ? 'updated' : 'ok'} ${rel}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
