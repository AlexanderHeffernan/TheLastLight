import type { DuoSession } from './duoSession';
import type { DuoPlayerId } from './protocol';
import { DEFAULT_PLAYER_SKIN_ID } from './playerSkins';

export interface SoloLaunchOptions {
  mode: 'solo';
  callsign: string;
  skinId: string;
}

export interface DuoLaunchOptions {
  mode: 'duos';
  role: 'host' | 'guest';
  playerId: DuoPlayerId;
  callsign: string;
  partnerCallsign: string;
  skinId: string;
  partnerSkinId: string;
  session: DuoSession;
}

export type GameLaunchOptions = SoloLaunchOptions | DuoLaunchOptions;

let launchOptions: GameLaunchOptions = { mode: 'solo', callsign: 'SURVIVOR', skinId: DEFAULT_PLAYER_SKIN_ID };

export function setGameLaunchOptions(options: GameLaunchOptions): void {
  launchOptions = options;
}

export function getGameLaunchOptions(): GameLaunchOptions {
  return launchOptions;
}
