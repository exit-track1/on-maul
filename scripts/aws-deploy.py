#!/usr/bin/env python3
"""Prepare HTTPS or manually deploy a built Onmaul release through private S3 and SSM."""

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.deploy'


def private_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    path.chmod(0o600)


def aws(state, *arguments):
    result = subprocess.run([
        'aws', '--profile', state['profile'], '--region', state['region'],
        '--no-cli-pager', '--cli-connect-timeout', '10', '--cli-read-timeout', '60',
        *arguments,
    ], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'AWS command failed')
    return json.loads(result.stdout) if result.stdout.strip() else None


def verified_target():
    if (LOCAL / 'account-verification-required').exists():
        raise RuntimeError('AWS account verification is pending.')
    state = json.loads((LOCAL / 'aws.json').read_text())
    confirmation = json.loads((LOCAL / 'account-confirmation.json').read_text())
    account = aws(state, 'sts', 'get-caller-identity', '--output', 'json')['Account']
    if not confirmation.get('verified') or account != confirmation.get('account_id') or account != state['account_id']:
        raise RuntimeError('AWS account differs from the confirmed deployment target.')
    return state


def remote(state, script, arguments, timeout=1200):
    encoded = base64.b64encode(script.read_bytes()).decode('ascii')
    shell = '\n'.join([
        'set -eu', 'umask 077',
        'remote_script=$(mktemp /var/lib/onmaul/run-command.XXXXXX)',
        'trap \'rm -f "$remote_script"\' EXIT',
        f'printf %s {shlex.quote(encoded)} | base64 -d > "$remote_script"',
        '/bin/bash "$remote_script" ' + shlex.join(arguments),
    ])
    # SSM records parameters, so this payload contains only code and infrastructure IDs.
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', dir=LOCAL, delete=False) as stream:
        payload = Path(stream.name)
        json.dump({'commands': [shell], 'executionTimeout': [str(timeout)]}, stream)
    payload.chmod(0o600)
    try:
        response = aws(state, 'ssm', 'send-command', '--instance-ids', state['outputs']['InstanceId'],
            '--document-name', 'AWS-RunShellScript', '--parameters', f'file://{payload}',
            '--comment', f'Onmaul manual {script.stem}', '--output', 'json')
    finally:
        payload.unlink(missing_ok=True)
    command_id = response['Command']['CommandId']
    print(f'SSM command: {command_id}', flush=True)
    deadline = time.monotonic() + timeout + 60
    last_status = None
    while time.monotonic() < deadline:
        try:
            invocation = aws(state, 'ssm', 'get-command-invocation', '--command-id', command_id,
                '--instance-id', state['outputs']['InstanceId'], '--output', 'json')
        except RuntimeError as error:
            if 'InvocationDoesNotExist' not in str(error):
                raise
            time.sleep(3)
            continue
        status = invocation['Status']
        if status != last_status:
            print(f'Remote status: {status}', flush=True)
            last_status = status
        if status == 'Success':
            print(invocation.get('StandardOutputContent', '')[-7000:])
            return command_id
        if status in ('Failed', 'Cancelled', 'TimedOut', 'Cancelling'):
            print(invocation.get('StandardOutputContent', '')[-3000:], file=sys.stderr)
            print(invocation.get('StandardErrorContent', '')[-3000:], file=sys.stderr)
            raise RuntimeError(f'Remote command {command_id} ended with {status}.')
        time.sleep(3)
    raise RuntimeError(f'Remote command {command_id} is still running; check its SSM status before retrying.')


def package_files(root):
    required = ('package.json', 'package-lock.json', 'fe/package.json', 'server/package.json', 'server/src/main.ts', 'fixtures/bundle.json', 'fe/dist/index.html')
    for name in required:
        if not (root / name).is_file():
            raise RuntimeError(f'Missing release file: {name}')
    fixture = json.loads((root / 'fixtures/bundle.json').read_text())
    if fixture.get('metadata', {}).get('synthetic') is not True:
        raise RuntimeError('Release fixtures must be marked as synthetic demo data.')
    files = {root / name for name in required}
    for name in ('server/src', 'shared/src', 'fe/dist'):
        files.update(path for path in (root / name).rglob('*') if path.is_file() or path.is_symlink())
    for path in files:
        relative = path.relative_to(root)
        if path.is_symlink():
            raise RuntimeError(f'Symlinks are not allowed in a release: {relative}')
        if any(part.startswith('.env') or part in ('.deploy', '.data', '.aws', 'node_modules', '.git') for part in relative.parts) or path.suffix in ('.pem', '.key', '.p12', '.pfx'):
            raise RuntimeError(f'Private file found in release input: {relative}')
    return sorted(files)


