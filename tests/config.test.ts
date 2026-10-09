import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigStore } from '../src/config.ts';
import { normalizePhone } from '../src/domain.ts';
import { runtimeSettings, phoneEnvironment } from '../src/runtime-env.ts';
import { acquireProcessLock } from '../src/process-lock.ts';
test('한국 010 정규화와 긴급번호·형식·같은 번호 차단', () => {
  assert.equal(normalizePhone('010-0000-0000', true), '+821000000000');
  for (const phone of ['119', '112', '0101234', '+12025550103', '010000000000', '+821190000000'])
    assert.throws(() => normalizePhone(phone, true));
  const dir = mkdtempSync(join(tmpdir(), 'on-config-'));
  try {
    const store = new ConfigStore(dir, {});
    assert.throws(() => store.save({ CALLER_NUMBER: '01000000000', TEST_PHONE: '01000000000' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('저장 설정·빈 환경·환경변수 우선순위와 비밀값 유지·명시 삭제·파일 권한', () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-config-'));
  try {
    const saved = new ConfigStore(dir, {});
    saved.save({
      OPENAI_API_KEY: 'saved-secret',
      TEST_PHONE: '01000000000',
      MAX_CALL_SECONDS: 120,
    });
    const store = new ConfigStore(dir, {
      OPENAI_API_KEY: 'env-secret',
      TEST_PHONE: '',
      LIVE_MODEL: 'configured-live',
      MAX_CALL_SECONDS: '240',
    });
    assert.equal(store.value.OPENAI_API_KEY, 'env-secret');
    assert.equal(store.value.TEST_PHONE, '+821000000000');
    assert.equal(store.value.MAX_CALL_SECONDS, 240);
    store.save({ OPENAI_API_KEY: 'ui-secret', LIVE_MODEL: 'ui-model' });
    assert.equal(store.value.LIVE_MODEL, 'configured-live');
    assert.equal(store.value.OPENAI_API_KEY, 'env-secret');
    assert.equal(new ConfigStore(dir, {}).value.OPENAI_API_KEY, 'ui-secret');
    store.save({ OPENAI_API_KEY: '' });
    assert.equal(store.saved.OPENAI_API_KEY, 'ui-secret');
    store.save({ clearSecrets: true });
    assert.equal(store.value.OPENAI_API_KEY, 'env-secret');
    assert.equal(store.saved.OPENAI_API_KEY, '');
    assert.ok(!JSON.stringify(store.public()).includes('env-secret'));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.throws(() => store.save({ MAX_CALL_SECONDS: 29 }));
    assert.throws(() => store.save({ MAX_CALL_SECONDS: 601 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('서버와 검사 스크립트의 .env 로드에서 프로세스 환경을 우선함', () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-dotenv-'));
  try {
    writeFileSync(join(dir, '.env'), 'ON_TEST_VALUE=file\n');
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {loadEnvironment} from ${JSON.stringify(new URL('../src/runtime-env.ts', import.meta.url).href)};loadEnvironment(${JSON.stringify(dir)});process.stdout.write(process.env.ON_TEST_VALUE)`,
      ],
      { env: { ...process.env, ON_ENV_FILE: '', ON_TEST_VALUE: 'process' }, encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'process');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('전화 전용 환경 파일 선택·루트 fallback·명시 경로와 프로세스 값 우선', () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-phone-env-'));
  try {
    mkdirSync(join(dir, '.phone'));
    writeFileSync(join(dir, '.env'), 'ON_TEST_VALUE=root\nON_ROOT_ONLY=root\n');
    writeFileSync(join(dir, '.phone', '.env'), 'ON_TEST_VALUE=phone\n');
    writeFileSync(join(dir, 'chosen.env'), 'ON_TEST_VALUE=chosen\n');
    const read = (file = '', value?: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ON_ENV_FILE: file };
      delete env.ON_TEST_VALUE;
      delete env.ON_ROOT_ONLY;
      if (value) env.ON_TEST_VALUE = value;
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {loadEnvironment} from ${JSON.stringify(new URL('../src/runtime-env.ts', import.meta.url).href)};const path=loadEnvironment(${JSON.stringify(dir)});process.stdout.write(JSON.stringify({path,value:process.env.ON_TEST_VALUE,rootOnly:process.env.ON_ROOT_ONLY??null}))`,
        ],
        { env, encoding: 'utf8' },
      );
      return result;
    };
    let result = read();
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      path: join(dir, '.phone', '.env'),
      value: 'phone',
      rootOnly: null,
    });
    assert.equal(JSON.parse(read('', 'process').stdout).value, 'process');
    assert.equal(JSON.parse(read('chosen.env').stdout).value, 'chosen');
    assert.notEqual(read('missing.env').status, 0);
    rmSync(join(dir, '.phone'), { recursive: true });
    assert.equal(JSON.parse(read().stdout).value, 'root');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('공개 URL은 인프라 HTTPS 도메인을 허용하고 로컬·인증·경로·HTTP는 차단', () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-public-url-'));
  try {
    const store = new ConfigStore(dir, {});
    for (const url of [
      'https://callback.onmaul.example.com',
      'https://test.trycloudflare.com',
      'https://test.ngrok-free.app',
    ])
      assert.equal(store.save({ PUBLIC_BASE_URL: url }).PUBLIC_BASE_URL, url);
    for (const url of [
      'http://callback.onmaul.example.com',
      'https://127.0.0.1',
      'https://localhost',
      'https://service.local',
      'https://callback.onmaul.example.com/path',
      'https://user:password@callback.onmaul.example.com',
      'https://callback.onmaul.example.com?secret=1',
    ])
      assert.throws(() => store.save({ PUBLIC_BASE_URL: url }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('동일 데이터의 중복 프로세스 방지와 선택 경로·포트 검사', () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-lock-'));
  try {
    const release = acquireProcessLock(dir);
    assert.throws(() => acquireProcessLock(dir));
    release();
    const again = acquireProcessLock(dir);
    again();
    assert.equal(
      runtimeSettings('/tmp/project', { ON_LOCAL_DATA_DIR: '' }).dataDir,
      '/tmp/project/.data',
    );
    assert.throws(() => runtimeSettings('/tmp', { PORT: '8787', CALLBACK_PORT: '8787' }));
    assert.throws(() => runtimeSettings('/tmp', { PORT: '1' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('배포 환경은 로컬 전화 복사본을 읽지 않음', () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-deploy-env-'));
  try {
    mkdirSync(join(dir, '.phone'));
    writeFileSync(join(dir, '.phone', '.env'), 'ON_ENV_TEST_MARK=local\n');
    writeFileSync(join(dir, '.env'), 'ON_ENV_TEST_MARK=deployment\n');
    const env: NodeJS.ProcessEnv = { ...process.env, ON_PHONE_ENV: 'deployment', ON_ENV_FILE: '' };
    delete env.ON_ENV_TEST_MARK;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {loadEnvironment} from ${JSON.stringify(new URL('../src/runtime-env.ts', import.meta.url).href)};loadEnvironment(${JSON.stringify(dir)});process.stdout.write(process.env.ON_ENV_TEST_MARK)`,
      ],
      { env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'deployment');
    assert.equal(phoneEnvironment({ NODE_ENV: 'production' }), 'deployment');
    assert.equal(phoneEnvironment({}), 'local');
    assert.throws(() => phoneEnvironment({ ON_PHONE_ENV: 'unknown' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('.env 예제의 실제 계정·키·번호·URL은 비어 있음', () => {
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const key of [
    'OPENAI_API_KEY',
    'TELNYX_API_KEY',
    'TELNYX_APPLICATION_ID',
    'TELNYX_PUBLIC_KEY',
    'PUBLIC_BASE_URL',
    'CALLER_NUMBER',
    'TEST_PHONE',
  ])
    assert.match(text, new RegExp(`^${key}=$`, 'm'));
  assert.match(text, /LIVE_MODEL=gpt-live-1/);
});
