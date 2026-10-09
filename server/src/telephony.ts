import Telnyx from 'telnyx';
import { createPublicKey, verify, randomUUID } from 'node:crypto';
import { z } from 'zod';
export const Config = z.object({
  mode: z.enum(['demo', 'hybrid']).default('demo'),
  port: z.coerce.number().int().min(1024).max(65535).default(8090),
  apiKey: z.string().default(''),
  connectionId: z.string().default(''),
  from: z.string().default(''),
  publicKey: z.string().default(''),
  publicUrl: z.string().default(''),
  operatorToken: z.string().default(''),
  residentNumber: z.string().default(''),
  memberNumber: z.string().default(''),
  residentConsent: z.boolean().default(false),
  memberConsent: z.boolean().default(false),
});
export type TelephonyConfig = z.infer<typeof Config>;
export function config(env: NodeJS.ProcessEnv = process.env): TelephonyConfig {
  const c = Config.parse({
    mode: env.ON_EXECUTION_MODE ?? 'demo',
    port: env.ON_PORT ?? 8090,
    apiKey: env.TELNYX_API_KEY,
    connectionId: env.TELNYX_APPLICATION_ID,
    from: env.CALLER_NUMBER,
    publicKey: env.TELNYX_PUBLIC_KEY,
    publicUrl: env.PUBLIC_BASE_URL,
    operatorToken: env.ON_OPERATOR_TOKEN,
    residentNumber: env.REAL_RESIDENT_E164,
    memberNumber: env.REAL_SQUAD_E164,
    residentConsent: env.REAL_RESIDENT_CONSENT === 'yes',
    memberConsent: env.REAL_SQUAD_CONSENT === 'yes',
  });
  if (c.mode === 'hybrid') {
    if (
      !c.apiKey ||
      !c.connectionId ||
      !/^\+[1-9]\d{7,14}$/.test(c.from) ||
      Buffer.from(c.publicKey, 'base64').length !== 32 ||
      !c.publicUrl.startsWith('https://') ||
      c.operatorToken.length < 32
    )
      throw new Error(
        'hybrid 통화 설정이 불완전합니다. 키·발신번호·공개키·HTTPS·담당자 토큰을 확인하세요.',
      );
    for (const number of [c.residentNumber, c.memberNumber])
      if (number && !/^\+[1-9]\d{7,14}$/.test(number))
        throw new Error('허용된 실제 수신 번호 형식 오류');
  }
  return c;
}
export interface DialRequest {
  targetId: string;
  targetType: 'resident' | 'member';
  consent: boolean;
  requestId: string;
}
export interface DialResult {
  providerId: string | null;
  requestId: string;
  status: 'mock' | 'initiated' | 'pendingunknown';
  mode: 'mock' | 'telnyx';
}
export interface TelnyxPort {
  dial(request: DialRequest): Promise<DialResult>;
  hangup(providerId: string, requestId: string): Promise<void>;
}
/** Demo branch returns before constructing a network client, even if keys exist. */
export class Telephony implements TelnyxPort {
  constructor(
    readonly settings: TelephonyConfig,
    private client?: Telnyx,
  ) {}
  async dial(request: DialRequest): Promise<DialResult> {
    if (this.settings.mode === 'demo')
      return { providerId: null, requestId: request.requestId, status: 'mock', mode: 'mock' };
    const resident = request.targetType === 'resident';
    if (
      request.targetId !== (resident ? 'H012' : 'M01') ||
      !request.consent ||
      !(resident ? this.settings.residentConsent : this.settings.memberConsent)
    )
      throw new Error('동의된 시연 수신자만 발신할 수 있습니다.');
    const to = resident ? this.settings.residentNumber : this.settings.memberNumber;
    if (!to) throw new Error('동의된 환경변수 번호가 없습니다.');
    this.client ??= new Telnyx({ apiKey: this.settings.apiKey, maxRetries: 0, timeout: 10000 });
    try {
      const r = await this.client.calls.dial({
        connection_id: this.settings.connectionId,
        from: this.settings.from,
        to,
        command_id: request.requestId,
        client_state: Buffer.from(
          JSON.stringify({ requestId: request.requestId, targetId: request.targetId }),
        ).toString('base64'),
        timeout_secs: 30,
        webhook_url: `${this.settings.publicUrl.replace(/\/$/, '')}/api/telnyx/webhook`,
      });
      return {
        providerId: r.data?.call_control_id ?? null,
        requestId: request.requestId,
        status: r.data?.call_control_id ? 'initiated' : 'pendingunknown',
        mode: 'telnyx',
      };
    } catch {
      return {
        providerId: null,
        requestId: request.requestId,
        status: 'pendingunknown',
        mode: 'telnyx',
      };
    }
  }
  async hangup(providerId: string, requestId: string = randomUUID()) {
    if (this.settings.mode === 'demo') return;
    this.client ??= new Telnyx({ apiKey: this.settings.apiKey, maxRetries: 0, timeout: 10000 });
    await this.client.calls.actions.hangup(providerId, { command_id: requestId });
  }
}
export function verifyWebhook(
  raw: string,
  signature: string,
  timestamp: string,
  publicKey: string,
  nowSeconds = Date.now() / 1000,
): boolean {
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(nowSeconds - Number(timestamp)) > 120 ||
    Buffer.byteLength(raw) > 65536
  )
    return false;
  try {
    const pub = Buffer.from(publicKey, 'base64'),
      sig = Buffer.from(signature, 'base64');
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(`${timestamp}|${raw}`), key, sig);
  } catch {
    return false;
  }
}
