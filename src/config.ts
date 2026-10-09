import { z } from 'zod';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { AppError, normalizePhone } from './domain.ts';
export const defaults = {
  OPENAI_API_KEY: '',
  TELNYX_API_KEY: '',
  TELNYX_APPLICATION_ID: '',
  TELNYX_PUBLIC_KEY: '',
  PUBLIC_BASE_URL: '',
  CALLER_NUMBER: '',
  TEST_PHONE: '',
  LIVE_MODEL: 'gpt-live-1',
  BACKEND_MODEL: 'gpt-6.1-sol',
  PLANNING_MODEL: 'gpt-6.1-sol',
  VOICE: 'marin',
  MAX_CALL_SECONDS: 240,
};
export type Config = typeof defaults;
export const secretFields = ['OPENAI_API_KEY', 'TELNYX_API_KEY'] as const;
export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
export function writePrivate(path: string, value: unknown) {
  privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
function validate(input: Record<string, unknown>): Config {
  const config = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Config)[]) {
    if (key === 'MAX_CALL_SECONDS') {
      config[key] = z.coerce.number().int().min(30).max(600).parse(input[key]);
      continue;
    }
    config[key] = z
      .string()
      .max(4096)
      .refine((s) => !/[\r\n\0]/.test(s))
      .parse(input[key])
      .trim();
  }
  for (const key of ['LIVE_MODEL', 'BACKEND_MODEL', 'PLANNING_MODEL', 'VOICE'] as const)
    if (!/^[\w.-]{1,100}$/.test(config[key]))
      throw new AppError('invalid_model', `${key} ID를 확인하세요.`);
  if (config.TEST_PHONE) config.TEST_PHONE = normalizePhone(config.TEST_PHONE, true);
  if (config.CALLER_NUMBER) config.CALLER_NUMBER = normalizePhone(config.CALLER_NUMBER);
  if (config.TEST_PHONE && config.TEST_PHONE === config.CALLER_NUMBER)
    throw new AppError('same_phone', '발신번호와 수신번호는 달라야 합니다.');
  if (
    config.TELNYX_PUBLIC_KEY &&
    (!/^[A-Za-z0-9+/]{43}=$/.test(config.TELNYX_PUBLIC_KEY) ||
      Buffer.from(config.TELNYX_PUBLIC_KEY, 'base64').length !== 32)
  )
    throw new AppError('invalid_public_key', 'Ed25519 32바이트 공개키가 필요합니다.');
  if (config.TELNYX_APPLICATION_ID && !/^[\w-]{5,100}$/.test(config.TELNYX_APPLICATION_ID))
    throw new AppError('invalid_application', 'Voice API 앱 ID를 확인하세요.');
  if (config.PUBLIC_BASE_URL) {
    const url = new URL(config.PUBLIC_BASE_URL);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      url.port ||
      isIP(url.hostname) !== 0 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname)
    )
      throw new AppError(
        'invalid_public_url',
        '경로 없는 공개 DNS 도메인의 HTTPS 주소가 필요합니다. Cloudflare·ngrok 또는 인프라 콜백 도메인을 사용하세요.',
      );
    config.PUBLIC_BASE_URL = url.origin;
  }
  return config;
}
export class ConfigStore {
  value: Config;
  saved: Config;
  env: Partial<Config> = {};
  path: string;
  constructor(directory: string, environment: Record<string, string | undefined> = process.env) {
    privateDirectory(directory);
    this.path = join(directory, 'settings.json');
    this.saved = validate({
      ...defaults,
      ...(existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {}),
    });
    for (const key of Object.keys(defaults) as (keyof Config)[])
      if (environment[key]?.trim())
        Object.assign(this.env, {
          [key]: key === 'MAX_CALL_SECONDS' ? Number(environment[key]) : environment[key],
        });
    this.value = validate({ ...this.saved, ...this.env });
    if (existsSync(this.path)) chmodSync(this.path, 0o600);
  }
  save(input: Record<string, unknown>) {
    const next: Record<string, unknown> = { ...this.saved };
    for (const key of Object.keys(defaults))
      if (key in input && !(secretFields.includes(key as 'OPENAI_API_KEY') && input[key] === ''))
        next[key] = input[key];
    if (input.clearSecrets === true) for (const key of secretFields) next[key] = '';
    const saved = validate(next),
      effective = validate({ ...saved, ...this.env });
    writePrivate(this.path, saved);
    this.saved = saved;
    this.value = effective;
    return this.public();
  }
  public() {
    const { OPENAI_API_KEY, TELNYX_API_KEY, ...settings } = this.value;
    return {
      ...settings,
      secrets: { OPENAI_API_KEY: !!OPENAI_API_KEY, TELNYX_API_KEY: !!TELNYX_API_KEY },
      environmentFields: Object.keys(this.env),
    };
  }
  secrets() {
    return [...secretFields.map((k) => this.value[k]), ...secretFields.map((k) => this.saved[k])];
  }
}
