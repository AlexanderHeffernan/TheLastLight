import { createReadStream } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChangelogStore } from './ChangelogStore.js';
import { GameStore } from './GameStore.js';
import { PrivateRoomStore } from './PrivateRoomStore.js';

const port = Number(process.env.PORT || 3000);
const clientDirectory = resolve(fileURLToPath(new URL('../client/', import.meta.url)));
const dataDirectory = process.env.DATA_DIR || '/data';
const gameStore = new GameStore(resolve(dataDirectory, 'game-data.json'));
const changelog = new ChangelogStore(new URL('../client/changelog.json', import.meta.url));
const privateRooms = new PrivateRoomStore(resolve(dataDirectory, 'private-rooms.json'));
const limits = new Map<string, { count: number; resetsAt: number }>();
const lastUpdateValue = resolveLastUpdate();
const MAX_JSON_BODY_BYTES = 256 * 1024;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;
const skinAdminToken = process.env.SKIN_ADMIN_TOKEN?.trim() || undefined;

await Promise.all([gameStore.load(), changelog.load(), privateRooms.load()]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/status') {
      return json(response, { ...gameStore.status(), lastUpdate: lastUpdateValue });
    }
    if (request.method === 'POST' && url.pathname === '/api/plays') {
      if (!allow(request, 'plays', 30)) return json(response, { error: 'Too many requests' }, 429);
      return json(response, { playCount: gameStore.recordPlay(), lastUpdate: lastUpdateValue });
    }
    if (request.method === 'POST' && url.pathname === '/api/private-rooms') {
      if (!allow(request, 'private-room-create', 12)) return json(response, { error: 'Too many requests' }, 429);
      const body = await readJson(request);
      const hostPlayerId = playerId(request, response);
      const claim = await gameStore.claimName(body.callsign, hostPlayerId);
      if (!claim.ok) return json(response, { error: claim.message }, nameClaimStatus(claim.reason));
      const room = privateRooms.create(hostPlayerId, claim.name);
      return room.ok ? json(response, room.value) : json(response, { error: room.message }, room.status);
    }
    const offerPath = /^\/api\/private-rooms\/([^/]+)\/offers$/.exec(url.pathname);
    if (offerPath && request.method === 'POST') {
      if (!allow(request, 'private-room-offer', 12)) return json(response, { error: 'Too many requests' }, 429);
      const body = await readJson(request);
      const guestPlayerId = playerId(request, response);
      const claim = await gameStore.claimName(body.callsign, guestPlayerId);
      if (!claim.ok) return json(response, { error: claim.message }, nameClaimStatus(claim.reason));
      const result = privateRooms.addOffer(
        decodeURIComponent(offerPath[1]),
        body.peerId,
        guestPlayerId,
        claim.name,
        body.offer,
      );
      if (result.ok) return json(response, { ok: true });
      return json(response, { error: result.message }, result.status);
    }
    if (offerPath && request.method === 'GET') {
      if (!allow(request, 'private-room-offer-poll', 240)) return json(response, { error: 'Too many requests' }, 429);
      const result = privateRooms.listOffers(decodeURIComponent(offerPath[1]), hostToken(request));
      if (result.ok) {
        return json(response, {
          offers: result.value.map((offer) => ({
            ...offer,
            skinIds: gameStore.playerSkinIds(offer.callsign),
          })),
        });
      }
      return json(response, { error: result.message }, result.status);
    }
    const answerPath = /^\/api\/private-rooms\/([^/]+)\/answers$/.exec(url.pathname);
    if (answerPath && request.method === 'POST') {
      if (!allow(request, 'private-room-answer', 24)) return json(response, { error: 'Too many requests' }, 429);
      const body = await readJson(request);
      const result = privateRooms.addAnswer(
        decodeURIComponent(answerPath[1]),
        hostToken(request),
        body.peerId,
        body.answer,
        body.error,
      );
      if (result.ok) return json(response, { ok: true });
      return json(response, { error: result.message }, result.status);
    }
    const answerForPeerPath = /^\/api\/private-rooms\/([^/]+)\/answers\/([^/]+)$/.exec(url.pathname);
    if (answerForPeerPath && request.method === 'GET') {
      if (!allow(request, 'private-room-answer-poll', 240)) return json(response, { error: 'Too many requests' }, 429);
      const result = privateRooms.getAnswer(
        decodeURIComponent(answerForPeerPath[1]),
        decodeURIComponent(answerForPeerPath[2]),
      );
      if (result.ok) return json(response, result.value ?? {});
      return json(response, { error: result.message }, result.status);
    }
    const guestResetPath = /^\/api\/private-rooms\/([^/]+)\/guest$/.exec(url.pathname);
    if (guestResetPath && request.method === 'POST') {
      if (!allow(request, 'private-room-kick', 24)) return json(response, { error: 'Too many requests' }, 429);
      await readJson(request);
      const result = privateRooms.resetGuest(decodeURIComponent(guestResetPath[1]), hostToken(request));
      if (result.ok) return json(response, { ok: true });
      return json(response, { error: result.message }, result.status);
    }
    const restartOfferPath = /^\/api\/private-rooms\/([^/]+)\/restart-offer$/.exec(url.pathname);
    if (restartOfferPath && request.method === 'POST') {
      if (!allow(request, 'private-room-restart-offer', 12)) return json(response, { error: 'Too many requests' }, 429);
      const body = await readJson(request);
      const result = privateRooms.addRestartOffer(
        decodeURIComponent(restartOfferPath[1]), body.peerId, body.generation, body.description,
      );
      if (result.ok) return json(response, { ok: true });
      return json(response, { error: result.message }, result.status);
    }
    if (restartOfferPath && request.method === 'GET') {
      if (!allow(request, 'private-room-restart-poll', 240)) return json(response, { error: 'Too many requests' }, 429);
      const result = privateRooms.getRestartOffer(
        decodeURIComponent(restartOfferPath[1]), hostToken(request),
      );
      if (result.ok) return json(response, result.value ?? {});
      return json(response, { error: result.message }, result.status);
    }
    const restartAnswerPath = /^\/api\/private-rooms\/([^/]+)\/restart-answer$/.exec(url.pathname);
    if (restartAnswerPath && request.method === 'POST') {
      if (!allow(request, 'private-room-restart-answer', 12)) return json(response, { error: 'Too many requests' }, 429);
      const body = await readJson(request);
      const result = privateRooms.addRestartAnswer(
        decodeURIComponent(restartAnswerPath[1]), hostToken(request), body.peerId,
        body.generation, body.description,
      );
      if (result.ok) return json(response, { ok: true });
      return json(response, { error: result.message }, result.status);
    }
    if (restartAnswerPath && request.method === 'GET') {
      if (!allow(request, 'private-room-restart-answer-poll', 240)) return json(response, { error: 'Too many requests' }, 429);
      const result = privateRooms.getRestartAnswer(
        decodeURIComponent(restartAnswerPath[1]),
        url.searchParams.get('peerId'),
        Number(url.searchParams.get('generation')),
      );
      if (result.ok) return json(response, result.value ?? {});
      return json(response, { error: result.message }, result.status);
    }
    const roomResultPath = /^\/api\/private-rooms\/([^/]+)\/result$/.exec(url.pathname);
    if (roomResultPath && request.method === 'POST') {
      if (!allow(request, 'private-room-result', 12)) return json(response, { error: 'Too many requests' }, 429);
      const body = await readJson(request);
      const result = privateRooms.setLeaderboardResult(
        decodeURIComponent(roomResultPath[1]), hostToken(request), body.result,
      );
      if (result.ok) return json(response, { ok: true });
      return json(response, { error: result.message }, result.status);
    }
    if (roomResultPath && request.method === 'GET') {
      if (!allow(request, 'private-room-result-poll', 60)) return json(response, { error: 'Too many requests' }, 429);
      const result = privateRooms.getLeaderboardResult(
        decodeURIComponent(roomResultPath[1]), url.searchParams.get('peerId'),
      );
      if (result.ok) return json(response, { result: result.value });
      return json(response, { error: result.message }, result.status);
    }
    if (url.pathname === '/api/admin/skin-access') {
      if (!skinAdminToken || !hasSkinAdminAccess(request, skinAdminToken)) {
        return json(response, { error: 'Not found' }, 404);
      }
      if (!allow(request, 'skin-access-admin', 60)) return json(response, { error: 'Too many requests' }, 429);
      if (request.method === 'GET') return json(response, { skinAccess: gameStore.skinAccessEntries() });
      if (request.method !== 'POST' && request.method !== 'DELETE') {
        return json(response, { error: 'Method not allowed' }, 405);
      }
      const body = await readJson(request);
      const result = request.method === 'POST'
        ? await gameStore.grantSkinAccess(body.skinId, body.callsign)
        : await gameStore.revokeSkinAccess(body.skinId, body.callsign);
      if (!result.ok) return json(response, { error: result.message }, 400);
      return json(response, result);
    }
    if (request.method === 'GET' && url.pathname === '/api/player') {
      if (!allow(request, 'player-check', 60)) return json(response, { error: 'Too many requests' }, 429);
      const result = gameStore.checkName(url.searchParams.get('name') ?? '', playerId(request, response));
      if (result.ok) return json(response, result);
      return json(response, { error: result.message }, nameClaimStatus(result.reason));
    }
    if (request.method === 'POST' && url.pathname === '/api/player') {
      if (!allow(request, 'player-claim', 12)) return json(response, { error: 'Too many requests' }, 429);
      const body = await readJson(request);
      const claim = await gameStore.claimName(body.name, playerId(request, response));
      if (claim.ok) return json(response, claim);
      return json(response, { error: claim.message }, nameClaimStatus(claim.reason));
    }
    if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
      if (!allow(request, 'leaderboard-read', 60)) return json(response, { error: 'Too many requests' }, 429);
      const mode = url.searchParams.get('mode') === 'duos' ? 'duos' : 'solo';
      return json(response, { entries: gameStore.entries(playerId(request, response), mode) });
    }
    if (request.method === 'POST' && url.pathname === '/api/leaderboard') {
      if (!allow(request, 'leaderboard-submit', 12)) return json(response, { error: 'Too many requests' }, 429);
      const body = await readJson(request);
      if (body.mode === 'duos') {
        const authorization = privateRooms.getLeaderboardAuthorization(
          headerValue(request, 'x-duo-room-code') ?? '',
          hostToken(request),
        );
        if (!authorization.ok) return json(response, { error: authorization.message }, authorization.status);
        if (!gameStore.duoCallsignsOwned(
          body.players,
          authorization.value.hostPlayerId,
          authorization.value.guestPlayerId,
        )) {
          return json(response, { error: 'Duo callsigns are not owned by both participants.' }, 403);
        }
      }
      const result = await gameStore.submit(
        playerId(request, response),
        body.name,
        body.score,
        body.survivalMs,
        body.threat,
        body.submissionId,
        body.mode,
        body.players,
      );
      if (result.ok) return json(response, result);
      return json(
        response,
        {
          error: result.reason === 'name-taken'
            ? 'Callsign already in use.'
            : result.reason === 'capacity'
              ? 'The callsign registry is temporarily full.'
              : 'Invalid score.',
        },
        result.reason === 'name-taken' ? 409 : result.reason === 'capacity' ? 503 : 400,
      );
    }
    if (request.method === 'GET' && url.pathname === '/api/changelog') {
      return json(response, changelog.current());
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, { error: 'Not found' }, 404);
    return await serveStatic(request, response, url.pathname);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    if (!response.headersSent) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Internal server error';
      json(response, { error: message }, status);
    }
    else response.destroy();
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`The Last Light listening on 0.0.0.0:${port}`);
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.close(() => finish());
      const timeout = setTimeout(finish, 5000);
      timeout.unref();
    });
    await Promise.all([gameStore.flush(), privateRooms.flush()]);
    process.exit(0);
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

