#!/usr/bin/env node
/**
 * OxideTerm Release Notes Generator
 *
 * Usage:
 *   node scripts/release-notes.cjs <version>
 *   pnpm release:notes 1.4.4
 *
 * This script:
 *   1. Extracts release notes from docs/changelog/YYYY-MM.md
 *   2. Adds concise installation tips
 *   3. Outputs to RELEASE_NOTES.md or stdout (for GitHub release)
 *
 * All diagnostic messages go to stderr so --stdout gives clean output.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CHANGELOG_DIR = path.join(ROOT_DIR, 'docs', 'changelog');
const OUTPUT_FILE = path.join(ROOT_DIR, 'RELEASE_NOTES.md');

/** Print diagnostic info to stderr (never pollutes release body). */
function info(msg) { process.stderr.write(msg + '\n'); }

function findChangelogEntry(version) {
  const now = new Date();
  const searchMonths = [];

  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const filename = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.md`;
    searchMonths.push(filename);
  }

  for (const filename of searchMonths) {
    const filePath = path.join(CHANGELOG_DIR, filename);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');

    const versionRegex = new RegExp(
      `^## \\d{4}-\\d{2}-\\d{2}:[^\\n]*\\(v${version.replace(/\./g, '\\.')}\\)`,
      'm'
    );

    const match = content.match(versionRegex);
    if (match) {
      const startIndex = match.index;
      const restContent = content.slice(startIndex);
      const nextHeaderMatch = restContent.match(/\n## \d{4}-\d{2}-\d{2}:/);

      let endIndex;
      if (nextHeaderMatch) {
        endIndex = startIndex + nextHeaderMatch.index;
      } else {
        endIndex = content.length;
      }

      const entry = content.slice(startIndex, endIndex).trim();
      return { entry, file: filename };
    }
  }

  return null;
}

function generateReleaseNotes(version, changelogEntry) {
  const notes = [];

  // Changelog content (the main body)
  if (changelogEntry) {
    // Remove the date/version header — the GitHub release title already has it
    let body = changelogEntry.entry.replace(/^## [^\n]+\n/, '').trim();
    // Strip trailing horizontal rules to avoid duplication with our own separator
    body = body.replace(/(\n---\s*)+$/, '').trim();
    notes.push(body);
  }

  // Compact installation tips
  notes.push('');
  notes.push('---');
  notes.push('');
  notes.push('<details><summary>📦 Installation Tips / 安装提示</summary>');
  notes.push('');
  notes.push('#### macOS');
  notes.push('');
  notes.push('Downloaded `.dmg` files are quarantined by Gatekeeper. Run in Terminal:');
  notes.push('下载的 `.dmg` 文件会被 Gatekeeper 隔离，请在终端执行：');
  notes.push('');
  notes.push('```bash');
  notes.push('xattr -cr ~/Downloads/OxideTerm_*.dmg');
  notes.push('# or after install / 或安装后');
  notes.push('xattr -cr /Applications/OxideTerm.app');
  notes.push('```');
  notes.push('');
  notes.push('#### Windows');
  notes.push('');
  notes.push('If SmartScreen warns, click **More info → Run anyway**.');
  notes.push('若 SmartScreen 弹出警告，点击 **更多信息 → 仍要运行**。');
  notes.push('');
  notes.push('#### Linux');
  notes.push('');
  notes.push('```bash');
  notes.push('# AppImage');
  notes.push('chmod +x OxideTerm_*_linux_*.AppImage && ./OxideTerm_*_linux_*.AppImage');
  notes.push('# Debian/Ubuntu');
  notes.push('sudo dpkg -i OxideTerm_*_linux_*.deb && sudo apt-get install -f');
  notes.push('```');
  notes.push('');
  notes.push('</details>');
  notes.push('');

  // Footer links
  notes.push('[Documentation](https://oxideterm.app) · [Report Issues](https://github.com/AnalyseDeCircuit/OxideTerm/issues) · [Changelog](https://github.com/AnalyseDeCircuit/OxideTerm/tree/main/docs/changelog)');

  return notes.join('\n');
}

function getCurrentVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  return pkg.version;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    info(`
OxideTerm Release Notes Generator

Usage:
  node scripts/release-notes.cjs <version> [--stdout]
  pnpm release:notes <version>

Options:
  --stdout     Output to stdout instead of RELEASE_NOTES.md
  --help, -h   Show this help message

Current version: ${getCurrentVersion()}
`);
    process.exit(0);
  }

  const toStdout = args.includes('--stdout');
  const version = args.find(a => !a.startsWith('--')) || getCurrentVersion();

  info(`📝 Generating release notes for v${version}...`);

  const changelogEntry = findChangelogEntry(version);

  if (changelogEntry) {
    info(`✅ Found changelog entry in ${changelogEntry.file}`);
  } else {
    info(`⚠️  No changelog entry found for v${version}`);
    info(`   Expected: docs/changelog/YYYY-MM.md with header "## YYYY-MM-DD: Title (v${version})"`);
    info(`   Will fall back to GitHub auto-generated release notes.`);
  }

  const releaseNotes = generateReleaseNotes(version, changelogEntry);

  if (toStdout) {
    // Only the release body goes to stdout — clean for CI capture
    process.stdout.write(releaseNotes);
    // Exit 2 = no changelog found → workflow should use auto-generated notes
    if (!changelogEntry) process.exit(2);
  } else {
    fs.writeFileSync(OUTPUT_FILE, releaseNotes);
    info(`✨ Release notes written to RELEASE_NOTES.md`);
  }
}

main();
