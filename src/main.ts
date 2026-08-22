import Phaser from 'phaser';
import './style.css';
import { flushPendingScores, queueScore, recordPlay } from './api/client';
import { gameConfig } from './config/game';
import { HomeScreen } from './ui/HomeScreen';

let game: Phaser.Game | undefined;
let callsign = 'SURVIVOR';

const homeScreen = new HomeScreen({
  onDeploy: (name) => {
    callsign = name;
    document.querySelector('#home')?.classList.add('hidden');
    document.querySelector('#game-shell')?.classList.remove('hidden');
    game ??= new Phaser.Game(gameConfig);
  },
});

window.addEventListener('last-light:run-start', () => {
  void recordPlay().catch(() => undefined);
});

window.addEventListener('last-light:game-over', (event) => {
  const result = (event as CustomEvent<{
    score: number;
    survivalMs: number;
    threat: number;
    runId: string;
  }>).detail;
  void queueScore(callsign, result.score, result.survivalMs, result.threat)
    .then((leaderboard) => window.dispatchEvent(new CustomEvent('last-light:leaderboard-result', {
      detail: { runId: result.runId, ...leaderboard, available: true },
    })))
    .catch(() => window.dispatchEvent(new CustomEvent('last-light:leaderboard-result', {
      detail: { runId: result.runId, rank: null, newRecord: false, available: false },
    })));
});

window.addEventListener('online', () => void flushPendingScores().catch(() => undefined));
void flushPendingScores().catch(() => undefined);

window.addEventListener('last-light:return-menu', () => {
  // Let Phaser finish dispatching the button event before tearing down its input system.
  window.setTimeout(() => {
    game?.destroy(true);
    game = undefined;
    document.querySelector('#game-shell')?.classList.add('hidden');
    document.querySelector('#home')?.classList.remove('hidden');
    homeScreen.show();
  }, 0);
});
