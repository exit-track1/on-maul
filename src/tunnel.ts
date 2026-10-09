import { spawn, type ChildProcess } from 'node:child_process';
import { AppError } from './domain.ts';
export class Tunnel {
  binary: string | undefined;
  port: number;
  child?: ChildProcess;
  url = '';
  status = 'stopped';
  constructor(binary: string | undefined, port: number) {
    this.binary = binary;
    this.port = port;
  }
  public() {
    return { status: this.status, url: this.url };
  }
  async start() {
    if (this.child) throw new AppError('tunnel_running', '공개 연결이 이미 실행 중입니다.', 409);
    if (!this.binary)
      throw new AppError(
        'cloudflared_missing',
        'cloudflared 실행파일이 없습니다. PATH 또는 CLOUDFLARED_PATH를 설정하거나 ngrok http ' +
          this.port +
          '를 사용하세요.',
      );
    this.status = 'starting';
    const child = spawn(
      this.binary,
      ['tunnel', '--url', `http://127.0.0.1:${this.port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    return new Promise<string>((resolve, reject) => {
      let tail = '';
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) {
          this.stop();
          reject(error);
        } else resolve(this.url);
      };
      const output = (data: Buffer) => {
        tail = (tail + data.toString()).slice(-16000);
        const url = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
        if (url && this.status === 'starting') {
          this.url = url;
          this.status = 'ready';
          finish();
        }
      };
      const timer = setTimeout(
        () => finish(new AppError('tunnel_timeout', '30초 내 공개 주소를 받지 못했습니다.')),
        30000,
      );
      child.stdout?.on('data', output);
      child.stderr?.on('data', output);
      child.once('error', () =>
        finish(
          new AppError('tunnel_start_failed', 'cloudflared 실행 실패. 설치 경로를 확인하세요.'),
        ),
      );
      child.once('exit', () => {
        if (this.status === 'starting')
          finish(new AppError('tunnel_exited', '공개 연결이 종료됐습니다.'));
        if (this.child === child) {
          this.child = undefined;
          this.status = 'stopped';
          this.url = '';
        }
      });
    });
  }
  stop() {
    const child = this.child;
    this.child = undefined;
    this.status = 'stopped';
    this.url = '';
    child?.kill('SIGTERM');
  }
}
