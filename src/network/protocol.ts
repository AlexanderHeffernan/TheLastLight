export type DuoPlayerId = 'host' | 'guest';

export interface DuoInput {
  sequence: number;
  moveX: number;
  moveY: number;
  aim: number;
  firing: boolean;
  flare: boolean;
  interact: boolean;
}

export interface PlayerSnapshot {
  id: DuoPlayerId;
  callsign: string;
  skinId: string;
  color: number;
  x: number;
  y: number;
  rotation: number;
  health: number;
  alive: boolean;
  eliminations: number;
  invulnerableUntil: number;
  flareCharges: number;
  lastProcessedInput?: number;
}

export interface ZombieSnapshot {
  id: string;
  textureKey: string;
  type: string;
  x: number;
  y: number;
  rotation: number;
  health: number;
  maxHealth: number;
  scale: number;
  tint: number;
  alpha: number;
  bossKind?: string;
  bossState?: string;
  phase?: number;
}

export interface BulletSnapshot {
  id: string;
  x: number;
  y: number;
  rotation: number;
  ownerId: DuoPlayerId;
  shotSequence?: number;
  speedMultiplier?: number;
}

export type FireControlDropState = 'none' | 'descending' | 'ready';

export interface FireControlSnapshot {
  profileIndex: number;
  progressByPlayer: Partial<Record<DuoPlayerId, number>>;
  requirement: number;
  dropState: FireControlDropState;
}

export type DuoEffectKind = 'bullet-impact' | 'blood-hit' | 'blood' | 'blast' | 'sparks' | 'boss-shockwave';

export type DuoOscillatorType = 'sine' | 'square' | 'sawtooth' | 'triangle';

export type DuoMonsterVoiceEvent = 'spawn' | 'ambient' | 'hurt' | 'attack' | 'death';

export type DuoSoundEffect =
  | {
    kind: 'tone';
    frequency: number;
    duration: number;
    volume: number;
    oscillator: DuoOscillatorType;
    x?: number;
    y?: number;
    ownerId?: DuoPlayerId;
    shotSequence?: number;
  }
  | {
    kind: 'noise';
    duration: number;
    volume: number;
    frequency: number;
    x?: number;
    y?: number;
    ownerId?: DuoPlayerId;
    shotSequence?: number;
  }
  | {
    kind: 'alert';
    x?: number;
    y?: number;
  }
  | {
    kind: 'monster';
    monsterType: string;
    event: DuoMonsterVoiceEvent;
    x: number;
    y: number;
  };

export interface DuoEffectSnapshot {
  id: string;
  kind: DuoEffectKind;
  x: number;
  y: number;
  angle: number;
  radius?: number;
  amount?: number;
  color?: number;
}

export type DuoEventType =
  | 'announcement'
  | 'horde-warning'
  | 'boss-introduction'
  | 'boss-warning'
  | 'zombie-death'
  | 'flare-cartridge'
  | 'flare-collected'
  | 'flare-launch'
  | 'flare-ignite'
  | 'supply-drop'
  | 'supply-ready'
  | 'supply-opened'
  | 'fire-control-drop'
  | 'fire-control-ready'
  | 'fire-control-installed'
  | 'player-hit'
  | 'music-cue'
  | 'sound-effect';

export interface DuoEvent {
  id: string;
  sequence: number;
  tick: number;
  type: DuoEventType;
  payload: Record<string, unknown>;
}

export interface PropSnapshot {
  id: string;
  kind: string;
  x: number;
  y: number;
  rotation: number;
  health: number;
  maxHealth: number;
  active: boolean;
  textureKey: string;
}

export interface SupplySnapshot {
  state: 'waiting' | 'descending' | 'ready' | 'opened';
  cache?: {
    x: number;
    y: number;
    textureKey: string;
  };
  pickup?: {
    kind: string;
    x: number;
    y: number;
  };
}

export interface FlareSnapshot {
  x: number;
  y: number;
  intensity: number;
}

export interface DuoSnapshot {
  tick: number;
  elapsedMs: number;
  score: number;
  wave: number;
  waitingForPartner: boolean;
  paused: boolean;
  players: PlayerSnapshot[];
  zombies: ZombieSnapshot[];
  bullets: BulletSnapshot[];
  effects: DuoEffectSnapshot[];
  props: PropSnapshot[];
  generatorOnline: boolean;
  generatorUnstable: boolean;
  supplyStatus: string;
  supply: SupplySnapshot;
  fireControl: FireControlSnapshot;
  flare?: FlareSnapshot;
}

export interface DuoLobbyState {
  roomCode: string;
  hostCallsign: string;
  guestCallsign: string;
  hostSkinId: string;
  guestSkinId: string;
  hostSkinIds: string[];
  guestSkinIds: string[];
  hostAim: number;
  guestAim: number;
  guestConnected: boolean;
  started: boolean;
}
