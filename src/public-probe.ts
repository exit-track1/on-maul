import { AppError } from './domain.ts';
export async function publicProbe(base: string, token: string, fetcher: typeof fetch = fetch) {
  if (!base)
    throw new AppError('public_url_missing', '공개 콜백 URL이 없습니다. 공개 연결을 시작하세요.');
  try {
    const r = await fetcher(`${base}/probe/${token}`, {
      signal: AbortSignal.timeout(7000),
      redirect: 'error',
      headers: { 'ngrok-skip-browser-warning': 'onmaul' },
    });
    if (!r.ok)
      throw new AppError(
        'public_probe_failed',
        `공개 콜백 HTTP ${r.status}. 이 URL을 현재 콜백 서버에 연결하세요.`,
      );
    let data: any;
    try {
      data = await r.json();
    } catch {
      throw new AppError(
        'public_probe_failed',
        '공개 URL에서 콜백 JSON을 받지 못했습니다. 다른 서버나 화면에 연결된 주소인지 확인하세요.',
      );
    }
    if (data.onCallback !== token)
      throw new AppError(
        'public_probe_failed',
        '현재 콜백 서버와 공개 URL의 확인 토큰이 다릅니다. 배포 서버 URL과 로컬 터널 URL을 구분하세요.',
      );
    return { name: '공개 콜백', ok: true, message: '통화 전용 포트에 대한 실제 HTTPS 접근 확인' };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'public_probe_failed',
      '공개 콜백에 연결하지 못했습니다. URL·DNS·TLS 또는 터널 실행 상태를 확인하세요.',
    );
  }
}
