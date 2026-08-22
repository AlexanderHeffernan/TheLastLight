export interface GameStatus {
  playCount: number;
  lastUpdate: string | null;
}

export interface LeaderboardEntry {
  id: string;
  name: string;
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

export interface ChangelogEntry {
  sha: string;
  message: string;
  url: string;
  date: string | null;
}

interface PendingScore {
  submissionId: string;
  name: string;
  score: number;
  survivalMs: number;
  threat?: number;
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

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  const response = await request<{ entries: LeaderboardEntry[] }>('/api/leaderboard');
  return response.entries;
}

export async function submitScore(
  name: string,
  score: number,
  survivalMs: number,
  threat?: number,
  submissionId: string = crypto.randomUUID(),
): Promise<{ ok: true; entry: LeaderboardEntry }> {
  try {
    return await request('/api/leaderboard', {
      method: 'POST',
      body: JSON.stringify({ name, score, survivalMs, threat, submissionId }),
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
): Promise<LeaderboardResult> {
  const pending = { submissionId: crypto.randomUUID(), name, score, survivalMs: Math.round(survivalMs), threat };
  try {
    const scores = readPendingScores();
    scores.push(pending);
    writePendingScores(scores);
  } catch {
    await submitScore(name, score, survivalMs, threat, pending.submissionId);
    return leaderboardResult(pending.submissionId);
  }
  await flushPendingScores();
  return leaderboardResult(pending.submissionId);
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
      await submitScore(score.name, score.score, score.survivalMs, score.threat, score.submissionId);
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
    return Array.isArray(parsed) ? parsed.filter(isPendingScore) : [];
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
    && typeof score.score === 'number'
    && Number.isInteger(score.score)
    && score.score >= 0
    && score.score <= 100000
    && typeof score.survivalMs === 'number'
    && Number.isInteger(score.survivalMs)
    && score.survivalMs >= 0
    && score.survivalMs <= 24 * 60 * 60 * 1000
    && (score.threat === undefined
      || (Number.isInteger(score.threat) && score.threat >= 1 && score.threat <= 10000));
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

async function leaderboardResult(submissionId: string): Promise<LeaderboardResult> {
  const entries = await getLeaderboard();
  const submittedRank = entries.findIndex((entry) => entry.id === submissionId);
  if (submittedRank >= 0) return { rank: submittedRank + 1, newRecord: true };
  return { rank: null, newRecord: false };
}

export function getChangelog(): Promise<{ repository: string; entries: ChangelogEntry[] }> {
  return request('/api/changelog');
}