def build_release():
    subprocess.run(['npm', 'run', 'build'], cwd=ROOT, check=True)
    files = package_files(ROOT)
    LOCAL.mkdir(mode=0o700, parents=True, exist_ok=True)
    LOCAL.chmod(0o700)
    temporary = LOCAL / 'release.pending.tar.gz'
    with tarfile.open(temporary, 'w:gz', dereference=False) as archive:
        for path in files:
            archive.add(path, arcname=path.relative_to(ROOT), recursive=False)
    temporary.chmod(0o600)
    digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
    release = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + digest[:12]
    path = LOCAL / f'{release}.tar.gz'
    temporary.replace(path)
    manifest = {'release': release, 'sha256': digest, 'archive': str(path), 'files': [str(p.relative_to(ROOT)) for p in files]}
    private_json(LOCAL / 'release-plan.json', manifest)
    print(f'Built {release}: {len(files)} files, {path.stat().st_size} bytes. No .env, local data, infrastructure state, or dependencies included.', flush=True)
    return manifest


def verify_https(domain, application=False):
    with urlopen(f'https://{domain}/infra-health', timeout=15) as response:
        if response.status != 200 or response.read().decode().strip() != 'onmaul infrastructure ready':
            raise RuntimeError('HTTPS infrastructure check failed.')
    if application:
        with urlopen(f'https://{domain}/api/health', timeout=15) as response:
            health = json.load(response)
            if response.status != 200 or health.get('ok') is not True:
                raise RuntimeError('Public application health check failed.')
        with urlopen(f'https://{domain}/', timeout=15) as response:
            if response.status != 200 or '<html' not in response.read().decode().lower():
                raise RuntimeError('Public frontend check failed.')
    print(f'HTTPS verified: https://{domain}' + (' (application and API)' if application else ' (infrastructure)'), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'prepare-runtime', 'plan', 'check', 'deploy', 'verify'])
    arguments = parser.parse_args()
    if arguments.action == 'plan':
        build_release()
        return
    state = verified_target()
    if arguments.action == 'prepare-runtime':
        command_id = remote(state, ROOT / 'infrastructure' / 'prepare-runtime.sh', [])
        invocation = aws(state, 'ssm', 'get-command-invocation', '--command-id', command_id,
            '--instance-id', state['outputs']['InstanceId'], '--output', 'json')
        facts = next((json.loads(line.removeprefix('RUNTIME_READY '))
            for line in invocation.get('StandardOutputContent', '').splitlines()
            if line.startswith('RUNTIME_READY ')), None)
        if facts is None:
            raise RuntimeError('Runtime setup succeeded but its verification receipt is missing.')
        verify_https(state['domain'])
        private_json(LOCAL / 'runtime-ready.json', {
            'command_id': command_id, 'instance_id': state['outputs']['InstanceId'], **facts})
    elif arguments.action == 'prepare':
        command_id = remote(state, ROOT / 'infrastructure' / 'prepare-server.sh', [state['domain']])
        verify_https(state['domain'])
        private_json(LOCAL / 'server-ready.json', {'domain': state['domain'], 'instance_id': state['outputs']['InstanceId'], 'command_id': command_id, 'https_verified': True})
    elif arguments.action == 'verify':
        verify_https(state['domain'], application=(LOCAL / 'last-deployment.json').exists())
    else:
        verify_https(state['domain'])
        manifest = build_release()
        use_secret = False
        if arguments.action == 'deploy':
            secret = aws(state, 'secretsmanager', 'describe-secret', '--secret-id', state['outputs']['RuntimeSecretArn'], '--output', 'json')
            use_secret = any('AWSCURRENT' in stages for stages in secret.get('VersionIdsToStages', {}).values())
        # Only the release archive is uploaded; local environment files are never S3 inputs.
        destination = f"s3://{state['outputs']['ArtifactsBucket']}/releases/{manifest['release']}/app.tar.gz"
        subprocess.run(['aws', '--profile', state['profile'], '--region', state['region'], 's3', 'cp', manifest['archive'], destination, '--only-show-errors'], check=True)
        command_id = remote(state, ROOT / 'infrastructure' / 'deploy-release.sh', [state['region'], state['outputs']['ArtifactsBucket'], manifest['release'], manifest['sha256'], state['outputs']['RuntimeSecretArn'], 'yes' if use_secret else 'no', 'check' if arguments.action == 'check' else 'activate'])
        if arguments.action == 'check':
            verify_https(state['domain'])
            private_json(LOCAL / 'last-check.json', {**manifest, 'command_id': command_id, 'domain': state['domain']})
            print('Release check passed. The public application has not been activated.')
            return
        verify_https(state['domain'], application=True)
        private_json(LOCAL / 'last-deployment.json', {**manifest, 'command_id': command_id, 'domain': state['domain'], 'uses_runtime_secret': use_secret})
        print(f"Deployed release: {manifest['release']}")


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
