import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from '../src/config.ts';
import { loadEnvironment, runtimeSettings } from '../src/runtime-env.ts';
export function apiCheckContext() {
  if (!process.argv.includes('--run'))
    throw new Error(
      '이 검사는 실제 OpenAI API 요금이 발생합니다. 요청한 검사에만 --run을 명시하세요. Telnyx 발신은 수행하지 않습니다.',
    );
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  loadEnvironment(root);
  const settings = runtimeSettings(root),
    store = new ConfigStore(settings.dataDir);
  if (!store.value.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 필요합니다.');
  return { ...settings, store };
}
