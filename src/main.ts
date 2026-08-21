import type Phaser from 'phaser';
import './style.css';
import { flushPendingScores, queueScore, recordPlay } from './api/client';
import { GAME_HEIGHT, GAME_WIDTH } from './config/constants';
import { gameConfig } from './config/game';
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
    showOrientationNoticeBriefly();
    game ??= new Phaser.Game(gameConfig);
    installMobileRotationSupport(game);
  },
});

window.addEventListener('last-light:game-ready', () => {
  if (launchOptions.mode !== 'duos') return;
  document.querySelector('#home')?.classList.add('hidden');
  document.querySelector('#duo-modal')?.classList.add('hidden');
  document.querySelector('#game-shell')?.classList.remove('hidden');
  window.requestAnimationFrame(() => game?.scale.refresh());
});

function showOrientationNoticeBriefly(): void {
  const orientationNotice = document.querySelector<HTMLElement>('#orientation-notice');
  if (!orientationNotice) return;

  orientationNotice.classList.remove('hidden');
  window.clearTimeout(orientationNoticeTimeout);
  orientationNoticeTimeout = window.setTimeout(() => {
    orientationNotice.classList.add('hidden');
    orientationNoticeTimeout = undefined;
  }, ORIENTATION_NOTICE_DURATION_MS);
}

function isRotatedMobileViewport(): boolean {
  return window.matchMedia('(max-width: 720px) and (orientation: portrait)').matches;
}

function installMobileRotationSupport(activeGame: Phaser.Game): void {
  if (mobileRotationGames.has(activeGame)) return;
  mobileRotationGames.add(activeGame);

  const scale = activeGame.scale;
  const input = activeGame.input;
  const originalGetParentBounds = scale.getParentBounds.bind(scale);
  const originalUpdateCenter = scale.updateCenter.bind(scale);
  const originalTransformPointer = input.transformPointer.bind(input);

  scale.getParentBounds = () => {
    if (!isRotatedMobileViewport()) return originalGetParentBounds();

    const parent = activeGame.canvas?.parentElement;
    if (!parent) return false;

    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (scale.parentSize.width === width && scale.parentSize.height === height) return false;

    scale.parentSize.setSize(width, height);
    return true;
  };

  scale.updateCenter = () => {
    if (!isRotatedMobileViewport() || !activeGame.canvas) {
      originalUpdateCenter();
      return;
    }

    const canvas = activeGame.canvas;
    const offsetX = Math.floor((scale.parentSize.width - canvas.offsetWidth) / 2);
    const offsetY = Math.floor((scale.parentSize.height - canvas.offsetHeight) / 2);
    canvas.style.marginLeft = `${offsetX}px`;
    canvas.style.marginTop = `${offsetY}px`;
  };

  input.transformPointer = (pointer, pageX, pageY, wasMove) => {
    if (!isRotatedMobileViewport() || !activeGame.canvas) {
      originalTransformPointer(pointer, pageX, pageY, wasMove);
      return;
    }

    const rect = activeGame.canvas.getBoundingClientRect();
    const clientX = pageX - window.scrollX;
    const clientY = pageY - window.scrollY;
    const x = ((clientY - rect.top) / rect.height) * GAME_WIDTH;
    const y = ((rect.right - clientX) / rect.width) * GAME_HEIGHT;
    const previous = pointer.position;
    const previousX = previous.x;
    const previousY = previous.y;

    pointer.prevPosition.set(previousX, previousY);
    if (!wasMove || pointer.smoothFactor === 0) {
      previous.set(x, y);
    } else {
      const factor = pointer.smoothFactor;
      previous.set(
        x * factor + previousX * (1 - factor),
        y * factor + previousY * (1 - factor),
      );
    }
  };

  const setInitialParentSize = () => {
    const parent = activeGame.canvas?.parentElement;
    if (!parent) return;
    scale.setParentSize(parent.clientWidth || GAME_WIDTH, parent.clientHeight || GAME_HEIGHT);
  };

  if (activeGame.canvas) {
    setInitialParentSize();
  } else {
    activeGame.events.once('boot', setInitialParentSize);
  }
}

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
