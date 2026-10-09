import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from './domain.ts';
import { readRaw } from './callbacks.ts';
export function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
export async function body(req: IncomingMessage, limit = 65536): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new AppError('json_required', 'JSON 요청만 허용합니다.', 415);
  try {
    const value = JSON.parse((await readRaw(req, limit)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AppError('invalid_body', '요청 크기와 JSON 형식을 확인하세요.');
  }
}
export function localRequestPath(req: IncomingMessage, port: number, token: string) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (!hosts.has(req.headers.host ?? ''))
    throw new AppError('host_rejected', '로컬 주소에서만 접근할 수 있습니다.', 403);
  if (req.headers.origin) {
    let origin: URL;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      throw new AppError('origin_rejected', '잘못된 Origin', 403);
    }
    if (
      origin.protocol !== 'http:' ||
      !hosts.has(origin.host) ||
      origin.username ||
      origin.password
    )
      throw new AppError('origin_rejected', '같은 로컬 화면에서 접근하세요.', 403);
  }
  if (req.headers['sec-fetch-site'] === 'cross-site')
    throw new AppError('cross_site_rejected', '외부 사이트 요청을 차단했습니다.', 403);
  if (req.method === 'POST') {
    const supplied = Buffer.from(String(req.headers['x-on-token'] ?? '')),
      expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new AppError('csrf_rejected', '화면을 새로고침하세요.', 403);
  }
  return new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
}
export class EventStream {
  clients = new Set<ServerResponse>();
  publish(value: unknown) {
    const message = `data: ${JSON.stringify(value)}\n\n`;
    for (const res of this.clients) {
      if (res.writableLength > 1024 * 1024) {
        res.destroy();
        this.clients.delete(res);
      } else res.write(message);
    }
  }
  subscribe(req: IncomingMessage, res: ServerResponse, value: unknown) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(value)}\n\n`);
    this.clients.add(res);
    const timer = setInterval(() => res.write(': keepalive\n\n'), 15000);
    timer.unref();
    res.once('close', () => {
      clearInterval(timer);
      this.clients.delete(res);
    });
  }
  close() {
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
