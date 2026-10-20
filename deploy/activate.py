#!/usr/bin/env python3
"""Run on the VPS after selecting a clean, approved Git revision. Never prints secrets."""
import datetime
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def run(args, capture=False):
    return subprocess.run(args, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def select_revision(revision):
    path = ROOT / '.env'
    lines = [line for line in path.read_text().splitlines()
             if not line.startswith('FLIPPER_DEPLOY_REVISION=')]
    path.write_text('\n'.join(lines + [f'FLIPPER_DEPLOY_REVISION={revision}', '']))
    path.chmod(0o600)


def snapshot(revision):
    database = ROOT / '.data' / 'flipper.sqlite'
    if not database.is_file():
        raise RuntimeError('Persistent database is missing; refusing an empty replacement.')
    folder = ROOT / '.backups'
    folder.mkdir(mode=0o700, exist_ok=True)
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    destination = folder / f'{timestamp}-before-{revision[:12]}.sqlite'
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as source:
        with sqlite3.connect(destination) as target:
            source.backup(target)
            if target.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('Database backup did not pass integrity checking.')
    destination.chmod(0o600)
    print(f'Database snapshot: {destination.relative_to(ROOT)}', flush=True)
    return str(destination.relative_to(ROOT))


def main():
    os.umask(0o077)
    if len(sys.argv) != 2 or not re.fullmatch(r'[0-9a-f]{40}', sys.argv[1]):
        raise RuntimeError('Expected a full Git commit SHA.')
    revision = sys.argv[1]
    if run(['git', 'rev-parse', 'HEAD'], True).strip() != revision:
        raise RuntimeError('Checkout does not match the requested revision.')
    if run(['git', 'status', '--porcelain'], True).strip():
        raise RuntimeError('VPS checkout must be clean.')
    env_path = ROOT / '.env'
    if not env_path.is_file() or stat.S_IMODE(env_path.stat().st_mode) != 0o600:
        raise RuntimeError('Private .env is missing or must have mode 0600.')
    values = dict(line.split('=', 1) for line in env_path.read_text().splitlines()
                  if '=' in line and not line.startswith('#'))
    app_container = values.get('FLIPPER_CONTAINER_NAME', 'flipper-app')
    edge_container = values.get('FLIPPER_EDGE_CONTAINER', 'edge-caddy')
    for key in ['FLIPPER_PUBLIC_ORIGIN', 'FLIPPER_ADMIN_TOKEN', 'LITELLM_API_KEY']:
        if not values.get(key):
            raise RuntimeError(f'Required configuration is missing: {key}')
    state_path = ROOT / '.deploy-state.json'
    previous = json.loads(state_path.read_text()) if state_path.exists() else None
    probe = subprocess.run(['docker', 'inspect', app_container, '--format', '{{.State.Running}}'],
                           text=True, capture_output=True)
    if probe.returncode == 0 and probe.stdout.strip() == 'true':
        running = run(['docker', 'inspect', app_container, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}'], True).strip()
        if not previous or previous.get('revision') != running:
            raise RuntimeError('Running revision and deployment state disagree; reconcile them before release.')
    # Dockerfile runs the test suite and production build on the VPS architecture before replacement.
    run(['docker', 'build', '--build-arg', f'REVISION={revision}', '--tag', f'flipper:{revision}', '.'])
    marker = ROOT / '.data' / '.deployment-maintenance'
    # Do not overwrite a marker left by an interrupted deployment; investigate it first.
    with marker.open('x') as handle:
        handle.write(revision + '\n')
    attempted_replacement = False
    try:
        if probe.returncode == 0 and probe.stdout.strip() == 'true':
            # Requests starting after the marker are rejected synchronously. A job or
            # probe already in flight causes activation to abort without interrupting it.
            code = "const r=await fetch('http://127.0.0.1:4317/admin/api/deployment',{headers:{'X-Flipper-Admin-Token':process.env.FLIPPER_ADMIN_TOKEN}});if(!r.ok)process.exit(2);const d=await r.json();if(d.busy)process.exit(3)"
            run(['docker', 'exec', app_container, 'node', '--input-type=module', '-e', code])
        backup = snapshot(revision)
        select_revision(revision)
        attempted_replacement = True
        run(['docker', 'compose', 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '90', 'app'])
        label = run(['docker', 'inspect', app_container, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}'], True).strip()
        if label != revision:
            raise RuntimeError('Running image revision does not match the selected commit.')
        health = json.loads(run(['docker', 'exec', edge_container, 'wget', '-qO-', f'http://{app_container}:4317/healthz'], True))
        if health.get('revision') != revision or health.get('status') != 'ok':
            raise RuntimeError('Edge-to-service revision check failed.')
    except Exception:
        if attempted_replacement and previous and previous.get('revision'):
            # Restore the known-good Compose definition as well as its image revision.
            run(['git', 'checkout', '--detach', previous['revision']])
            select_revision(previous['revision'])
            run(['docker', 'compose', 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '90', 'app'])
            restored = json.loads(run(['docker', 'exec', edge_container, 'wget', '-qO-', f'http://{app_container}:4317/healthz'], True))
            if restored.get('revision') != previous['revision']:
                raise RuntimeError('Rollback did not restore the previous running revision.')
            print('Previous image restored; persistent data retained.', flush=True)
        elif attempted_replacement:
            subprocess.run(['docker', 'compose', 'stop', 'app'], cwd=ROOT, check=False)
        raise
    finally:
        marker.unlink(missing_ok=True)
    state_path.write_text(json.dumps({'revision': revision, 'previousRevision': previous.get('revision') if previous else None,
                                     'deployedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                     'databaseSnapshot': backup}, indent=2) + '\n')
    state_path.chmod(0o600)
    print(f'Flipper {revision} is healthy on the private edge network.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Activation failed: {error}', file=sys.stderr)
        sys.exit(1)
