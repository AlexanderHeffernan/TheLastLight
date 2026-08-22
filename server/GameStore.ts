import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validatePlayerName } from '../src/shared/nameValidator.js';

export interface LeaderboardEntry {
  id: string;
  name: string;
  score: number;
  survivalMs: number;
  threat: number | null;
  achievedAt: number;
}

export interface PlayerLeaderboardEntry extends LeaderboardEntry {
  isCurrentPlayer: boolean;
}

interface StoredLeaderboardEntry extends LeaderboardEntry {
  playerId: string | null;
}

interface GameData {
  playCount: number;
  leaderboard: StoredLeaderboardEntry[];
}

export type NameClaimResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'invalid' | 'name-taken'; message: string };

export type ScoreSubmissionResult =
  | { ok: true; entry: LeaderboardEntry }
  | { ok: false; reason: 'invalid' | 'name-taken' };

const EMPTY_DATA: GameData = { playCount: 0, leaderboard: [] };
const LEADERBOARD_LIMIT = 10;

export class GameStore {
  private data: GameData = structuredClone(EMPTY_DATA);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<GameData>;
      this.data = {
        playCount: validInteger(parsed.playCount, 0, Number.MAX_SAFE_INTEGER) ?? 0,
        leaderboard: Array.isArray(parsed.leaderboard)
          ? uniqueLeaderboardEntries(parsed.leaderboard
            .map(normalizeLeaderboardEntry)
            .filter((entry): entry is StoredLeaderboardEntry => entry !== null)
            .sort(compareScores))
            .slice(0, LEADERBOARD_LIMIT)
          : [],
      };
      await this.queueSave();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Could not load game data: ${errorMessage(error)}`);
      }
    }
  }

  status(): { playCount: number } {
    return { playCount: this.data.playCount };
  }

  entries(playerId: string): PlayerLeaderboardEntry[] {
    return this.data.leaderboard.map(({ playerId: ownerId, ...entry }) => ({
      ...entry,
      isCurrentPlayer: ownerId === playerId,
    }));
  }

  recordPlay(): number {
    this.data.playCount += 1;
    void this.queueSave().catch(() => undefined);
    return this.data.playCount;
  }

  async claimName(name: unknown, playerId: string): Promise<NameClaimResult> {
    const nameResult = validatePlayerName(name);
    if (!nameResult.ok || !validPlayerId(playerId)) {
      return {
        ok: false,
        reason: 'invalid',
        message: nameResult.ok ? 'Invalid player.' : nameResult.reason,
      };
    }

    const matchingName = this.data.leaderboard.find((entry) => sameName(entry.name, nameResult.name));
    const currentEntry = this.data.leaderboard.find((entry) => entry.playerId === playerId);
    if (matchingName?.playerId && matchingName.playerId !== playerId) {
      return { ok: false, reason: 'name-taken', message: 'Callsign already in use.' };
    }
    if (matchingName && currentEntry && matchingName !== currentEntry) {
      return { ok: false, reason: 'name-taken', message: 'Callsign already in use.' };
    }

    if (matchingName) {
      if (matchingName.name !== nameResult.name || matchingName.playerId !== playerId) {
        matchingName.name = nameResult.name;
        matchingName.playerId = playerId;
        await this.queueSave();
      }
    } else if (currentEntry && currentEntry.name !== nameResult.name) {
      currentEntry.name = nameResult.name;
      await this.queueSave();
    }

    return { ok: true, name: nameResult.name };
  }

  async submit(
    playerId: string,
    name: unknown,
    score: unknown,
    survivalMs: unknown,
    threat: unknown,
    submissionId?: unknown,
  ): Promise<ScoreSubmissionResult> {
    const nameResult = validatePlayerName(name);
    const normalizedScore = validInteger(score, 0, 100000);
    const normalizedSurvival = validDuration(survivalMs);
    const normalizedThreat = threat === undefined || threat === null ? null : validInteger(threat, 1, 10000);
    const entryId = submissionId === undefined ? randomUUID() : validSubmissionId(submissionId);
    if (!validPlayerId(playerId)
      || !nameResult.ok
      || normalizedScore === null
      || normalizedSurvival === null
      || (threat !== undefined && threat !== null && normalizedThreat === null)
      || !entryId) return { ok: false, reason: 'invalid' };

    const existing = this.data.leaderboard.find((candidate) => candidate.id === entryId);
    if (existing) {
      if (existing.playerId !== playerId) return { ok: false, reason: 'invalid' };
      await this.queueSave();
      return { ok: true, entry: publicEntry(existing) };
    }

    const claim = await this.claimName(nameResult.name, playerId);
    if (!claim.ok) return { ok: false, reason: claim.reason };

    const entry: StoredLeaderboardEntry = {
      id: entryId,
      name: claim.name,
      score: normalizedScore,
      survivalMs: normalizedSurvival,
      threat: normalizedThreat,
      achievedAt: Date.now(),
      playerId,
    };
    const previousBest = this.data.leaderboard.find((candidate) => candidate.playerId === playerId);
    if (previousBest && compareScores(entry, previousBest) >= 0) {
      return { ok: true, entry: publicEntry(previousBest) };
    }
    if (previousBest) {
      this.data.leaderboard = this.data.leaderboard.filter((candidate) => candidate !== previousBest);
    }
    this.data.leaderboard.push(entry);
    this.data.leaderboard.sort(compareScores);
    this.data.leaderboard = this.data.leaderboard.slice(0, LEADERBOARD_LIMIT);
    await this.queueSave();
    return { ok: true, entry: publicEntry(entry) };
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private queueSave(): Promise<void> {
    const snapshot = `${JSON.stringify(this.data, null, 2)}\n`;
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporaryPath, snapshot, 'utf8');
      await rename(temporaryPath, this.path);
    });
    this.writeQueue = operation.catch((error: unknown) => {
      console.error(`Could not persist game data: ${errorMessage(error)}`);
    });
    return operation;
  }
}

function validInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function validDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 24 * 60 * 60 * 1000
    ? Math.round(value)
    : null;
}

function compareScores(left: LeaderboardEntry, right: LeaderboardEntry): number {
  return right.score - left.score
    || right.survivalMs - left.survivalMs
    || left.achievedAt - right.achievedAt;
}

function validSubmissionId(value: unknown): string | null {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function normalizeLeaderboardEntry(value: unknown): StoredLeaderboardEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as LeaderboardEntry;
  const name = validatePlayerName(entry.name);
  const threat = entry.threat === undefined || entry.threat === null
    ? null
    : validInteger(entry.threat, 1, 10000);
  const playerId = 'playerId' in entry && entry.playerId !== undefined && entry.playerId !== null
    ? validPlayerId(entry.playerId) ? entry.playerId : undefined
    : null;
  if (typeof entry.id !== 'string'
    || !name.ok
    || name.name !== entry.name
    || playerId === undefined
    || validInteger(entry.score, 0, 100000) === null
    || validDuration(entry.survivalMs) !== entry.survivalMs
    || (entry.threat !== undefined && entry.threat !== null && threat === null)
    || validInteger(entry.achievedAt, 0, Number.MAX_SAFE_INTEGER) === null) return null;
  return { ...entry, threat, playerId };
}

function uniqueLeaderboardEntries(entries: StoredLeaderboardEntry[]): StoredLeaderboardEntry[] {
  const callsigns = new Set<string>();
  const players = new Set<string>();
  return entries.filter((entry) => {
    const callsign = entry.name.toLowerCase();
    if (callsigns.has(callsign) || (entry.playerId !== null && players.has(entry.playerId))) return false;
    callsigns.add(callsign);
    if (entry.playerId !== null) players.add(entry.playerId);
    return true;
  });
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validPlayerId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function publicEntry({ playerId: _playerId, ...entry }: StoredLeaderboardEntry): LeaderboardEntry {
  return entry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
