import type Phaser from 'phaser';
import './style.css';
import { flushPendingScores, queueScore, recordPlay } from './api/client';
import flareButtonIconUrl from './assets/ui/flare_button_64.png';
import openButtonIconUrl from './assets/ui/open_button_64.png';
import pauseButtonIconUrl from './assets/ui/pause_button_32.png';
import { GAME_HEIGHT, GAME_WIDTH } from './config/constants';
import { hasTouchControls } from './config/controls';
import { setGameLaunchOptions, type GameLaunchOptions } from './network/gameLaunch';
import { DEFAULT_PLAYER_SKIN_ID } from './network/playerSkins';
import { HomeScreen } from './ui/HomeScreen';

let game: Phaser.Game | undefined;
let launchOptions: GameLaunchOptions = { mode: 'solo', callsign: 'SURVIVOR', skinId: DEFAULT_PLAYER_SKIN_ID };
const mobileRotationGames = new WeakSet<Phaser.Game>();
let orientationNoticeTimeout: number | undefined;
let viewportRefreshFrame: number | undefined;
let removeMobileControls: (() => void) | undefined;

const ORIENTATION_NOTICE_DURATION_MS = 2_000;

function refreshGameViewport(): void {
  const viewport = window.visualViewport;
  const shell = document.querySelector<HTMLElement>('#game-shell');
  if (shell && viewport) {
    shell.style.setProperty('--visual-viewport-width', `${viewport.width}px`);
    shell.style.setProperty('--visual-viewport-height', `${viewport.height}px`);
    shell.style.left = `${viewport.offsetLeft}px`;
    shell.style.top = `${viewport.offsetTop}px`;
    shell.style.width = `${viewport.width}px`;
    shell.style.height = `${viewport.height}px`;
  }
  syncMobileOrientation();
  if (viewportRefreshFrame !== undefined) window.cancelAnimationFrame(viewportRefreshFrame);
  viewportRefreshFrame = window.requestAnimationFrame(() => {
    viewportRefreshFrame = window.requestAnimationFrame(() => {
      viewportRefreshFrame = undefined;
      if (!game) return;
      game.scale.refresh();
      game.scale.updateBounds();
    });
  });
}

window.addEventListener('resize', refreshGameViewport);
window.addEventListener('orientationchange', refreshGameViewport);
window.visualViewport?.addEventListener('resize', refreshGameViewport);
syncMobileOrientation();

const MOBILE_CONTROL_ASSETS = {
  pause: pauseButtonIconUrl,
  flare: flareButtonIconUrl,
  interact: openButtonIconUrl,
} as const;

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
    requestLandscapeLock();
    removeMobileControls ??= installMobileControls();
    game ??= new Phaser.Game(gameConfig);
    installMobileRotationSupport(game);
    refreshGameViewport();
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
    if (!isRotatedMobileViewport()) orientationNotice.classList.add('hidden');
    orientationNoticeTimeout = undefined;
  }, ORIENTATION_NOTICE_DURATION_MS);
}

function syncMobileOrientation(): void {
  const portrait = isRotatedMobileViewport();
  document.querySelector<HTMLElement>('#orientation-notice')?.classList.toggle('hidden', !portrait);
  if (!game) return;
  window.dispatchEvent(new CustomEvent('last-light:mobile-orientation', {
    detail: { portrait },
  }));
}

function requestLandscapeLock(): void {
  if (!hasTouchControls() || typeof screen === 'undefined' || !screen.orientation) return;
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (requestedOrientation: 'landscape') => Promise<void>;
  };
  if (typeof orientation.lock !== 'function') return;
  try {
    void orientation.lock('landscape').catch(() => undefined);
  } catch {
    // Orientation locking is optional; the portrait notice remains the fallback.
  }
}

