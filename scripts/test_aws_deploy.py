import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('aws_deploy', Path(__file__).with_name('aws-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class ReleaseSafetyTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ('package.json', 'package-lock.json', 'fe/package.json', 'server/package.json', 'server/src/main.ts', 'src/runtime-env.ts', 'src/config.ts', 'public/index.html', 'fixtures/bundle.json', 'fe/dist/index.html', 'shared/src/data.ts'):
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('{}')
        (self.root / 'fixtures/bundle.json').write_text(json.dumps({'metadata': {'synthetic': True}}))

    def test_local_secrets_and_state_are_excluded(self):
        for name in ('.env', '.phone/.env', '.deploy/aws.json', '.data/settings.json', '.aws/credentials', 'node_modules/private.txt', 'private.pem', 'fixtures/real-residents.json'):
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('DO_NOT_DEPLOY')
        files = {str(file.relative_to(self.root)) for file in deployment.package_files(self.root)}
        self.assertIn('fixtures/bundle.json', files)
        self.assertIn('fe/dist/index.html', files)
        self.assertNotIn('.env', files)
        self.assertNotIn('.deploy/aws.json', files)
        self.assertNotIn('fixtures/real-residents.json', files)
        self.assertIn('src/runtime-env.ts', files)
        self.assertIn('public/index.html', files)
        self.assertEqual(len(files), 11)

    def test_private_file_inside_source_is_rejected(self):
        (self.root / 'server/src/private.key').write_text('DO_NOT_DEPLOY')
        with self.assertRaisesRegex(RuntimeError, 'Private file'):
            deployment.package_files(self.root)

    def test_source_symlink_cannot_include_an_external_secret(self):
        target = self.root / '.env'
        target.write_text('DO_NOT_DEPLOY')
        (self.root / 'server/src/linked.ts').symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'Symlinks'):
            deployment.package_files(self.root)

    def test_real_fixture_data_cannot_enter_demo_release(self):
        (self.root / 'fixtures/bundle.json').write_text(json.dumps({'metadata': {'synthetic': False}}))
        with self.assertRaisesRegex(RuntimeError, 'synthetic'):
            deployment.package_files(self.root)

    def test_account_mismatch_stops_before_deployment(self):
        (self.root / 'aws.json').write_text(json.dumps({'account_id': '111111111111'}))
        (self.root / 'account-confirmation.json').write_text(json.dumps({'verified': True, 'account_id': '111111111111'}))
        with patch.object(deployment, 'LOCAL', self.root), patch.object(deployment, 'aws', return_value={'Account': '222222222222'}) as aws:
            with self.assertRaisesRegex(RuntimeError, 'differs'):
                deployment.verified_target()
            aws.assert_called_once()

    def test_pending_confirmation_prevents_even_an_aws_call(self):
        (self.root / 'account-verification-required').write_text('pending')
        with patch.object(deployment, 'LOCAL', self.root), patch.object(deployment, 'aws') as aws:
            with self.assertRaisesRegex(RuntimeError, 'pending'):
                deployment.verified_target()
            aws.assert_not_called()

    def test_runtime_sync_uses_private_temporary_file_without_changing_local_env(self):
        source = self.root / '.env'
        source.write_text('OPENAI_API_KEY=private-test-marker\nPUBLIC_BASE_URL=https://local.invalid\n')
        original = source.read_text()
        uploaded = []

        def upload(_state, *arguments):
            path = Path(arguments[arguments.index('--secret-string') + 1].removeprefix('file://'))
            uploaded.append((path, path.read_text(), path.stat().st_mode & 0o777))

        def git_check(arguments, **_kwargs):
            return SimpleNamespace(returncode=0 if 'check-ignore' in arguments else 1)

        with patch.object(deployment, 'ROOT', self.root), patch.object(deployment, 'LOCAL', self.root), \
             patch.object(deployment.subprocess, 'run', side_effect=git_check), \
             patch.object(deployment, 'aws', side_effect=upload):
            deployment.sync_runtime_env({'domain': 'app.example.com', 'outputs': {'RuntimeSecretArn': 'test-secret'}})
        self.assertEqual(source.read_text(), original)
        self.assertEqual(len(uploaded), 1)
        path, content, mode = uploaded[0]
        self.assertEqual(mode, 0o600)
        self.assertFalse(path.exists())
        self.assertIn('OPENAI_API_KEY=private-test-marker', content)
        self.assertIn('PUBLIC_BASE_URL=https://app.example.com', content)
        self.assertIn('ON_JOURNAL_DIR=/var/lib/onmaul/app-data/journal', content)

    def test_runtime_sync_rejects_aws_credentials(self):
        (self.root / '.env').write_text('AWS_ACCESS_KEY_ID=not-an-actual-key\n')
        def git_check(arguments, **_kwargs):
            return SimpleNamespace(returncode=0 if 'check-ignore' in arguments else 1)
        with patch.object(deployment, 'ROOT', self.root), patch.object(deployment, 'LOCAL', self.root), \
             patch.object(deployment.subprocess, 'run', side_effect=git_check), patch.object(deployment, 'aws') as aws:
            with self.assertRaisesRegex(RuntimeError, 'AWS CLI credentials'):
                deployment.sync_runtime_env({'domain': 'app.example.com', 'outputs': {'RuntimeSecretArn': 'test-secret'}})
            aws.assert_not_called()


if __name__ == '__main__':
    unittest.main()
