#!/usr/bin/env python3
"""Manage Onmaul infrastructure without putting account state or secrets in Git."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.deploy' / 'aws.json'
ACCOUNT_HOLD = ROOT / '.deploy' / 'account-verification-required'
TEMPLATE = ROOT / 'infrastructure' / 'onmaul.cfn.json'


def aws(profile, region, *arguments, sensitive=False, json_output=True):
    command = [
        'aws', '--profile', profile, '--region', region,
        '--no-cli-pager', '--cli-connect-timeout', '10', '--cli-read-timeout', '60',
        *arguments,
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        if sensitive:
            raise RuntimeError('Secret upload failed. Check Secrets Manager permissions and the local file; no secret values were logged.')
        raise RuntimeError(result.stderr.strip() or 'AWS command failed')
    if not json_output:
        return result.stdout
    return json.loads(result.stdout) if result.stdout.strip() else None


def save_state(value):
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    STATE.parent.chmod(0o700)
    temporary = STATE.with_suffix('.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    temporary.chmod(0o600)
    temporary.replace(STATE)


def refresh(profile, region, stack, account):
    response = aws(profile, region, 'cloudformation', 'describe-stacks', '--stack-name', stack, '--output', 'json')
    current = response['Stacks'][0]
    if current['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'):
        raise RuntimeError(f"Stack is {current['StackStatus']}; infrastructure is not ready.")
    outputs = {item['OutputKey']: item['OutputValue'] for item in current.get('Outputs', [])}
    for key in ('InstanceId', 'PublicIp', 'ArtifactsBucket', 'RuntimeSecretArn'):
        if key not in outputs:
            raise RuntimeError(f'Missing stack output: {key}')
    state = {
        'profile': profile, 'region': region, 'account_id': account,
        'stack_name': stack, 'domain': 'onmaul.nariacloud.com',
        'outputs': outputs,
    }
    save_state(state)
    print(json.dumps({'stack_status': current['StackStatus'], 'region': region, **outputs}, indent=2))
    print(f'Local infrastructure configuration: {STATE}')
    return state


def main():
    saved = json.loads(STATE.read_text()) if STATE.exists() else {}
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default=saved.get('profile', 'default'))
    parser.add_argument('--region', default=saved.get('region', 'ap-northeast-2'))
    parser.add_argument('--stack', default=saved.get('stack_name', 'onmaul-hackathon'))
    actions = parser.add_subparsers(dest='action', required=True)
    provision = actions.add_parser('provision', help='Create/update the CloudFormation stack; incurs AWS charges')
    provision.add_argument('--vpc-id')
    provision.add_argument('--subnet-id')
    provision.add_argument('--instance-type', choices=['t3.small', 't3.medium'], default='t3.small')
    actions.add_parser('status', help='Verify the stack and save its outputs locally')
    secret = actions.add_parser('sync-secrets', help='Upload a local dotenv file to Secrets Manager without printing it')
    secret.add_argument('--file', type=Path, default=ROOT / '.env')
    arguments = parser.parse_args()

    if arguments.action != 'status' and ACCOUNT_HOLD.exists():
        raise RuntimeError('AWS account email confirmation is pending. Only read-only status is allowed until the AWS console account ID has been matched.')

    identity = aws(arguments.profile, arguments.region, 'sts', 'get-caller-identity', '--output', 'json')
    account = identity['Account']
    if saved.get('account_id') and saved['account_id'] != account:
        raise RuntimeError('Authenticated AWS account differs from .deploy/aws.json. Verify the deployment target before proceeding.')

    if arguments.action == 'provision':
        vpc_id, subnet_id = arguments.vpc_id, arguments.subnet_id
        if not vpc_id:
            vpcs = aws(arguments.profile, arguments.region, 'ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true', '--output', 'json')['Vpcs']
            if len(vpcs) != 1:
                raise RuntimeError('Specify --vpc-id and --subnet-id for a public subnet with an internet route.')
            vpc_id = vpcs[0]['VpcId']
        if not subnet_id:
            subnets = aws(arguments.profile, arguments.region, 'ec2', 'describe-subnets', '--filters', f'Name=vpc-id,Values={vpc_id}', 'Name=default-for-az,Values=true', '--output', 'json')['Subnets']
            candidates = sorted((s for s in subnets if s.get('MapPublicIpOnLaunch')), key=lambda s: s['AvailabilityZone'])
            if not candidates:
                raise RuntimeError('Specify --subnet-id for a public subnet with an internet route.')
            subnet_id = candidates[0]['SubnetId']
        # The template contains no secret values. Account-specific IDs are CLI parameters.
        aws(arguments.profile, arguments.region, 'cloudformation', 'deploy',
            '--stack-name', arguments.stack, '--template-file', str(TEMPLATE),
            '--parameter-overrides', f'VpcId={vpc_id}', f'SubnetId={subnet_id}', f'InstanceType={arguments.instance_type}',
            '--capabilities', 'CAPABILITY_IAM', '--tags', 'Project=onmaul', 'Environment=hackathon',
            '--no-fail-on-empty-changeset', json_output=False)

    state = refresh(arguments.profile, arguments.region, arguments.stack, account)
    if arguments.action == 'sync-secrets':
        source = arguments.file.expanduser().resolve()
        if not source.is_file() or not source.stat().st_size:
            raise RuntimeError('A nonempty local dotenv file is required.')
        if source.is_relative_to(ROOT):
            ignored = subprocess.run(['git', 'check-ignore', '--quiet', str(source)], cwd=ROOT)
            tracked = subprocess.run(['git', 'ls-files', '--error-unmatch', str(source)], cwd=ROOT, capture_output=True)
            if ignored.returncode or not tracked.returncode:
                raise RuntimeError('Secret file must be ignored by Git and must not be tracked.')
        aws(arguments.profile, arguments.region, 'secretsmanager', 'put-secret-value',
            '--secret-id', state['outputs']['RuntimeSecretArn'],
            '--secret-string', f'file://{source}', '--output', 'json', sensitive=True)
        print('Runtime dotenv uploaded to Secrets Manager. Values were not logged. Restart the application after changing secrets.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
