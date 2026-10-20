#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: 'inherit', ...options });
const git = (...args) => run('git', args, { stdio: 'pipe', encoding: 'utf8' }).trim();

try {
  const targetPath = new URL('../.deployment/target.json', import.meta.url);
  const target = existsSync(targetPath) ? JSON.parse(readFileSync(targetPath, 'utf8')) : {};
  const host = process.env.FLIPPER_DEPLOY_HOST ?? target.host;
  const remotePath = process.env.FLIPPER_DEPLOY_PATH ?? target.path;
  if (typeof host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(host)
      || typeof remotePath !== 'string' || !remotePath || /[\x00-\x1f]/.test(remotePath)) {
    throw new Error('Set FLIPPER_DEPLOY_HOST and FLIPPER_DEPLOY_PATH, or save host/path in private .deployment/target.json.');
  }
  if (git('status', '--porcelain')) throw new Error('Commit or preserve working changes before deploying.');
  const revision = git('rev-parse', '--verify', `${process.argv[2] ?? 'HEAD'}^{commit}`);
  if (revision !== git('rev-parse', 'HEAD')) throw new Error('Check out the revision you intend to deploy first.');
  run('git', ['fetch', 'origin', 'main']);
  run('git', ['merge-base', '--is-ancestor', revision, 'origin/main']);
  process.stdout.write(`Checking Flipper revision ${revision}\n`);
  run('npm', ['test']);
  run('npm', ['run', 'build']);
  // No shell interpolation of a path, ref, credential, or user-provided argument.
  const bootstrap = `import fcntl, pathlib, subprocess\nroot = pathlib.Path(${JSON.stringify(remotePath)}).expanduser()\nwith (root / '.deploy.lock').open('a') as lock:\n fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)\n def run(args): subprocess.run(args, cwd=root, check=True)\n if subprocess.check_output(['git','status','--porcelain'], cwd=root, text=True).strip(): raise SystemExit('VPS checkout has uncommitted changes; deployment refused.')\n run(['git','fetch','origin','main'])\n run(['git','merge-base','--is-ancestor',${JSON.stringify(revision)},'origin/main'])\n run(['git','checkout','--detach',${JSON.stringify(revision)}])\n run(['python3','deploy/activate.py',${JSON.stringify(revision)}])\n`;
  run('ssh', ['-o', 'BatchMode=yes', host, 'python3 -'], {
    input: bootstrap, stdio: ['pipe', 'inherit', 'inherit'],
  });
} catch (error) {
  process.stderr.write(`Deployment failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