async function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return json(response, { error: 'Bad request' }, 400);
  }
  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  let filePath = resolve(clientDirectory, relativePath);
  if (filePath !== clientDirectory && !filePath.startsWith(`${clientDirectory}${sep}`)) {
    return json(response, { error: 'Not found' }, 404);
  }
  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      fileStat = await stat(filePath);
    }
    if (!fileStat.isFile()) throw new Error('Not a file');
  } catch {
    if (!extname(relativePath)) filePath = resolve(clientDirectory, 'index.html');
    else return json(response, { error: 'Not found' }, 404);
    fileStat = await stat(filePath);
  }

  const rangeHeader = request.headers.range;
  const range = typeof rangeHeader === 'string' ? parseByteRange(rangeHeader, fileStat.size) : undefined;
  if (rangeHeader && !range) {
    response.statusCode = 416;
    response.setHeader('content-range', `bytes */${fileStat.size}`);
    response.end();
    return;
  }

  response.statusCode = range ? 206 : 200;
  response.setHeader('content-type', mimeType(filePath));
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('cache-control', filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  response.setHeader('accept-ranges', 'bytes');
  response.setHeader('content-length', String(range ? range.end - range.start + 1 : fileStat.size));
  if (range) response.setHeader('content-range', `bytes ${range.start}-${range.end}/${fileStat.size}`);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined).pipe(response);
}

function parseByteRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return undefined;
  const requestedStart = match[1] ? Number(match[1]) : undefined;
  const requestedEnd = match[2] ? Number(match[2]) : undefined;
  if (requestedStart !== undefined && !Number.isSafeInteger(requestedStart)) return undefined;
  if (requestedEnd !== undefined && !Number.isSafeInteger(requestedEnd)) return undefined;

  if (requestedStart === undefined) {
    const suffixLength = requestedEnd ?? 0;
    if (suffixLength <= 0) return undefined;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  if (requestedStart >= size) return undefined;
  if (requestedEnd !== undefined && requestedEnd < requestedStart) return undefined;
  return {
    start: requestedStart,
    end: Math.min(requestedEnd ?? size - 1, size - 1),
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'Request body too large');
  }
  try {
    const parsed = JSON.parse(body || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function allow(request: IncomingMessage, action: string, maximum: number): boolean {
  const address = clientAddress(request);
  const key = `${address}:${action}`;
  const now = Date.now();
  if (limits.size >= MAX_RATE_LIMIT_ENTRIES && !limits.has(key)) {
    for (const [entryKey, entry] of limits) {
      if (now >= entry.resetsAt) limits.delete(entryKey);
    }
    if (limits.size >= MAX_RATE_LIMIT_ENTRIES) return false;
  }
  const current = limits.get(key);
  if (!current || now >= current.resetsAt) {
    limits.set(key, { count: 1, resetsAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= maximum;
}

function clientAddress(request: IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = request.headers['cf-connecting-ip'] || request.headers['x-forwarded-for'];
    const value = String(Array.isArray(forwarded) ? forwarded[0] : forwarded ?? '').split(',')[0].trim();
    if (value) return value;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function hostToken(request: IncomingMessage): string | undefined {
  return headerValue(request, 'x-duo-host-token');
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function hasSkinAdminAccess(request: IncomingMessage, expectedToken: string): boolean {
  const authorization = headerValue(request, 'authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const received = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function nameClaimStatus(reason: 'invalid' | 'name-taken' | 'capacity'): number {
  return reason === 'name-taken' ? 409 : reason === 'capacity' ? 503 : 400;
}

function playerId(request: IncomingMessage, response: ServerResponse): string {
  const stored = request.headers.cookie
    ?.split(';')
    .map((cookie) => cookie.trim().split('='))
    .find(([name]) => name === 'last_light_player')?.[1];
  if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) {
    return stored;
  }
  const id = randomUUID();
  const forwardedProtocol = TRUST_PROXY
    ? String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
    : '';
  const secure = forwardedProtocol === 'https' ? '; Secure' : '';
  response.setHeader(
    'set-cookie',
    `last_light_player=${id}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax${secure}`,
  );
  return id;
}

function resolveLastUpdate(): string {
  const value = process.env.LAST_UPDATE || process.env.BUILD_DATE || process.env.SOURCE_DATE_EPOCH;
  if (value) {
    const parsed = /^\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const buildTimestamp = Number(process.env.BUILD_TIMESTAMP);
  return new Date(Number.isFinite(buildTimestamp) && buildTimestamp > 0 ? buildTimestamp : Date.now()).toISOString();
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify(value));
}

function mimeType(path: string): string {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.xml': 'application/xml; charset=utf-8',
  } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
