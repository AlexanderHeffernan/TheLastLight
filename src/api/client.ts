export interface GameStatus {
  playCount: number;
  lastUpdate: string | null;
}

export type LeaderboardMode = 'solo' | 'duos';

export interface LeaderboardEntry {
  id: string;
  name: string;
  mode: LeaderboardMode;
  players: string[];
  score: number;
  survivalMs: number;
  threat: number | null;
  achievedAt: number;
  isCurrentPlayer: boolean;
}

export interface LeaderboardResult {
  rank: number | null;
  newRecord: boolean;
}

export interface DuoScoreAuthorization {
  roomCode: string;
  hostToken: string;
}

export interface ChangelogEntry {
  sha: string;
  message: string;
  url: string;
  date: string | null;
}

interface PendingScore {
  submissionId: string;
  name: string;
  mode: LeaderboardMode;
  players: string[];
  score: number;
  survivalMs: number;
  threat?: number;
  duoAuthorization?: DuoScoreAuthorization;
}

const PENDING_SCORES_KEY = 'the-last-light-pending-scores';
let flushPromise: Promise<void> | undefined;

class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class CallsignUnavailableError extends Error {}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options?.headers },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiRequestError(response.status, body.error ?? `Request failed (${response.status})`);
  return body;
}

export function getStatus(): Promise<GameStatus> {
  return request('/api/status');
}

export function recordPlay(): Promise<GameStatus> {
  return request('/api/plays', { method: 'POST', body: '{}' });
}

export async function claimPlayerName(name: string): Promise<string> {
  try {
    const response = await request<{ ok: true; name: string }>('/api/player', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return response.name;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      throw new CallsignUnavailableError(error.message);
    }
    throw error;
  }
}

export async function checkPlayerName(name: string): Promise<string> {
  try {
    const response = await request<{ ok: true; name: string }>(
      `/api/player?name=${encodeURIComponent(name)}`,
    );
    return response.name;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      throw new CallsignUnavailableError(error.message);
    }
    throw error;
  }
}

export async function getLeaderboard(mode: LeaderboardMode = 'solo'): Promise<LeaderboardEntry[]> {
  const response = await request<{ entries: LeaderboardEntry[] }>(`/api/leaderboard?mode=${mode}`);
  return response.entries;
}

export async function submitScore(
  name: string,
  score: number,
  survivalMs: number,
  threat?: number,
  submissionId: string = crypto.randomUUID(),
  mode: LeaderboardMode = 'solo',
  players: string[] = [name],
  duoAuthorization?: DuoScoreAuthorization,
): Promise<{ ok: true; entry: LeaderboardEntry }> {
  try {
    return await request('/api/leaderboard', {
      method: 'POST',
      headers: duoAuthorization
        ? {
          'x-duo-room-code': duoAuthorization.roomCode,
          'x-duo-host-token': duoAuthorization.hostToken,
        }
        : undefined,
      body: JSON.stringify({ name, score, survivalMs, threat, submissionId, mode, players }),
      keepalive: true,
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      throw new CallsignUnavailableError(error.message);
    }
    throw error;
  }
}

export async function queueScore(
  name: string,
  score: number,
  survivalMs: number,
  threat: number,
  mode: LeaderboardMode = 'solo',
  players: string[] = [name],
  duoAuthorization?: DuoScoreAuthorization,
): Promise<LeaderboardResult> {
  const pending = {
    submissionId: crypto.randomUUID(),
    name,
    mode,
    players,
    score,
    survivalMs: Math.round(survivalMs),
    threat,
    duoAuthorization,
  };
  try {
    const scores = readPendingScores();
    scores.push(pending);
    writePendingScores(scores);
  } catch {
    await submitScore(name, score, survivalMs, threat, pending.submissionId, mode, players, duoAuthorization);
    return leaderboardResult(pending.submissionId, mode);
  }
  await flushPendingScores();
  return leaderboardResult(pending.submissionId, mode);
}

export function flushPendingScores(): Promise<void> {
  flushPromise ??= flushScores().finally(() => {
    flushPromise = undefined;
  });
  return flushPromise;
}

async function flushScores(): Promise<void> {
  while (true) {
    const score = readPendingScores()[0];
    if (!score) return;
    try {
      await submitScore(
        score.name,
        score.score,
        score.survivalMs,
        score.threat,
        score.submissionId,
        score.mode,
        score.players,
        score.duoAuthorization,
      );
    } catch (error) {
      if (!(error instanceof CallsignUnavailableError)) throw error;
    }
    removePendingScore(score);
  }
}

function readPendingScores(): PendingScore[] {
  const stored = localStorage.getItem(PENDING_SCORES_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.map(normalizePendingScore).filter((score): score is PendingScore => score !== null)
      : [];
  } catch {
    localStorage.removeItem(PENDING_SCORES_KEY);
    return [];
  }
}

function writePendingScores(scores: PendingScore[]): void {
  if (scores.length) localStorage.setItem(PENDING_SCORES_KEY, JSON.stringify(scores));
  else localStorage.removeItem(PENDING_SCORES_KEY);
}

function isPendingScore(value: unknown): value is PendingScore {
  if (!value || typeof value !== 'object') return false;
  const score = value as PendingScore;
  return typeof score.submissionId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(score.submissionId)
    && typeof score.name === 'string'
    && (score.mode === 'solo' || score.mode === 'duos')
    && Array.isArray(score.players)
    && score.players.length >= 1
    && score.players.length <= 2
    && score.players.every((player) => typeof player === 'string')
    && typeof score.score === 'number'
    && Number.isInteger(score.score)
    && score.score >= 0
    && score.score <= 100000
    && typeof score.survivalMs === 'number'
    && Number.isInteger(score.survivalMs)
    && score.survivalMs >= 0
    && score.survivalMs <= 24 * 60 * 60 * 1000
    && (score.duoAuthorization === undefined
      ? score.mode === 'solo'
      : typeof score.duoAuthorization.roomCode === 'string'
        && /^[A-Z0-9]{6}$/.test(score.duoAuthorization.roomCode)
        && typeof score.duoAuthorization.hostToken === 'string'
        && /^[0-9a-f-]{36}$/i.test(score.duoAuthorization.hostToken))
    && (score.threat === undefined
      || (Number.isInteger(score.threat) && score.threat >= 1 && score.threat <= 10000));
}

function normalizePendingScore(value: unknown): PendingScore | null {
  if (isPendingScore(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const legacy = value as Omit<PendingScore, 'mode' | 'players'>;
  if (typeof legacy.name !== 'string') return null;
  const normalized = { ...legacy, mode: 'solo' as const, players: [legacy.name] };
  return isPendingScore(normalized) ? normalized : null;
}

function sameScore(left: PendingScore, right: PendingScore): boolean {
  return left.submissionId === right.submissionId;
}

function removePendingScore(score: PendingScore): void {
  const scores = readPendingScores();
  const submitted = scores.findIndex((entry) => sameScore(entry, score));
  if (submitted < 0) return;
  scores.splice(submitted, 1);
  writePendingScores(scores);
}

async function leaderboardResult(submissionId: string, mode: LeaderboardMode): Promise<LeaderboardResult> {
  const entries = await getLeaderboard(mode);
  const submittedRank = entries.findIndex((entry) => entry.id === submissionId);
  if (submittedRank >= 0) return { rank: submittedRank + 1, newRecord: true };
  return { rank: null, newRecord: false };
}

export function getChangelog(): Promise<{ repository: string; entries: ChangelogEntry[] }> {
  return request('/api/changelog');
}
