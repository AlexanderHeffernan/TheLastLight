import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PrivateRoomOffer {
  peerId: string;
  callsign: string;
  offer: Record<string, unknown>;
}

export interface PrivateRoomAnswer {
  answer?: Record<string, unknown>;
  error?: string;
}

interface PrivateRoom {
  hostToken: string;
  hostPlayerId?: string;
  hostCallsign?: string;
  guestPlayerId?: string;
  guestCallsign?: string;
  createdAt: number;
  lastHostPollAt: number;
  lastHostPersistedAt: number;
  offers: Map<string, PrivateRoomOffer>;
  answers: Map<string, PrivateRoomAnswer>;
  restartOffer?: RestartDescription;
  restartAnswer?: RestartDescription;
  leaderboardResult?: LeaderboardResult;
}

interface StoredPrivateRoom extends Omit<PrivateRoom, 'offers' | 'answers' | 'lastHostPersistedAt'> {
  roomCode: string;
  offers: PrivateRoomOffer[];
  answers: Array<[string, PrivateRoomAnswer]>;
}

export interface RestartDescription {
  peerId: string;
  generation: number;
  description: Record<string, unknown>;
}

export interface LeaderboardResult {
  rank: number | null;
  newRecord: boolean;
  available: boolean;
}

export interface DuoRoomAuthorization {
  hostPlayerId: string;
  guestPlayerId: string;
}

const ROOM_TTL_MS = 30 * 60 * 1000;
// Browser timers can be suspended for a while when a mobile app is backgrounded.
// Keep the room long enough for pageshow/visibility restoration to refresh it.
const HOST_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const HOST_POLL_PERSIST_INTERVAL_MS = 10 * 1000;
const MAX_ACTIVE_ROOMS = 256;
const MAX_SIGNALING_OBJECT_BYTES = 128 * 1024;
const ROOM_CODE_LENGTH = 6;
// Avoid characters that are easy to confuse when a code is read aloud.
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ234679';

export type PrivateRoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

export class PrivateRoomStore {
  private readonly rooms = new Map<string, PrivateRoom>();
  private writeQueue: Promise<void> = Promise.resolve();
  private saveRequested = false;
  private saveRunning = false;

