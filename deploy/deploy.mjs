#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { verifyReleaseCheckout } from './verify-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: 'inherit', ...options });

try {
  const revision = verifyReleaseCheckout(root, process.argv[2] ?? 'HEAD');
  const targetPath = new URL('../.deployment/target.json', import.meta.url);
  const target = existsSync(targetPath) ? JSON.parse(readFileSync(targetPath, 'utf8')) : {};
  const host = process.env.FLIPPER_DEPLOY_HOST ?? target.host;
  const remotePath = process.env.FLIPPER_DEPLOY_PATH ?? target.path;
  if (typeof host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(host)
      || typeof remotePath !== 'string' || !remotePath || /[\x00-\x1f]/.test(remotePath)) {
    throw new Error('Set FLIPPER_DEPLOY_HOST and FLIPPER_DEPLOY_PATH, or save host/path in private .deployment/target.json.');
  }
  process.stdout.write(`Checking Flipper revision ${revision}\n`);
  run('npm', ['run', 'test:release']);
  run('npm', ['test']);
  run('npm', ['run', 'build']);
  // No shell interpolation of a path, ref, credential, or user-provided argument.
  const bootstrap = `import fcntl, pathlib, subprocess\nroot = pathlib.Path(${JSON.stringify(remotePath)}).expanduser()\nwith (root / '.deploy.lock').open('a') as lock:\n fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)\n def run(args): subprocess.run(args, cwd=root, check=True)\n if subprocess.check_output(['git','status','--porcelain'], cwd=root, text=True).strip(): raise SystemExit('VPS checkout has uncommitted changes; deployment refused.')\n run(['git','fetch','origin','main'])\n run(['git','switch','main'])\n run(['git','merge','--ff-only','origin/main'])\n run(['python3','deploy/activate.py',${JSON.stringify(revision)}])\n`;
  run('ssh', ['-o', 'BatchMode=yes', host, 'python3 -'], {
    input: bootstrap, stdio: ['pipe', 'inherit', 'inherit'],
  });
} catch (error) {
  process.stderr.write(`Deployment failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
