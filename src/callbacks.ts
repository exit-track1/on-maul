import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { CallManager } from './calls.ts';
export function verifyWebhook(
  raw: Buffer,
  headers: IncomingHttpHeaders,
  key: string,
  now = Date.now(),
) {
  const timestamp = headers['telnyx-timestamp'],
    signature = headers['telnyx-signature-ed25519'];
  if (
    typeof timestamp !== 'string' ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Number(timestamp) * 1000 - now) > 300000 ||
    typeof signature !== 'string' ||
    !key
  )
    return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(key, 'base64'),
      ]),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp + '|'), raw]),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}
export async function readRaw(req: IncomingMessage, limit = 65536) {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const piece of req) {
    size += piece.length;
    if (size > limit) throw new Error('요청 크기 초과');
    buffers.push(Buffer.from(piece));
  }
  return Buffer.concat(buffers);
}
export function callbackServer(calls: CallManager, probeToken: string) {
  const webSocket = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET' && req.url === `/probe/${probeToken}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ onCallback: probeToken }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/webhooks/telnyx') {
        res.writeHead(404);
        res.end();
        return;
      }
      const raw = await readRaw(req);
      if (!verifyWebhook(raw, req.headers, calls.current.config.TELNYX_PUBLIC_KEY)) {
        res.writeHead(401);
        res.end();
        return;
      }
      const event = JSON.parse(raw.toString());
      calls.webhook(event);
      res.writeHead(200);
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const token = /^\/media\/([a-f0-9]{64})$/.exec(req.url ?? '')?.[1];
    if (!token || !calls.mediaAllowed(token)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    webSocket.handleUpgrade(req, socket, head, (client) => calls.attachMedia(client));
  });
  server.requestTimeout = 10000;
  server.on('close', () => {
    for (const client of webSocket.clients) client.terminate();
    webSocket.close();
  });
  return server;
}
