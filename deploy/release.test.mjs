import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseCheckout } from './verify-release.mjs';

const sources = fileURLToPath(new URL('./', import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-release-policy-'));
  const root = join(directory, 'primary checkout'), remote = join(directory, 'remote.git');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  mkdirSync(root); mkdirSync(join(root, 'deploy'));
  for (const name of ['verify-release.mjs', 'deploy.mjs', 'activate.py']) copyFileSync(join(sources, name), join(root, 'deploy', name));
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote], { stdio: 'pipe' });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.test');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'Initial fixture');
  git('remote', 'add', 'origin', remote); git('push', '--quiet', '-u', 'origin', 'main');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, root, remote, git, head: () => git('rev-parse', 'HEAD') };
}

test('clean primary main at the published revision passes release preflight', t => {
  const f = fixture(t);
  assert.equal(verifyReleaseCheckout(f.root), f.head());
});

test('feature and detached checkouts are rejected before deployment', t => {
  const f = fixture(t), revision = f.head();
  f.git('switch', '--quiet', '-c', 'task');
  assert.throws(() => verifyReleaseCheckout(f.root), /Merge and push.*main/);
  f.git('switch', '--quiet', 'main'); f.git('checkout', '--quiet', '--detach', revision);
  assert.throws(() => verifyReleaseCheckout(f.root), /Merge and push.*main/);
});

test('a local main commit must be pushed before it becomes deployable', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'tracked.txt'), 'local change\n');
  f.git('add', '.'); f.git('commit', '--quiet', '-m', 'Local change');
  assert.throws(() => verifyReleaseCheckout(f.root), /origin\/main/);
  f.git('push', '--quiet', 'origin', 'main');
  assert.equal(verifyReleaseCheckout(f.root), f.head());
});

test('fresh remote changes cannot be silently replaced by an older main deployment', t => {
  const f = fixture(t), other = join(f.directory, 'other clone');
  execFileSync('git', ['clone', '--quiet', f.remote, other], { stdio: 'pipe' });
  const there = (...args) => execFileSync('git', args, { cwd: other, stdio: 'pipe' });
  there('config', 'user.name', 'Release Test'); there('config', 'user.email', 'release@example.test');
  writeFileSync(join(other, 'tracked.txt'), 'remote change\n');
  there('add', '.'); there('commit', '--quiet', '-m', 'Remote change'); there('push', '--quiet', 'origin', 'main');
  assert.throws(() => verifyReleaseCheckout(f.root), /origin\/main/);
  f.git('merge', '--quiet', '--ff-only', 'origin/main');
  assert.equal(verifyReleaseCheckout(f.root), f.head());
});

test('tracked and untracked primary changes must be preserved before release', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'tracked.txt'), 'dirty\n');
  assert.throws(() => verifyReleaseCheckout(f.root), /Commit or preserve/);
  f.git('restore', 'tracked.txt'); writeFileSync(join(f.root, 'untracked.txt'), 'uncommitted work\n');
  assert.throws(() => verifyReleaseCheckout(f.root), /Commit or preserve/);
  assert.equal(readFileSync(join(f.root, 'untracked.txt'), 'utf8'), 'uncommitted work\n');
});

test('merge, push and worktree cleanup are all required in that order', t => {
  const f = fixture(t), worktree = join(f.directory, 'completed task with spaces');
  f.git('worktree', 'add', '--quiet', '-b', 'task', worktree);
  writeFileSync(join(worktree, 'tracked.txt'), 'completed task\n');
  f.git('-C', worktree, 'add', '.'); f.git('-C', worktree, 'commit', '--quiet', '-m', 'Complete task');
  f.git('merge', '--quiet', '--no-ff', 'task', '-m', 'Integrate task');
  assert.throws(() => verifyReleaseCheckout(f.root), /origin\/main/);
  f.git('push', '--quiet', 'origin', 'main');
  assert.throws(() => verifyReleaseCheckout(f.root), /Remove the completed merged worktree/);
  assert.equal(existsSync(worktree), true, 'the preflight must never remove a worktree');
  f.git('worktree', 'remove', worktree); f.git('branch', '-d', 'task');
  assert.equal(verifyReleaseCheckout(f.root), f.head());
});

test('even a linked worktree on main cannot act as the primary deployment checkout', t => {
  const f = fixture(t), worktree = join(f.directory, 'linked main');
  f.git('checkout', '--quiet', '--detach'); f.git('worktree', 'add', '--quiet', worktree, 'main');
  assert.throws(() => verifyReleaseCheckout(worktree), /primary main checkout/);
});

test('other unmerged and dirty worktrees remain available without blocking release', t => {
  const f = fixture(t), unmerged = join(f.directory, 'unmerged'), dirty = join(f.directory, 'dirty');
  f.git('worktree', 'add', '--quiet', '-b', 'unmerged-task', unmerged);
  writeFileSync(join(unmerged, 'tracked.txt'), 'other committed task\n');
  f.git('-C', unmerged, 'add', '.'); f.git('-C', unmerged, 'commit', '--quiet', '-m', 'Other task');
  f.git('worktree', 'add', '--quiet', '-b', 'dirty-task', dirty);
  writeFileSync(join(dirty, 'new.txt'), 'other unsaved task\n');
  assert.equal(verifyReleaseCheckout(f.root), f.head());
  assert.equal(readFileSync(join(unmerged, 'tracked.txt'), 'utf8'), 'other committed task\n');
  assert.equal(readFileSync(join(dirty, 'new.txt'), 'utf8'), 'other unsaved task\n');
});

test('direct VPS activation rejects a feature checkout before configuration or service access', t => {
  const f = fixture(t); f.git('switch', '--quiet', '-c', 'task');
  const result = spawnSync('python3', ['deploy/activate.py', f.head()], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release preflight failed: Merge and push.*main/);
  assert.doesNotMatch(result.stderr, /Private \.env|Required configuration|Database backup/);
});

test('the deployment CLI checks integration before reading a deployment target', t => {
  const f = fixture(t); f.git('switch', '--quiet', '-c', 'task');
  const result = spawnSync(process.execPath, ['deploy/deploy.mjs'], {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, FLIPPER_DEPLOY_HOST: '', FLIPPER_DEPLOY_PATH: '' },
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /Merge and push.*main/);
  assert.doesNotMatch(result.stderr, /Set FLIPPER_DEPLOY_HOST/);
});