function installMobileControls(): () => void {
  const root = document.querySelector<HTMLElement>('#mobile-controls');
  if (!root) return () => undefined;

  const abort = new AbortController();
  const emit = (detail: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent('last-light:mobile-control', { detail }));
  };

  root.querySelectorAll<HTMLImageElement>('[data-mobile-icon]').forEach((image) => {
    const kind = image.dataset.mobileIcon as keyof typeof MOBILE_CONTROL_ASSETS;
    image.src = MOBILE_CONTROL_ASSETS[kind];
  });

  const sticks = new Map(Array.from(root.querySelectorAll<HTMLElement>('[data-mobile-stick]'))
    .map((stick) => [stick.dataset.mobileStick!, stick]));
  const pointers = new Map<string, { id: number; x: number; y: number }>();
  const update = (kind: string, event: PointerEvent) => {
    const stick = sticks.get(kind);
    const thumb = stick?.querySelector<HTMLElement>('.mobile-stick-thumb');
    const pointer = pointers.get(kind);
    if (!stick || !thumb || !pointer) return;
    const radius = stick.getBoundingClientRect().width / 2;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    const distance = Math.hypot(dx, dy);
    const scale = distance > radius ? radius / distance : 1;
    const x = (dx * scale) / radius;
    const y = (dy * scale) / radius;
    thumb.style.transform = `translate(calc(-50% + ${dx * scale}px), calc(-50% + ${dy * scale}px))`;
    emit({ kind, x, y, active: true });
  };
  root.addEventListener('pointerdown', (event) => {
    if ((event.target as Element).closest('[data-mobile-action]')) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    const kind = event.clientX < rect.left + rect.width / 2 ? 'move' : 'aim';
    if (pointers.has(kind)) return;
    const stick = sticks.get(kind);
    if (!stick) return;
    const radius = stick.offsetWidth / 2;
    const x = Math.min(rect.right - radius - 10, Math.max(rect.left + radius + 10, event.clientX));
    const y = Math.min(rect.bottom - radius - 10, Math.max(rect.top + radius + 10, event.clientY));
    pointers.set(kind, { id: event.pointerId, x: event.clientX, y: event.clientY });
    stick.style.left = `${x - rect.left - radius}px`;
    stick.style.top = `${y - rect.top - radius}px`;
    stick.style.right = 'auto';
    stick.style.bottom = 'auto';
    update(kind, event);
    root.setPointerCapture(event.pointerId);
  }, { signal: abort.signal });
  root.addEventListener('pointermove', (event) => {
    const entry = Array.from(pointers).find(([, pointer]) => pointer.id === event.pointerId);
    if (entry) update(entry[0], event);
  }, { signal: abort.signal });
  const release = (event: PointerEvent) => {
    const entry = Array.from(pointers).find(([, pointer]) => pointer.id === event.pointerId);
    if (!entry) return;
    const [kind] = entry;
    const stick = sticks.get(kind);
    const thumb = stick?.querySelector<HTMLElement>('.mobile-stick-thumb');
    pointers.delete(kind);
    if (thumb) thumb.style.transform = 'translate(-50%, -50%)';
    if (stick) {
      stick.style.removeProperty('left');
      stick.style.removeProperty('top');
      stick.style.removeProperty('right');
      stick.style.removeProperty('bottom');
    }
    emit({ kind, x: 0, y: 0, active: false });
  };
  root.addEventListener('pointerup', release, { signal: abort.signal });
  root.addEventListener('pointercancel', release, { signal: abort.signal });
  root.addEventListener('lostpointercapture', release, { signal: abort.signal });

  root.querySelectorAll<HTMLButtonElement>('[data-mobile-action]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      emit({ kind: 'action', action: button.dataset.mobileAction });
    }, { signal: abort.signal });
  });

  const availability = (event: Event) => {
    const detail = (event as CustomEvent<{ flare: boolean; interact: boolean }>).detail;
    root.querySelector<HTMLButtonElement>('[data-mobile-action="flare"]')!.disabled = !detail.flare;
    root.querySelector<HTMLButtonElement>('[data-mobile-action="interact"]')!.disabled = !detail.interact;
  };
  const visibility = (event: Event) => {
    const { visible } = (event as CustomEvent<{ visible: boolean }>).detail;
    root.toggleAttribute('hidden', !visible);
  };
  window.addEventListener('last-light:mobile-availability', availability, { signal: abort.signal });
  window.addEventListener('last-light:mobile-visibility', visibility, { signal: abort.signal });
  root.removeAttribute('hidden');

  return () => abort.abort();
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
    removeMobileControls?.();
    removeMobileControls = undefined;
    syncMobileOrientation();
    document.querySelector('#game-shell')?.classList.add('hidden');
    document.querySelector('#home')?.classList.remove('hidden');
    homeScreen.show();
  }, 0);
});
