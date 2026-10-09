import { Runtime, type View } from '../../../shared/src/runtime.ts';
export class Client {
  readonly local = new Runtime();
  connected = false;
  token = '';
  async connect() {
    const r = await fetch('/api/state');
    if (!r.ok) throw new Error('서버 연결 실패');
    const view = (await r.json()) as View;
    if (!view.data?.metadata?.synthetic)
      throw new Error('mock API 형식이 다릅니다.');
    this.connected = true;
    return view;
  }
  async command(action: string, input: Record<string, unknown> = {}) {
    if (!this.connected) return this.local.command(action, input);
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ action, input }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? '요청 오류');
    return body as View;
  }
}