  constructor(private readonly path = './data/private-rooms.json') {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      for (const value of parsed) {
        const stored = normalizeStoredRoom(value);
        if (!stored || now - stored.lastHostPollAt > ROOM_TTL_MS) continue;
        this.rooms.set(stored.roomCode, {
          hostToken: stored.hostToken,
          hostPlayerId: stored.hostPlayerId,
          hostCallsign: stored.hostCallsign,
          guestPlayerId: stored.guestPlayerId,
          guestCallsign: stored.guestCallsign,
          createdAt: stored.createdAt,
          // Give connected clients time to resume polling after the process returns.
          lastHostPollAt: now,
          lastHostPersistedAt: now,
          offers: new Map(stored.offers.map((offer) => [offer.peerId, offer])),
          answers: new Map(stored.answers),
          restartOffer: stored.restartOffer,
          restartAnswer: stored.restartAnswer,
          leaderboardResult: stored.leaderboardResult,
        });
      }
      this.queueSave();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Could not load private rooms: ${errorMessage(error)}`);
      }
    }
  }

  async flush(): Promise<void> {
    while (this.saveRunning || this.saveRequested) await this.writeQueue;
    await this.writeQueue;
  }

  create(hostPlayerId: string, hostCallsign: string): PrivateRoomResult<{ roomCode: string; hostToken: string }> {
    this.cleanup();
    if (!validUuid(hostPlayerId) || !hostCallsign.trim() || hostCallsign.length > 18) {
      return failure(400, 'Invalid host.');
    }
    if (this.rooms.size >= MAX_ACTIVE_ROOMS) {
      return failure(503, 'Too many active private rooms. Try again shortly.');
    }
    let roomCode = createRoomCode();
    while (this.rooms.has(roomCode)) roomCode = createRoomCode();
    const now = Date.now();
    const hostToken = randomUUID();
    this.rooms.set(roomCode, {
      hostToken,
      hostPlayerId,
      hostCallsign: hostCallsign.trim(),
      createdAt: now,
      lastHostPollAt: now,
      lastHostPersistedAt: now,
      offers: new Map(),
      answers: new Map(),
    });
    this.queueSave();
    return { ok: true, value: { roomCode, hostToken } };
  }

  addOffer(
    roomCode: string,
    peerId: unknown,
    guestPlayerId: unknown,
    callsign: unknown,
    offer: unknown,
  ): PrivateRoomResult<null> {
    const room = this.get(roomCode);
    if (!room) return failure(404, 'Room not found or expired.');
    if (!validUuid(peerId) || !validUuid(guestPlayerId)
      || typeof callsign !== 'string' || !callsign.trim() || callsign.length > 18
      || !fitsSignal(offer)) {
      return failure(400, 'Invalid offer.');
    }
    if (!isRecord(offer)) return failure(400, 'Invalid offer.');
    const existing = room.offers.get(peerId);
    if (existing) {
      // A response can be lost after an offer and answer were stored. Preserve
      // that answer when the guest retries the exact same SDP.
      if (JSON.stringify(existing.offer) === JSON.stringify(offer)) {
        return { ok: true, value: null };
      }
      // Replacing the same peer's SDP permits a clean peer fallback after an
      // unrecoverable ICE restart without admitting a second guest.
      room.offers.set(peerId, { peerId, callsign: callsign.trim(), offer });
      room.answers.delete(peerId);
      room.restartOffer = undefined;
      room.restartAnswer = undefined;
      this.queueSave();
      return { ok: true, value: null };
    }
    if (room.offers.size > 0) return failure(409, 'This room already has a player.');
    room.guestPlayerId = guestPlayerId;
    room.guestCallsign = callsign.trim();
    room.offers.set(peerId, { peerId, callsign: room.guestCallsign, offer });
    this.queueSave();
    return { ok: true, value: null };
  }

  listOffers(roomCode: string, hostToken: unknown): PrivateRoomResult<PrivateRoomOffer[]> {
    const room = this.authenticated(roomCode, hostToken);
    if (!room) return failure(403, 'Invalid host token.');
    this.touchHost(room);
    return { ok: true, value: [...room.offers.values()] };
  }

  addAnswer(
    roomCode: string,
    hostToken: unknown,
    peerId: unknown,
    answer: unknown,
    error?: unknown,
  ): PrivateRoomResult<null> {
    const room = this.authenticated(roomCode, hostToken);
    if (!room) return failure(403, 'Invalid host token.');
    if (!validUuid(peerId) || (!isRecord(answer) && typeof error !== 'string')
      || (isRecord(answer) && !fitsSignal(answer))) {
      return failure(400, 'Invalid answer.');
    }
    if (!room.offers.has(peerId)) return failure(404, 'Offer not found.');
    room.answers.set(peerId, {
      answer: isRecord(answer) ? answer : undefined,
      error: typeof error === 'string' ? error.slice(0, 240) : undefined,
    });
    this.queueSave();
    return { ok: true, value: null };
  }

  getAnswer(roomCode: string, peerId: unknown): PrivateRoomResult<PrivateRoomAnswer | null> {
    const room = this.get(roomCode);
    if (!room) return failure(404, 'Room not found or expired.');
    if (!validUuid(peerId)) return failure(400, 'Invalid peer.');
    return { ok: true, value: room.answers.get(peerId) ?? null };
  }

  addRestartOffer(
    roomCode: string,
    peerId: unknown,
    generation: unknown,
    description: unknown,
  ): PrivateRoomResult<null> {
    const room = this.get(roomCode);
    if (!room) return failure(404, 'Room not found or expired.');
    if (!validUuid(peerId) || !room.offers.has(peerId)
      || !validGeneration(generation) || !isRecord(description) || !fitsSignal(description)) {
      return failure(400, 'Invalid restart offer.');
    }
    room.restartOffer = { peerId, generation, description };
    room.restartAnswer = undefined;
    this.queueSave();
    return { ok: true, value: null };
  }

  getRestartOffer(roomCode: string, hostToken: unknown): PrivateRoomResult<RestartDescription | null> {
    const room = this.authenticated(roomCode, hostToken);
    if (!room) return failure(403, 'Invalid host token.');
    this.touchHost(room);
    return { ok: true, value: room.restartOffer ?? null };
  }

  addRestartAnswer(
    roomCode: string,
    hostToken: unknown,
    peerId: unknown,
    generation: unknown,
    description: unknown,
  ): PrivateRoomResult<null> {
    const room = this.authenticated(roomCode, hostToken);
    if (!room) return failure(403, 'Invalid host token.');
    if (!validUuid(peerId) || !validGeneration(generation) || !isRecord(description)
      || !fitsSignal(description)
      || room.restartOffer?.peerId !== peerId || room.restartOffer.generation !== generation) {
      return failure(400, 'Invalid restart answer.');
    }
    room.restartAnswer = { peerId, generation, description };
    this.queueSave();
    return { ok: true, value: null };
  }

  getRestartAnswer(
    roomCode: string,
    peerId: unknown,
    generation: unknown,
  ): PrivateRoomResult<RestartDescription | null> {
    const room = this.get(roomCode);
    if (!room) return failure(404, 'Room not found or expired.');
    if (!validUuid(peerId) || !validGeneration(generation)) return failure(400, 'Invalid restart peer.');
    const answer = room.restartAnswer;
    return { ok: true, value: answer?.peerId === peerId && answer.generation === generation ? answer : null };
  }

  setLeaderboardResult(
    roomCode: string,
    hostToken: unknown,
    value: unknown,
  ): PrivateRoomResult<null> {
    const room = this.authenticated(roomCode, hostToken);
    if (!room) return failure(403, 'Invalid host token.');
    if (!isLeaderboardResult(value)) return failure(400, 'Invalid leaderboard result.');
    room.leaderboardResult = value;
    this.queueSave();
    return { ok: true, value: null };
  }

  getLeaderboardAuthorization(
    roomCode: string,
    hostToken: unknown,
  ): PrivateRoomResult<DuoRoomAuthorization> {
    const room = this.authenticated(roomCode, hostToken);
    if (!room) return failure(403, 'Invalid host token.');
    if (!room.hostPlayerId || !room.guestPlayerId) {
      return failure(409, 'Duo participant identity is unavailable.');
    }
    return {
      ok: true,
      value: { hostPlayerId: room.hostPlayerId, guestPlayerId: room.guestPlayerId },
    };
  }

  getLeaderboardResult(roomCode: string, peerId: unknown): PrivateRoomResult<LeaderboardResult | null> {
    const room = this.get(roomCode);
    if (!room) return failure(404, 'Room not found or expired.');
    if (!validUuid(peerId) || !room.offers.has(peerId)) return failure(400, 'Invalid result peer.');
    return { ok: true, value: room.leaderboardResult ?? null };
  }

  resetGuest(roomCode: string, hostToken: unknown): PrivateRoomResult<null> {
    const room = this.authenticated(roomCode, hostToken);
    if (!room) return failure(403, 'Invalid host token.');
    room.offers.clear();
    room.answers.clear();
    room.guestPlayerId = undefined;
    room.guestCallsign = undefined;
    room.restartOffer = undefined;
    room.restartAnswer = undefined;
    room.leaderboardResult = undefined;
    room.lastHostPollAt = Date.now();
    this.queueSave();
    return { ok: true, value: null };
  }

  cleanup(): void {
    const now = Date.now();
    let changed = false;
    for (const [roomCode, room] of this.rooms) {
      if (now - room.lastHostPollAt > HOST_POLL_TIMEOUT_MS) {
        this.rooms.delete(roomCode);
        changed = true;
      }
    }
    if (changed) this.queueSave();
  }

  private get(roomCode: string): PrivateRoom | undefined {
    this.cleanup();
    return this.rooms.get(normalizeRoomCode(roomCode));
  }

  private authenticated(roomCode: string, hostToken: unknown): PrivateRoom | undefined {
    const room = this.get(roomCode);
    return room && typeof hostToken === 'string' && hostToken === room.hostToken ? room : undefined;
  }

  private touchHost(room: PrivateRoom): void {
    const now = Date.now();
    room.lastHostPollAt = now;
    if (now - room.lastHostPersistedAt >= HOST_POLL_PERSIST_INTERVAL_MS) {
      room.lastHostPersistedAt = now;
      this.queueSave();
    }
  }

  private queueSave(): void {
    this.saveRequested = true;
    if (this.saveRunning) return;
    this.saveRunning = true;
    this.writeQueue = this.writeQueue.then(async () => {
      while (this.saveRequested) {
        this.saveRequested = false;
        const snapshot = `${JSON.stringify([...this.rooms].map(([roomCode, room]): StoredPrivateRoom => ({
          roomCode,
          hostToken: room.hostToken,
          hostPlayerId: room.hostPlayerId,
          hostCallsign: room.hostCallsign,
          guestPlayerId: room.guestPlayerId,
          guestCallsign: room.guestCallsign,
          createdAt: room.createdAt,
          lastHostPollAt: room.lastHostPollAt,
          offers: [...room.offers.values()],
          answers: [...room.answers],
          restartOffer: room.restartOffer,
          restartAnswer: room.restartAnswer,
          leaderboardResult: room.leaderboardResult,
        })), null, 2)}\n`;
        await mkdir(dirname(this.path), { recursive: true });
        const temporaryPath = `${this.path}.${process.pid}.tmp`;
        await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, this.path);
      }
    }).catch((error: unknown) => {
      this.saveRequested = false;
      console.error(`Could not persist private rooms: ${errorMessage(error)}`);
    }).finally(() => {
      this.saveRunning = false;
      if (this.saveRequested) this.queueSave();
    });
  }
}

function normalizeStoredRoom(value: unknown): StoredPrivateRoom | null {
  if (!isRecord(value)
    || typeof value.roomCode !== 'string'
    || !validUuid(value.hostToken)
    || typeof value.createdAt !== 'number'
    || !Array.isArray(value.offers)
    || !Array.isArray(value.answers)) return null;
  const offers = value.offers.filter((offer): offer is PrivateRoomOffer => isRecord(offer)
    && validUuid(offer.peerId)
    && typeof offer.callsign === 'string'
    && offer.callsign.trim().length <= 18
    && isRecord(offer.offer)
    && fitsSignal(offer.offer));
  const answers = value.answers.filter((entry): entry is [string, PrivateRoomAnswer] => Array.isArray(entry)
    && validUuid(entry[0])
    && isRecord(entry[1]));
  const lastHostPollAt = typeof value.lastHostPollAt === 'number' && Number.isFinite(value.lastHostPollAt)
    ? value.lastHostPollAt
    : value.createdAt;
  return {
    roomCode: normalizeRoomCode(value.roomCode),
    hostToken: value.hostToken,
    hostPlayerId: validUuid(value.hostPlayerId) ? value.hostPlayerId : undefined,
    hostCallsign: typeof value.hostCallsign === 'string' ? value.hostCallsign.slice(0, 18) : undefined,
    guestPlayerId: validUuid(value.guestPlayerId) ? value.guestPlayerId : undefined,
    guestCallsign: typeof value.guestCallsign === 'string' ? value.guestCallsign.slice(0, 18) : undefined,
    createdAt: value.createdAt,
    lastHostPollAt,
    offers,
    answers,
    restartOffer: normalizeRestartDescription(value.restartOffer),
    restartAnswer: normalizeRestartDescription(value.restartAnswer),
    leaderboardResult: isLeaderboardResult(value.leaderboardResult) ? value.leaderboardResult : undefined,
  };
}

function normalizeRestartDescription(value: unknown): RestartDescription | undefined {
  return isRecord(value) && validUuid(value.peerId) && validGeneration(value.generation)
    && isRecord(value.description)
    ? { peerId: value.peerId, generation: value.generation, description: value.description }
    : undefined;
}

function createRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(status: number, message: string): PrivateRoomResult<never> {
  return { ok: false, status, message };
}

function normalizeRoomCode(value: string): string {
  return value.trim().replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validGeneration(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 1000;
}

function fitsSignal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_SIGNALING_OBJECT_BYTES;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isLeaderboardResult(value: unknown): value is LeaderboardResult {
  if (!isRecord(value)) return false;
  return (value.rank === null || (Number.isInteger(value.rank) && Number(value.rank) > 0))
    && typeof value.newRecord === 'boolean'
    && typeof value.available === 'boolean';
}
