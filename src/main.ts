import type Phaser from 'phaser';
import './style.css';
import { flushPendingScores, queueScore, recordPlay } from './api/client';
import { setGameLaunchOptions, type GameLaunchOptions } from './network/gameLaunch';
import { DEFAULT_PLAYER_SKIN_ID } from './network/playerSkins';
import { HomeScreen } from './ui/HomeScreen';

let game: Phaser.Game | undefined;
let launchOptions: GameLaunchOptions = { mode: 'solo', callsign: 'SURVIVOR', skinId: DEFAULT_PLAYER_SKIN_ID };

const homeScreen = new HomeScreen({
  onDeploy: async (options) => {
    const [{ default: Phaser }, { gameConfig }] = await Promise.all([
      import('phaser'),
      import('./config/game'),
    ]);
    launchOptions = options;
    setGameLaunchOptions(options);
    if (options.mode === 'solo') {
      document.querySelector('#home')?.classList.add('hidden');
      document.querySelector('#game-shell')?.classList.remove('hidden');
    } else {
      // Keep the game parent laid out while the duo deployment lobby remains
      // visible. Phaser's FIT scale cannot measure a display:none parent.
      document.querySelector('#game-shell')?.classList.remove('hidden');
    }
    game ??= new Phaser.Game(gameConfig);
  },
});

window.addEventListener('last-light:game-ready', () => {
  if (launchOptions.mode !== 'duos') return;
  document.querySelector('#home')?.classList.add('hidden');
  document.querySelector('#duo-modal')?.classList.add('hidden');
  document.querySelector('#game-shell')?.classList.remove('hidden');
  window.requestAnimationFrame(() => game?.scale.refresh());
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
    mode?: 'solo' | 'duos';
    players?: string[];
    host?: boolean;
    disconnection?: boolean;
  }>).detail;
  const mode = result.mode ?? launchOptions.mode;
  if (mode === 'duos') {
    if (launchOptions.mode !== 'duos' || launchOptions.role !== 'host') return;
    const players = result.players?.length === 2
      ? result.players
      : [launchOptions.callsign, launchOptions.partnerCallsign];
    const session = launchOptions.session;
    const authorization = session.getLeaderboardAuthorization();
    void queueScore(
      players.join(' + '),
      result.score,
      result.survivalMs,
      result.threat,
      'duos',
      players,
      authorization,
    )
      .then((leaderboard) => {
        const detail = { ...leaderboard, available: true };
        session.sendLeaderboardResult(detail);
        window.dispatchEvent(new CustomEvent('last-light:leaderboard-result', {
          detail: { runId: result.runId, ...detail },
        }));
      })
      .catch(() => {
        const detail = { rank: null, newRecord: false, available: false };
        session.sendLeaderboardResult(detail);
        window.dispatchEvent(new CustomEvent('last-light:leaderboard-result', {
          detail: { runId: result.runId, ...detail },
        }));
      });
    return;
  }
  if (launchOptions.mode !== 'solo') return;
  void queueScore(launchOptions.callsign, result.score, result.survivalMs, result.threat)
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
    if (launchOptions.mode === 'duos') launchOptions.session.close();
    game?.destroy(true);
    game = undefined;
    document.querySelector('#game-shell')?.classList.add('hidden');
    document.querySelector('#home')?.classList.remove('hidden');
    homeScreen.show();
  }, 0);
});
