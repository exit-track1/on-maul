import { existsSync, accessSync, constants } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
export function phoneEnvironment(env = process.env): 'local' | 'deployment' {
  const value =
    env.ON_PHONE_ENV?.trim() || (env.NODE_ENV === 'production' ? 'deployment' : 'local');
  if (value !== 'local' && value !== 'deployment')
    throw new Error('ON_PHONE_ENV는 local 또는 deployment여야 합니다.');
  return value;
}
export function loadEnvironment(root: string) {
  const explicit = process.env.ON_ENV_FILE?.trim();
  const path = explicit
    ? resolve(root, explicit)
    : phoneEnvironment() === 'local' && existsSync(join(root, '.phone', '.env'))
      ? join(root, '.phone', '.env')
      : join(root, '.env');
  if (explicit || existsSync(path)) process.loadEnvFile(path);
  return path;
}
export function runtimeSettings(root: string, env = process.env) {
  const parse = (key: string, fallback: number) => {
    const n = env[key]?.trim() ? Number(env[key]) : fallback;
    if (!Number.isInteger(n) || n < 1024 || n > 65535)
      throw new Error(`${key}: 1024~65535 포트가 필요합니다.`);
    return n;
  };
  const port = parse('PORT', 8787),
    callbackPort = parse('CALLBACK_PORT', 8788);
  if (port === callbackPort) throw new Error('UI와 콜백 포트는 달라야 합니다.');
  let tunnelBinary = env.CLOUDFLARED_PATH?.trim();
  if (!tunnelBinary)
    for (const candidate of [
      join(root, '.tools/cloudflared'),
      ...(env.PATH ?? '').split(delimiter).map((d) => join(d, 'cloudflared')),
    ]) {
      try {
        accessSync(candidate, constants.X_OK);
        tunnelBinary = candidate;
        break;
      } catch {
        /* next candidate */
      }
    }
  return {
    environment: phoneEnvironment(env),
    port,
    callbackPort,
    dataDir: resolve(root, env.ON_LOCAL_DATA_DIR?.trim() || '.data'),
    tunnelBinary: tunnelBinary ? resolve(root, tunnelBinary) : undefined,
  };
}
