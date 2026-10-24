#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read-only release policy apart from refreshing origin/main. Never removes work. */
export function verifyReleaseCheckout(root, ref = 'HEAD') {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  if (git('branch', '--show-current') !== 'main') {
    throw new Error('Merge and push the task into main, remove its worktree, then deploy from main.');
  }
  const gitDirectory = realpathSync(git('rev-parse', '--path-format=absolute', '--git-dir'));
  const commonDirectory = realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (gitDirectory !== commonDirectory) throw new Error('Deploy from the primary main checkout after removing the task worktree.');
  if (git('status', '--porcelain')) throw new Error('Commit or preserve working changes before deploying from main.');
  const revision = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  git('fetch', '--quiet', 'origin', 'main');
  if (revision !== git('rev-parse', 'HEAD') || revision !== git('rev-parse', 'refs/heads/main')
    || revision !== git('rev-parse', 'refs/remotes/origin/main')) {
    throw new Error('Deploy the checked revision at both main and origin/main; merge, update and push main first.');
  }
  const records = git('worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean);
  for (const record of records.slice(1)) {
    const fields = Object.fromEntries(record.split('\0').filter(Boolean).map(line => {
      const space = line.indexOf(' '); return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)];
    }));
    const path = fields.worktree;
    if (!path || !existsSync(path)) throw new Error('Prune missing worktree registrations before deploying.');
    // Dirty worktrees may contain unrelated work based on an older main revision.
    if (git('-C', path, 'status', '--porcelain')) continue;
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', fields.HEAD, revision], { cwd: root, stdio: 'pipe' });
    if (ancestry.status === 0) throw new Error(`Remove the completed merged worktree before deploying: ${path}`);
    if (ancestry.status !== 1) throw new Error(`Cannot verify worktree integration: ${path}`);
  }
  return revision;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    process.stdout.write(`Release checkout verified: ${verifyReleaseCheckout(root, process.argv[2] ?? 'HEAD')}\n`);
  } catch (error) {
    process.stderr.write(`Release preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
