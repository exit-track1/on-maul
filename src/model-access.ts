import type { ConfigStore } from './config.ts';
import { AppError } from './domain.ts';
import { LiveConnection, type SocketFactory } from './live.ts';
export async function checkModelAccess(store: ConfigStore, fetcher: typeof fetch = fetch) {
  if (!store.value.OPENAI_API_KEY)
    throw new AppError('openai_key_missing', 'OpenAI API 키를 저장하세요.');
  const checks = [];
  for (const model of new Set([
    store.value.LIVE_MODEL,
    store.value.BACKEND_MODEL,
    store.value.PLANNING_MODEL,
  ])) {
    const r = await fetcher('https://api.openai.com/v1/models/' + encodeURIComponent(model), {
      headers: { Authorization: `Bearer ${store.value.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    checks.push({
      name: model,
      ok: r.ok,
      message: r.ok
        ? '모델 조회 접근 확인. 실제 음성·추론·전화는 미검증.'
        : `모델 조회 실패 HTTP ${r.status}`,
    });
  }
  return { checks, note: '발신 없이 모델 조회만 수행했습니다.' };
}
export async function checkConnection(
  store: ConfigStore,
  fetcher: typeof fetch = fetch,
  factory?: SocketFactory,
) {
  const config = { ...store.value },
    checks: { name: string; ok: boolean; message: string }[] = [];
  try {
    if (!config.TELNYX_API_KEY || !config.TELNYX_APPLICATION_ID)
      throw new Error('Telnyx API 키와 앱 ID가 필요합니다.');
    const r = await fetcher(
      `https://api.telnyx.com/v2/call_control_applications/${encodeURIComponent(config.TELNYX_APPLICATION_ID)}`,
      {
        headers: { Authorization: `Bearer ${config.TELNYX_API_KEY}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!r.ok) throw new Error(`Telnyx HTTP ${r.status}`);
    const data = (await r.json()) as any;
    const app = data.data;
    checks.push({
      name: 'Telnyx 앱·프로필',
      ok: app?.active === true && !!app.outbound?.outbound_voice_profile_id,
      message: `활성 앱 ${app?.active === true ? '확인' : '미확인'} · Outbound Voice Profile ${app?.outbound?.outbound_voice_profile_id ? '연결' : '미연결'}.`,
    });
    const profileId = app?.outbound?.outbound_voice_profile_id;
    if (typeof profileId === 'string' && profileId) {
      const profileResponse = await fetcher(
        `https://api.telnyx.com/v2/outbound_voice_profiles/${encodeURIComponent(profileId)}`,
        {
          headers: { Authorization: `Bearer ${config.TELNYX_API_KEY}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!profileResponse.ok)
        throw new Error(`Outbound Voice Profile HTTP ${profileResponse.status}`);
      const { data: profile } = (await profileResponse.json()) as any;
      const allowed =
        Array.isArray(profile?.whitelisted_destinations) &&
        profile.whitelisted_destinations.includes('KR');
      checks.push({
        name: '한국 목적지 발신 설정',
        ok: profile?.enabled === true && allowed,
        message: `프로필 ${profile?.enabled === true ? '활성' : '비활성·미확인'} · KR 목적지 ${allowed ? '허용' : '미확인'}. 번호 인증·잔액·실제 발신 성공은 별도 확인이 필요합니다.`,
      });
    }
  } catch (error) {
    checks.push({
      name: 'Telnyx 앱·프로필',
      ok: false,
      message: error instanceof Error ? error.message : '조회 실패',
    });
  }
  let live: LiveConnection | undefined;
  try {
    if (!config.OPENAI_API_KEY) throw new Error('OpenAI API 키가 필요합니다.');
    live = new LiveConnection(config, 'resident', factory, '', undefined, true);
    live.on('fault', () => {});
    await live.waitReady();
    checks.push({
      name: 'Live 세션',
      ok: true,
      message:
        '주민 전화의 client delegation으로 session.started 확인. 실제 음성 추론·휴대전화 응답은 미검증.',
    });
  } catch (error) {
    checks.push({
      name: 'Live 세션',
      ok: false,
      message: error instanceof Error ? error.message : '연결 실패',
    });
  } finally {
    live?.close();
  }
  return { checks, note: '전화 발신 없음. 짧은 Live 음성 세션 요금은 발생할 수 있습니다.' };
}
