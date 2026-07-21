#!/usr/bin/env node
/**
 * patch-omo.js — oh-my-openagent polling interval patches
 *
 * Applies 3 surgical patches to oh-my-openagent's dist/index.js to reduce
 * HTTP polling frequency during concurrent sub-agent sessions, mitigating
 * O(n³) performance degradation.
 *
 * Patches:
 *   1. waitForCompletion POLL_INTERVAL_MS:   500ms → 2000ms  (sync sub-agent polling)
 *   2. SESSION_READY_POLL_INTERVAL_MS:       500ms → 1500ms  (session ready polling)
 *   3. BACKGROUND_OUTPUT_POLL_INTERVAL_MS:   100ms → 500ms   (background output polling)
 *
 * Idempotent: detects already-patched files and skips.
 * Backup:     creates .bak copies before modification.
 *
 * Usage:
 *   node patch-omo.js                    # auto-detect + apply
 *   node patch-omo.js --check            # check only, no modifications
 *   node patch-omo.js --restore          # restore from .bak
 *   node patch-omo.js --target <path>    # specify target file directly
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Patch definitions ────────────────────────────────────────────────────────

const PATCHES = [
  {
    id: 'waitForCompletion_POLL_INTERVAL',
    description: 'sync sub-agent polling: 500ms → 2000ms',
    search: 'const POLL_INTERVAL_MS = 500;',
    replace: 'const POLL_INTERVAL_MS = 2000;',
    verify: 'const POLL_INTERVAL_MS = 2000;',
  },
  {
    id: 'SESSION_READY_POLL_INTERVAL',
    description: 'session ready polling: 500ms → 1500ms',
    search: 'SESSION_READY_POLL_INTERVAL_MS = 500',
    replace: 'SESSION_READY_POLL_INTERVAL_MS = 1500',
    verify: 'SESSION_READY_POLL_INTERVAL_MS = 1500',
  },
  {
    id: 'BACKGROUND_OUTPUT_POLL_INTERVAL',
    description: 'background output polling: 100ms → 500ms',
    search: 'var BACKGROUND_OUTPUT_POLL_INTERVAL_MS = 100;',
    replace: 'var BACKGROUND_OUTPUT_POLL_INTERVAL_MS = 500;',
    verify: 'var BACKGROUND_OUTPUT_POLL_INTERVAL_MS = 500;',
  },
];

// ─── Path detection ───────────────────────────────────────────────────────────

function getOpenCodeCacheDir() {
  // Windows: %USERPROFILE%\.cache\opencode
  // Linux/macOS: ~/.cache/opencode
  const home = homedir();
  const cacheDir = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, 'opencode')
    : join(home, '.cache', 'opencode');
  return cacheDir;
}

function discoverTargetPaths() {
  const cacheDir = getOpenCodeCacheDir();
  const patterns = [
    // omo@latest installed locally
    join(cacheDir, 'packages', 'oh-my-openagent@latest', 'node_modules', 'oh-my-openagent', 'dist', 'index.js'),
    // omo scoped under opencode-ai
    join(cacheDir, 'packages', 'oh-my-openagent@latest', 'node_modules', '@opencode-ai', 'oh-my-openagent', 'dist', 'index.js'),
    // global node_modules
    join(homedir(), 'node_modules', 'oh-my-openagent', 'dist', 'index.js'),
    // local install in the plugin's sibling dirs
    join(dirname(__dirname), 'oh-my-openagent', 'dist', 'index.js'),
  ];

  // Deduplicate and check existence
  const found = [];
  const seen = new Set();
  for (const p of patterns) {
    const resolved = join(p);
    if (!seen.has(resolved) && existsSync(resolved)) {
      seen.add(resolved);
      found.push(resolved);
    }
  }
  return found;
}

// ─── Patch logic ──────────────────────────────────────────────────────────────

function alreadyPatched(content) {
  // Check all patches — if any is missing, we need to patch
  for (const p of PATCHES) {
    if (!content.includes(p.verify)) {
      return false;
    }
  }
  return true;
}

function applyPatches(targetPath, dryRun = false) {
  console.log(`\n[patch-omo] Target: ${targetPath}`);
  if (!existsSync(targetPath)) {
    console.log(`[patch-omo]   SKIP — file not found`);
    return { patched: false, skipped: true, reason: 'not_found' };
  }

  let content;
  try {
    content = readFileSync(targetPath, 'utf-8');
  } catch (err) {
    console.log(`[patch-omo]   ERROR — cannot read: ${err.message}`);
    return { patched: false, skipped: true, reason: `read_error: ${err.message}` };
  }

  if (alreadyPatched(content)) {
    console.log(`[patch-omo]   OK — already patched, skipping`);
    return { patched: false, skipped: true, reason: 'already_patched' };
  }

  // Create backup
  const backupPath = targetPath + '.bak';
  if (!dryRun && !existsSync(backupPath)) {
    try {
      copyFileSync(targetPath, backupPath);
      console.log(`[patch-omo]   BACKUP → ${backupPath}`);
    } catch (err) {
      console.log(`[patch-omo]   WARN — backup failed: ${err.message}`);
    }
  }

  let modified = content;
  const results = [];

  for (const p of PATCHES) {
    if (modified.includes(p.replace)) {
      // Already has the new value from a previous run or other source
      results.push({ id: p.id, status: 'already_applied' });
      console.log(`[patch-omo]   ${p.id}: already applied (${p.description})`);
      continue;
    }

    const countBefore = modified.split(p.search).length - 1;
    if (countBefore === 0) {
      results.push({ id: p.id, status: 'not_found', search: p.search });
      console.log(`[patch-omo]   ${p.id}: PATTERN NOT FOUND — ${p.search.substring(0, 60)}`);
      continue;
    }

    if (countBefore > 1) {
      console.log(`[patch-omo]   ${p.id}: WARN — ${countBefore} occurrences, replacing all`);
    }

    if (!dryRun) {
      modified = modified.replaceAll(p.search, p.replace);
    }
    results.push({ id: p.id, status: 'patched', occurrences: countBefore });
    console.log(`[patch-omo]   ${p.id}: PATCHED ✓ (${p.description})`);
  }

  if (!dryRun && results.some(r => r.status === 'patched')) {
    try {
      writeFileSync(targetPath, modified, 'utf-8');
      // Verify
      const verifyContent = readFileSync(targetPath, 'utf-8');
      const allApplied = PATCHES.every(p => verifyContent.includes(p.verify));
      if (allApplied) {
        console.log(`[patch-omo]   VERIFY — all 3 patches confirmed ✓`);
      } else {
        const missing = PATCHES.filter(p => !verifyContent.includes(p.verify)).map(p => p.id);
        console.log(`[patch-omo]   VERIFY — some patches missing: ${missing.join(', ')}`);
      }
    } catch (err) {
      console.log(`[patch-omo]   ERROR — write failed: ${err.message}`);
      return { patched: false, skipped: true, reason: `write_error: ${err.message}` };
    }
  }

  const patched = results.some(r => r.status === 'patched');
  return { patched, skipped: !patched, results };
}

function restoreFromBackup(targetPath) {
  const backupPath = targetPath + '.bak';
  if (!existsSync(backupPath)) {
    console.log(`[patch-omo] No backup found at ${backupPath}`);
    return false;
  }
  copyFileSync(backupPath, targetPath);
  unlinkSync(backupPath);
  console.log(`[patch-omo] Restored ${targetPath} from backup`);
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
patch-omo.js — oh-my-openagent polling interval patches

Usage:
  node patch-omo.js              Auto-detect + apply patches
  node patch-omo.js --check      Check only, no modifications
  node patch-omo.js --restore    Restore from .bak backups
  node patch-omo.js --target <path>    Specify target file directly

Patches:
  1. waitForCompletion:  500ms → 2000ms  (sync sub-agent polling)
  2. Session ready:      500ms → 1500ms  (session ready polling)
  3. Background output:  100ms → 500ms   (background output polling)
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const dryRun = args.includes('--check');
  const restore = args.includes('--restore');
  const targetIndex = args.indexOf('--target');
  const explicitTarget = targetIndex !== -1 && targetIndex + 1 < args.length
    ? args[targetIndex + 1]
    : null;

  console.log(`[patch-omo] oh-my-openagent polling interval patcher`);
  console.log(`[patch-omo] Mode: ${restore ? 'RESTORE' : dryRun ? 'CHECK' : 'APPLY'}`);

  if (restore) {
    if (explicitTarget) {
      restoreFromBackup(explicitTarget);
    } else {
      const targets = discoverTargetPaths();
      for (const t of targets) {
        restoreFromBackup(t);
      }
    }
    return;
  }

  if (explicitTarget) {
    applyPatches(explicitTarget, dryRun);
    return;
  }

  const targets = discoverTargetPaths();
  if (targets.length === 0) {
    const cacheDir = getOpenCodeCacheDir();
    console.log(`\n[patch-omo] No oh-my-openagent dist/index.js found.`);
    console.log(`[patch-omo] Tried:`);
    console.log(`  - ${join(cacheDir, 'packages', 'oh-my-openagent@latest', 'node_modules', 'oh-my-openagent', 'dist', 'index.js')}`);
    console.log(`\n[patch-omo] Use --target <path> to specify manually.`);
    return;
  }

  for (const t of targets) {
    applyPatches(t, dryRun);
  }
}

main().catch(err => {
  console.error(`[patch-omo] Fatal error:`, err);
  process.exit(1);
});
