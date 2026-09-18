import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validatePlayerName } from '../src/shared/nameValidator.js';

export interface LeaderboardEntry {
  id: string;
  name: string;
  mode: LeaderboardMode;
  players: string[];
  score: number;
  survivalMs: number;
  threat: number | null;
  achievedAt: number;
}

export type LeaderboardMode = 'solo' | 'duos';

export interface PlayerLeaderboardEntry extends LeaderboardEntry {
  isCurrentPlayer: boolean;
}

interface StoredLeaderboardEntry extends LeaderboardEntry {
  playerId: string | null;
}

interface GameData {
  playCount: number;
  leaderboard: StoredLeaderboardEntry[];
  callsignClaims: Record<string, string>;
}

export type NameClaimResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'invalid' | 'name-taken' | 'capacity'; message: string };

export type ScoreSubmissionResult =
  | { ok: true; entry: LeaderboardEntry }
  | { ok: false; reason: 'invalid' | 'name-taken' | 'capacity' };

const EMPTY_DATA: GameData = { playCount: 0, leaderboard: [], callsignClaims: Object.create(null) };
const LEADERBOARD_LIMIT = 10;
const MAX_CALLSIGN_CLAIMS = 100_000;

export class GameStore {
  private data: GameData = structuredClone(EMPTY_DATA);
  private writeQueue: Promise<void> = Promise.resolve();
  private saveRequested = false;
  private saveRunning = false;

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
          : [],
        callsignClaims: normalizeCallsignClaims(parsed.callsignClaims),
      };
      this.data.leaderboard = limitLeaderboardByMode(this.data.leaderboard);
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

  entries(playerId: string, mode: LeaderboardMode = 'solo'): PlayerLeaderboardEntry[] {
    return this.data.leaderboard
      .filter((entry) => entry.mode === mode)
      .map(({ playerId: ownerId, ...entry }) => ({
      ...entry,
      isCurrentPlayer: ownerId === playerId,
      }));
  }

  duoCallsignsOwned(playersValue: unknown, hostPlayerId: string, guestPlayerId: string): boolean {
    if (!validPlayerId(hostPlayerId) || !validPlayerId(guestPlayerId)
      || !Array.isArray(playersValue) || playersValue.length !== 2) return false;
    const players = playersValue.map((player) => validatePlayerName(player));
    if (players.some((player) => !player.ok)) return false;
    const names = players.map((player) => player.ok ? player.name : '');
    if (sameName(names[0], names[1])) return false;
    return (this.ownsCallsign(names[0], hostPlayerId) && this.ownsCallsign(names[1], guestPlayerId))
      || (this.ownsCallsign(names[0], guestPlayerId) && this.ownsCallsign(names[1], hostPlayerId));
  }

  private ownsCallsign(name: string, playerId: string): boolean {
    const claim = this.data.callsignClaims[callsignKey(name)];
    if (claim) return claim === playerId;
    return this.data.leaderboard.some((entry) => (
      entry.mode === 'solo' && sameName(entry.name, name) && entry.playerId === playerId
    ));
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

    const matchingName = this.data.leaderboard.find((entry) => (
      entry.mode === 'solo' && sameName(entry.name, nameResult.name)
    ));
    const claimKey = callsignKey(nameResult.name);
    const claimedBy = this.data.callsignClaims[claimKey] ?? matchingName?.playerId ?? null;
    if (claimedBy && claimedBy !== playerId) {
      return { ok: false, reason: 'name-taken', message: 'Callsign already in use.' };
    }
    if (!Object.prototype.hasOwnProperty.call(this.data.callsignClaims, claimKey)
      && !matchingName
      && Object.keys(this.data.callsignClaims).length >= MAX_CALLSIGN_CLAIMS) {
      return { ok: false, reason: 'capacity', message: 'The callsign registry is temporarily full.' };
    }

    let changed = this.data.callsignClaims[claimKey] !== playerId;
    this.data.callsignClaims[claimKey] = playerId;
    if (matchingName) {
      if (matchingName.name !== nameResult.name || matchingName.playerId !== playerId) {
        matchingName.name = nameResult.name;
        matchingName.playerId = playerId;
        changed = true;
      }
    }
    if (changed) await this.queueSave();

    return { ok: true, name: nameResult.name };
  }

  async submit(
    playerId: string,
    name: unknown,
    score: unknown,
    survivalMs: unknown,
    threat: unknown,
    submissionId?: unknown,
    modeValue?: unknown,
    playersValue?: unknown,
  ): Promise<ScoreSubmissionResult> {
    const nameResult = validatePlayerName(name);
    const mode = validMode(modeValue);
    const players = normalizePlayers(mode, playersValue, nameResult);
    const normalizedScore = validInteger(score, 0, 100000);
    const normalizedSurvival = validDuration(survivalMs);
    const normalizedThreat = threat === undefined || threat === null ? null : validInteger(threat, 1, 10000);
    const entryId = submissionId === undefined ? randomUUID() : validSubmissionId(submissionId);
    if (!validPlayerId(playerId)
      || !mode
      || !players
      || (mode === 'solo' && !nameResult.ok)
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

    if (mode === 'solo') {
      if (!nameResult.ok) return { ok: false, reason: 'invalid' };
      const claim = await this.claimName(nameResult.name, playerId);
      if (!claim.ok) return { ok: false, reason: claim.reason };
    }

    const displayName = mode === 'duos' ? players.join(' + ') : players[0];

    const entry: StoredLeaderboardEntry = {
      id: entryId,
      name: displayName,
      mode,
      players,
      score: normalizedScore,
      survivalMs: normalizedSurvival,
      threat: normalizedThreat,
      achievedAt: Date.now(),
      playerId,
    };
    const previousBest = this.data.leaderboard.find((candidate) => mode === 'solo'
      ? candidate.mode === 'solo'
        && candidate.playerId === playerId
        && sameName(candidate.name, displayName)
      : candidate.mode === 'duos' && sameTeam(candidate.players, players));
    if (previousBest && compareScores(entry, previousBest) >= 0) {
      return { ok: true, entry: publicEntry(previousBest) };
    }
    if (previousBest) {
      this.data.leaderboard = this.data.leaderboard.filter((candidate) => candidate !== previousBest);
    }
    this.data.leaderboard.push(entry);
    this.data.leaderboard.sort(compareScores);
    this.data.leaderboard = limitLeaderboardByMode(this.data.leaderboard);
    await this.queueSave();
    return { ok: true, entry: publicEntry(entry) };
  }

  async flush(): Promise<void> {
    while (this.saveRunning || this.saveRequested) await this.writeQueue;
    await this.writeQueue;
  }

  private queueSave(): Promise<void> {
    this.saveRequested = true;
    if (!this.saveRunning) {
      this.saveRunning = true;
      this.writeQueue = this.writeQueue.then(async () => {
        while (this.saveRequested) {
          this.saveRequested = false;
          const snapshot = `${JSON.stringify(this.data, null, 2)}\n`;
          await mkdir(dirname(this.path), { recursive: true });
          const temporaryPath = `${this.path}.${process.pid}.tmp`;
          await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
          await chmod(temporaryPath, 0o600);
          await rename(temporaryPath, this.path);
        }
      }).catch((error: unknown) => {
        this.saveRequested = false;
        console.error(`Could not persist game data: ${errorMessage(error)}`);
      }).finally(() => {
        this.saveRunning = false;
        if (this.saveRequested) this.queueSave();
      });
    }
    return this.writeQueue;
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

function normalizeCallsignClaims(value: unknown): Record<string, string> {
  const claims: Record<string, string> = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return claims;
  let count = 0;
  for (const [name, playerId] of Object.entries(value as Record<string, unknown>)) {
    const nameResult = validatePlayerName(name);
    if (!nameResult.ok || !validPlayerId(playerId)) continue;
    claims[callsignKey(nameResult.name)] = playerId;
    count += 1;
    if (count >= MAX_CALLSIGN_CLAIMS) break;
  }
  return claims;
}

function callsignKey(name: string): string {
  return name.toLowerCase();
}

function normalizeLeaderboardEntry(value: unknown): StoredLeaderboardEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as LeaderboardEntry;
  const mode = validMode(entry.mode) ?? 'solo';
  const players = normalizeStoredPlayers(mode, entry);
  const name = mode === 'solo' ? validatePlayerName(entry.name) : { ok: !!players, name: '' };
  const threat = entry.threat === undefined || entry.threat === null
    ? null
    : validInteger(entry.threat, 1, 10000);
  const playerId = 'playerId' in entry && entry.playerId !== undefined && entry.playerId !== null
    ? validPlayerId(entry.playerId) ? entry.playerId : undefined
    : null;
  if (typeof entry.id !== 'string'
    || !name.ok
    || (mode === 'solo' && name.name !== entry.name)
    || !players
    || playerId === undefined
    || validInteger(entry.score, 0, 100000) === null
    || validDuration(entry.survivalMs) !== entry.survivalMs
    || (entry.threat !== undefined && entry.threat !== null && threat === null)
    || validInteger(entry.achievedAt, 0, Number.MAX_SAFE_INTEGER) === null) return null;
  return {
    ...entry,
    name: mode === 'duos' ? players.join(' + ') : entry.name,
    mode,
    players,
    threat,
    playerId,
  };
}

function uniqueLeaderboardEntries(entries: StoredLeaderboardEntry[]): StoredLeaderboardEntry[] {
  const callsigns = new Set<string>();
  return entries.filter((entry) => {
    const callsign = `${entry.mode}:${entry.mode === 'duos' ? teamKey(entry.players) : entry.name.toLowerCase()}`;
    if (callsigns.has(callsign)) return false;
    callsigns.add(callsign);
    return true;
  });
}

function limitLeaderboardByMode(entries: StoredLeaderboardEntry[]): StoredLeaderboardEntry[] {
  return (['solo', 'duos'] as LeaderboardMode[]).flatMap((mode) => entries
    .filter((entry) => entry.mode === mode)
    .sort(compareScores)
    .slice(0, LEADERBOARD_LIMIT));
}

function validMode(value: unknown): LeaderboardMode | null {
  return value === 'solo' || value === 'duos' ? value : null;
}

function normalizePlayers(
  mode: LeaderboardMode | null,
  value: unknown,
  nameResult: ReturnType<typeof validatePlayerName>,
): string[] | null {
  if (!mode) return null;
  if (mode === 'solo') return nameResult.ok ? [nameResult.name] : null;
  if (!Array.isArray(value) || value.length !== 2) return null;
  const players = value.map((player) => validatePlayerName(player));
  return players.every((player) => player.ok)
    ? players.map((player) => player.name)
    : null;
}

function normalizeStoredPlayers(mode: LeaderboardMode, entry: LeaderboardEntry): string[] | null {
  if (mode === 'solo') return validatePlayerName(entry.name).ok ? [entry.name] : null;
  if (!Array.isArray(entry.players) || entry.players.length !== 2) return null;
  const players = entry.players.map((player) => validatePlayerName(player));
  return players.every((player) => player.ok) ? players.map((player) => player.name) : null;
}

function sameTeam(left: string[], right: string[]): boolean {
  return teamKey(left) === teamKey(right);
}

function teamKey(players: string[]): string {
  return players.map((player) => player.toLowerCase()).sort().join('|');
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
