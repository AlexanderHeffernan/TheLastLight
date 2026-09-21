import Phaser from 'phaser';
import { loadAssets } from '../assets/manifest';
import {
  BULLET_SPEED,
  GAME_HEIGHT as HEIGHT,
  GAME_WIDTH as WIDTH,
  GENERATOR_POSITION,
  PLAYER_SPEED,
  SOUTH_FACING_OFFSET as SOUTH_OFFSET,
} from '../config/constants';
import { hasTouchControls, isMobilePortraitViewport } from '../config/controls';
import { AudioSystem, type MusicCue } from '../systems/AudioSystem';
import { FlareSystem } from '../systems/FlareSystem';
import { LightingSystem, type PlayerLight, type ShadowCaster } from '../systems/LightingSystem';
import { MonsterAudioSystem, type MonsterType } from '../systems/MonsterAudioSystem';
import { SupplySystem } from '../systems/SupplySystem';
import { WaveDirector, type BossKind } from '../systems/WaveDirector';
import { getGameLaunchOptions, type DuoLaunchOptions } from '../network/gameLaunch';
import { getPlayerSkin } from '../network/playerSkins';
import type {
  BulletSnapshot,
  DuoEvent,
  DuoEventType,
  DuoInput,
  DuoEffectSnapshot,
  DuoPlayerId,
  DuoSnapshot,
  PlayerSnapshot,
  PropSnapshot,
  SupplySnapshot,
  ZombieSnapshot,
} from '../network/protocol';

interface Controls {
  up: Phaser.Input.Keyboard.Key;
  down: Phaser.Input.Keyboard.Key;
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
  upAlt: Phaser.Input.Keyboard.Key;
  downAlt: Phaser.Input.Keyboard.Key;
  leftAlt: Phaser.Input.Keyboard.Key;
  rightAlt: Phaser.Input.Keyboard.Key;
  pause: Phaser.Input.Keyboard.Key;
  pauseAlt: Phaser.Input.Keyboard.Key;
  flare?: Phaser.Input.Keyboard.Key;
  interact?: Phaser.Input.Keyboard.Key;
  debug?: Phaser.Input.Keyboard.Key;
  spawnBreaker?: Phaser.Input.Keyboard.Key;
  spawnLurker?: Phaser.Input.Keyboard.Key;
  spawnFurnace?: Phaser.Input.Keyboard.Key;
  spawnSpitter?: Phaser.Input.Keyboard.Key;
}

interface TouchVector {
  x: number;
  y: number;
}

const MOBILE_TOUCH_HINT_Y = HEIGHT - 150;
const AIM_FIRE_DEAD_ZONE = 0.7;
const PLAYER_SPRITE_SIZE = 64;
const PLAYER_COLLISION_RADIUS = 12;
const PLAYER_COLLISION_OFFSET_X = 20;
const PLAYER_COLLISION_OFFSET_Y = 9;
const PLAYER_PIVOT_X = (PLAYER_COLLISION_OFFSET_X + PLAYER_COLLISION_RADIUS) / PLAYER_SPRITE_SIZE;
const PLAYER_PIVOT_Y = (PLAYER_COLLISION_OFFSET_Y + PLAYER_COLLISION_RADIUS) / PLAYER_SPRITE_SIZE;
const PLAYER_SHOT_RECOIL_DISTANCE = 1.4;
const ENEMY_FACING_EPSILON = 0.5;

interface TreeLayers {
  x: number;
  y: number;
  canopy: Phaser.GameObjects.Image;
  canopyShadow: Phaser.GameObjects.Image;
}

interface BarrelSlot {
  x: number;
  y: number;
  occupied: boolean;
  incoming: boolean;
}

interface BossDefinition {
  name: string;
  texture: string;
  health: number;
  speed: number;
  radius: number;
  shadowWidth: number;
  shadowHeight: number;
  color: number;
  enragedColor: number;
  voice: MonsterType;
}

interface BossHazard {
  pool: Phaser.GameObjects.Sprite;
  glow: Phaser.GameObjects.Image;
  expiresAt: number;
  nextDamageAt: number;
  radiusX: number;
  radiusY: number;
}

interface PlayerActor {
  id: DuoPlayerId;
  callsign: string;
  skinId: string;
  color: number;
  sprite: Phaser.Physics.Arcade.Sprite;
  shadow: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  ring?: Phaser.GameObjects.Arc;
  nameLabel?: Phaser.GameObjects.Text;
  youLabel?: Phaser.GameObjects.Text;
  healthBack?: Phaser.GameObjects.Rectangle;
  healthBar?: Phaser.GameObjects.Rectangle;
  health: number;
  alive: boolean;
  aim: number;
  flareCharges: number;
  knockbackUntil: number;
  knockbackDuration: number;
  knockbackVelocity: Phaser.Math.Vector2;
  targetLockedUntil: number;
  invulnerableUntil: number;
  adrenalineUntil: number;
  lastShot: number;
  lastFlare: boolean;
  lastInteract: boolean;
}

const MAX_ACTIVE_ZOMBIES = 90;
const SNAPSHOT_RENDER_DELAY_MS = 100;
const SNAPSHOT_INTERVAL_MS = 50;
const BOSS_DEFINITIONS: Record<BossKind, BossDefinition> = {
  breaker: {
    name: 'THE BREAKER', texture: 'zombie-breaker', health: 135, speed: 54, radius: 30,
    shadowWidth: 74, shadowHeight: 31, color: 0xc83e32, enragedColor: 0xff5f4a, voice: 'breaker',
  },
  lurker: {
    name: 'THE LURKER', texture: 'zombie-lurker', health: 128, speed: 48, radius: 25,
    shadowWidth: 66, shadowHeight: 27, color: 0x9e2728, enragedColor: 0xec3c4b, voice: 'lurker',
  },
  furnace: {
    name: 'THE FURNACE', texture: 'zombie-furnace', health: 146, speed: 42, radius: 30,
    shadowWidth: 72, shadowHeight: 31, color: 0xff7028, enragedColor: 0xffd05c, voice: 'furnace',
  },
  spitter: {
    name: 'THE SPITTER', texture: 'zombie-spitter', health: 128, speed: 50, radius: 25,
    shadowWidth: 66, shadowHeight: 29, color: 0xb4a44d, enragedColor: 0xe8da72, voice: 'spitter',
  },
};

export class ArenaScene extends Phaser.Scene {
  private score = 0;
  private health = 100;
  private startedAt = 0;
  private pausedAt = 0;
  private runId = '';
  private lastShot = 0;
  private lastHurt = -1000;
  private lastHurtByPlayer = new Map<DuoPlayerId, number>();
  private playerKnockbackUntil = 0;
  private playerKnockbackDuration = 0;
  private playerKnockbackVelocity = new Phaser.Math.Vector2();
  private isGameOver = false;
  private isPaused = false;
  private bloodDecals: Phaser.GameObjects.Image[] = [];
  private corpses: Phaser.GameObjects.Image[] = [];
  private trees: TreeLayers[] = [];
  private floodlightPositions: { x: number; y: number }[] = [];
  private announcementQueue: [string, string, boolean][] = [];
  private announcementActive = false;
  private generatorWearEvent?: Phaser.Time.TimerEvent;
  private barrelDropEvent?: Phaser.Time.TimerEvent;
  private barrelSlots: BarrelSlot[] = [];
  private bossHazards: BossHazard[] = [];
  private readonly touchEnabled = hasTouchControls();
  private touchMoveActive = false;
  private touchMove: TouchVector = { x: 0, y: 0 };
  private touchAimVector: TouchVector = { x: 1, y: 0 };
  private touchAimFiring = false;
  private pausedForPortrait = false;

  private audio!: AudioSystem;
  private flares!: FlareSystem;
  private monsterAudio!: MonsterAudioSystem;
  private lighting!: LightingSystem;
  private supplies!: SupplySystem;
  private director!: WaveDirector;
  private keys!: Controls;
  private debugText?: Phaser.GameObjects.Text;

  // Phaser's heterogeneous Group API does not expose a useful generic element type.
  private bullets!: any;
  private zombies!: any;
  private solidProps!: any;
  private barrels!: any;
  private player!: Phaser.Physics.Arcade.Sprite;
  private playerShadow!: Phaser.GameObjects.Image;
  private playerGlow!: Phaser.GameObjects.Image;
  private tracers!: Phaser.GameObjects.Graphics;

  private scoreText!: Phaser.GameObjects.Text;
  private healthBack!: Phaser.GameObjects.Rectangle;
  private healthBar!: Phaser.GameObjects.Rectangle;
  private waveText!: Phaser.GameObjects.Text;
  private helpText!: Phaser.GameObjects.Text;
  private crosshair!: Phaser.GameObjects.Graphics;
  private aimLaser!: Phaser.GameObjects.Graphics;
  private pauseMenu!: Phaser.GameObjects.Container;
  private pauseStatusText!: Phaser.GameObjects.Text;
  private pauseTitleText!: Phaser.GameObjects.Text;
  private generatorBeacon!: Phaser.GameObjects.Image;
  private generatorBeaconLight!: Phaser.GameObjects.Arc;
  private generatorMarker!: Phaser.GameObjects.Text;
  private statusVignette!: Phaser.GameObjects.Image;
  private adrenalineText!: Phaser.GameObjects.Text;
  private leaderboardResultText?: Phaser.GameObjects.Text;
  private wasAdrenalineActive = false;
  private readonly launchOptions = getGameLaunchOptions();
  private readonly duoOptions: DuoLaunchOptions | undefined = this.launchOptions.mode === 'duos'
    ? this.launchOptions
    : undefined;
  private readonly isNetworkClient = this.launchOptions.mode === 'duos' && this.launchOptions.role === 'guest';
  private readonly isDuo = this.launchOptions.mode === 'duos';
  private readonly localPlayerId: DuoPlayerId = this.launchOptions.mode === 'duos'
    ? this.launchOptions.playerId
    : 'host';
  private playerActors = new Map<DuoPlayerId, PlayerActor>();
  private remoteInput: DuoInput = neutralDuoInput();
  private inputSequence = 0;
  private pendingInputs: DuoInput[] = [];
  private acknowledgedInputSequence = -1;
  private lastInputSentAt = -Infinity;
  private pendingFlareInput = false;
  private pendingInteractInput = false;
  private flareInputSequence = -1;
  private interactInputSequence = -1;
  private lastSnapshotSentAt = -Infinity;
  private snapshotTick = 0;
  private snapshotBuffer: { snapshot: DuoSnapshot; receivedAt: number }[] = [];
  private lastRemoteSnapshotTick = -1;
  private networkEffects: Array<DuoEffectSnapshot & { createdAt: number }> = [];
  private seenNetworkEffectIds = new Set<string>();
  private predictedImpacts: Array<{ x: number; y: number; at: number }> = [];
  private networkEffectId = 0;
  private predictedNetworkId = 0;
  private pingText?: Phaser.GameObjects.Text;
  private networkDisconnectHandler?: (event: Event) => void;
  private networkPingHandler?: (event: Event) => void;
  private networkConnectionHandler?: (event: Event) => void;
  private networkGameOverHandler?: (event: Event) => void;
  private networkLeaderboardHandler?: (event: Event) => void;
  private networkId = 0;
  private combatTargetId?: DuoPlayerId;
  private networkSupplyCache?: Phaser.GameObjects.Image;
  private networkSupplyPickup?: Phaser.GameObjects.Image;
  private networkSupplyGlow?: Phaser.GameObjects.Image;
  private networkSupplyDrop?: Phaser.GameObjects.Image;
  private networkSupplyDropShadow?: Phaser.GameObjects.Ellipse;
  private networkSupplyLabel?: Phaser.GameObjects.Text;
  private networkSupplyPrompt?: Phaser.GameObjects.Text;
  private networkSupplyLandingZone?: Phaser.GameObjects.Graphics;
  private networkFlareInventory?: Phaser.GameObjects.Text;
  private networkFlareCartridge?: Phaser.GameObjects.Image;
  private networkFlareCartridgeShadow?: Phaser.GameObjects.Ellipse;
  private networkFlareCartridgeGlow?: Phaser.GameObjects.Image;
  private networkEventSequence = 0;
  private networkPausedByConnection = false;
  private waitingForPartner = false;
  private networkPaused = false;
  private networkWave = 1;

  private readonly handleMobileControl = (event: Event): void => {
    const detail = (event as CustomEvent<{
      kind: 'move' | 'aim' | 'action';
      x?: number;
      y?: number;
      active?: boolean;
      action?: 'pause' | 'flare' | 'interact';
    }>).detail;
    if (!this.touchEnabled) return;
    if (this.sound.locked) this.sound.unlock?.();

    if (detail.kind === 'move') {
      this.touchMove = detail.active ? { x: detail.x ?? 0, y: detail.y ?? 0 } : { x: 0, y: 0 };
      this.touchMoveActive = detail.active === true;
      return;
    }
    if (detail.kind === 'aim') {
      const x = detail.x ?? 0;
      const y = detail.y ?? 0;
      const distance = Math.hypot(x, y);
      if (distance > 0) this.touchAimVector = { x: x / distance, y: y / distance };
      this.touchAimFiring = detail.active === true && distance > AIM_FIRE_DEAD_ZONE;
      return;
    }

    if (detail.action === 'pause') {
      if (!this.isGameOver) this.togglePause();
    } else if (!this.isPaused && !this.isGameOver && detail.action === 'flare') {
      const actor = this.actor(this.localPlayerId);
      if (!actor?.alive) return;
      if (this.isNetworkClient) {
        if (actor.flareCharges > 0) this.pendingFlareInput = true;
      } else {
        this.flares.fire(this.currentAimAngle(), this.time.now);
      }
    } else if (!this.isPaused && !this.isGameOver && detail.action === 'interact') {
      this.supplies.interact();
    }
  };

  private readonly handleMobileOrientation = (event: Event): void => {
    const { portrait } = (event as CustomEvent<{ portrait: boolean }>).detail;
    if (portrait) {
      this.touchMoveActive = false;
      this.touchMove = { x: 0, y: 0 };
      this.touchAimFiring = false;
      if (!this.isPaused && !this.isGameOver) {
        this.pausedForPortrait = true;
        this.togglePause();
      }
    } else if (this.pausedForPortrait && this.isPaused && !this.isGameOver) {
      this.pausedForPortrait = false;
      this.togglePause();
    } else if (!portrait) {
      this.pausedForPortrait = false;
    }
  };

  private readonly handleLeaderboardResult = (event: Event): void => {
    const { runId, rank, newRecord, available } = (event as CustomEvent<{
      runId: string;
      rank: number | null;
      newRecord: boolean;
      available: boolean;
    }>).detail;
    if (runId !== this.runId || !this.isGameOver || !this.leaderboardResultText?.active) return;
    if (!available) {
      this.leaderboardResultText.setText('ARCHIVE OFFLINE  //  SCORE QUEUED').setColor('#a99c91');
    } else if (!newRecord) {
      this.leaderboardResultText
        .setText('NO NEW PERSONAL BEST')
        .setColor('#a99c91');
    } else {
      this.leaderboardResultText
        .setText(`NEW PERSONAL BEST SECURED  //  RANK #${String(rank).padStart(2, '0')}`)
        .setColor('#f06a51');
    }
  };

  constructor() {
    super('arena');
  }

  preload() {
    loadAssets(this);
  }

  create() {
    if (import.meta.env.DEV) {
      this.physics.world.drawDebug = false;
      this.physics.world.debugGraphic.clear();
    }

    this.score = 0;
    this.health = 100;
    this.startedAt = this.time.now;
    this.pausedAt = 0;
    this.runId = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.lastShot = 0;
    this.lastHurt = -1000;
    this.lastHurtByPlayer.clear();
    this.playerKnockbackUntil = 0;
    this.playerKnockbackDuration = 0;
    this.playerKnockbackVelocity.set(0, 0);
    this.isGameOver = false;
    this.isPaused = false;
    this.touchMoveActive = false;
    this.touchMove = { x: 0, y: 0 };
    this.touchAimVector = { x: 1, y: 0 };
    this.touchAimFiring = false;
    this.pausedForPortrait = false;
    this.bloodDecals = [];
    this.corpses = [];
    this.wasAdrenalineActive = false;
    this.announcementQueue = [];
    this.announcementActive = false;
    this.generatorWearEvent = undefined;
    this.barrelDropEvent = undefined;
    this.barrelSlots = [];
    this.bossHazards = [];
    this.leaderboardResultText = undefined;
    this.playerActors.clear();
    this.remoteInput = neutralDuoInput();
    this.inputSequence = 0;
    this.pendingInputs = [];
    this.acknowledgedInputSequence = -1;
    this.lastInputSentAt = -Infinity;
    this.pendingFlareInput = false;
    this.pendingInteractInput = false;
    this.flareInputSequence = -1;
    this.interactInputSequence = -1;
    this.lastSnapshotSentAt = -Infinity;
    this.snapshotTick = 0;
    this.snapshotBuffer = [];
    this.lastRemoteSnapshotTick = -1;
    this.networkEffects = [];
    this.seenNetworkEffectIds.clear();
    this.predictedImpacts = [];
    this.networkEffectId = 0;
    this.predictedNetworkId = 0;
    this.networkId = 0;
    this.combatTargetId = undefined;
    this.networkSupplyCache = undefined;
    this.networkSupplyPickup = undefined;
    this.networkSupplyGlow = undefined;
    this.networkSupplyDrop = undefined;
    this.networkSupplyDropShadow = undefined;
    this.networkSupplyLabel = undefined;
    this.networkSupplyPrompt = undefined;
    this.networkSupplyLandingZone = undefined;
    this.networkFlareInventory = undefined;
    this.networkFlareCartridge = undefined;
    this.networkFlareCartridgeShadow = undefined;
    this.networkFlareCartridgeGlow = undefined;
    this.networkEventSequence = 0;
    this.networkPausedByConnection = false;
    this.waitingForPartner = this.isDuo;
    this.networkPaused = false;
    this.networkWave = 1;
    window.addEventListener('last-light:leaderboard-result', this.handleLeaderboardResult);
    this.networkDisconnectHandler = (event) => {
      const reason = String((event as CustomEvent<{ reason?: string }>).detail?.reason ?? 'MULTIPLAYER LINK LOST');
      this.handleNetworkDisconnect(reason);
    };
    this.networkPingHandler = (event) => {
      const milliseconds = (event as CustomEvent<{ milliseconds?: number | null }>).detail?.milliseconds;
      this.updatePing(milliseconds ?? null);
    };
    this.networkConnectionHandler = (event) => {
      const state = (event as CustomEvent<{ state?: 'connected' | 'reconnecting' | 'failed' }>).detail?.state;
      if (state) this.handleNetworkConnection(state);
    };
    this.networkGameOverHandler = (event) => {
      const message = String((event as CustomEvent<{ message?: string }>).detail?.message
        ?? 'OPERATION ENDED // BOTH SURVIVORS DOWN');
      this.gameOver(message);
    };
    this.networkLeaderboardHandler = (event) => {
      const detail = (event as CustomEvent<{ rank: number | null; newRecord: boolean; available: boolean }>).detail;
      this.handleLeaderboardResult(new CustomEvent('last-light:leaderboard-result', {
        detail: { runId: this.runId, ...detail },
      }));
    };
    window.addEventListener('last-light:duo-disconnected', this.networkDisconnectHandler);
    window.addEventListener('last-light:ping', this.networkPingHandler);
    window.addEventListener('last-light:duo-connection', this.networkConnectionHandler);
    window.addEventListener('last-light:duo-game-over', this.networkGameOverHandler);
    window.addEventListener('last-light:duo-leaderboard-result', this.networkLeaderboardHandler);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener('last-light:leaderboard-result', this.handleLeaderboardResult);
      if (this.networkDisconnectHandler) window.removeEventListener('last-light:duo-disconnected', this.networkDisconnectHandler);
      if (this.networkPingHandler) window.removeEventListener('last-light:ping', this.networkPingHandler);
      if (this.networkConnectionHandler) window.removeEventListener('last-light:duo-connection', this.networkConnectionHandler);
      if (this.networkGameOverHandler) window.removeEventListener('last-light:duo-game-over', this.networkGameOverHandler);
      if (this.networkLeaderboardHandler) window.removeEventListener('last-light:duo-leaderboard-result', this.networkLeaderboardHandler);
      this.leaderboardResultText = undefined;
    });
    if (!this.isNetworkClient) window.dispatchEvent(new CustomEvent('last-light:run-start'));
    this.audio = new AudioSystem(this, {
      onCue: (cue) => this.emitDuoEvent('music-cue', { ...cue }),
      onSound: (sound) => this.emitDuoEvent('sound-effect', { ...sound }),
    });
    this.monsterAudio = new MonsterAudioSystem(this, {
      onSound: (sound) => this.emitDuoEvent('sound-effect', { ...sound }),
    });

    if (!this.anims.exists('barrel-explosion')) {
      this.anims.create({
        key: 'barrel-explosion',
        frames: [40, 50, 70, 90, 120, 160].map((duration, frame) => ({
          key: 'explosion',
          frame,
          duration,
        })),
        frameRate: 1000,
        repeat: 0,
      });
    }
    if (!this.anims.exists('bullet-impact')) {
      this.anims.create({
        key: 'bullet-impact',
        frames: [40, 50, 70, 90, 120].map((duration, frame) => ({ key: 'bullet-impact', frame, duration })),
        frameRate: 1000,
      });
      this.anims.create({
        key: 'blood-hit',
        frames: [40, 50, 70, 90, 120].map((duration, frame) => ({ key: 'blood-hit', frame, duration })),
        frameRate: 1000,
      });
    }
    if (!this.anims.exists('ground-fire')) {
      this.anims.create({
        key: 'ground-fire',
        frames: this.anims.generateFrameNumbers('ground-fire', { start: 0, end: 5 }),
        frameRate: 11,
        repeat: -1,
      });
    }

    this.makeTextures();
    this.makeArena();
    this.makeActors();
    this.makeEnvironment();
    this.makeLightingAndAmbience();
    this.makeInterface();
    this.bindControls();
    this.playerActors.forEach((actor) => {
      this.physics.add.collider(actor.sprite, this.solidProps);
      this.physics.add.collider(actor.sprite, this.barrels);
    });

    if (this.isNetworkClient) {
      this.attachNetworkClient();
      this.duoOptions?.session.sendReady();
      this.audio.startMusic();
      this.cameras.main.fadeIn(350, 4, 7, 6);
      window.dispatchEvent(new CustomEvent('last-light:game-ready'));
      return;
    }

    this.flares = new FlareSystem(this, this.player, this.lighting, this.audio, {
      isGeneratorOnline: () => !this.lighting.generatorDestroyed,
      isGeneratorUnstable: () => this.lighting.isGeneratorUnstable(),
      isPlayerAlive: (player) => [...this.playerActors.values()]
        .some((actor) => actor.sprite === player && actor.alive && actor.health > 0),
      isGameOver: () => this.isGameOver,
      announce: (title, subtitle) => this.announce(title, subtitle),
      setGeneratorStatus: (status) => {
        if (this.lighting.generatorDestroyed) return;
        const unstable = this.lighting.isGeneratorUnstable();
        const conciseStatus = status === 'CARTRIDGE READY'
          ? 'FLARE READY'
          : status.startsWith('FLARE IN ')
            ? `${unstable ? 'UNSTABLE  •  ' : ''}${status}`
            : status;
        this.generatorMarker
          .setText(conciseStatus)
          .setColor(unstable ? '#d8a55f' : '#b9d0a9');
      },
      emitNetworkEvent: (type, payload) => this.emitDuoEvent(type, payload),
    });
    this.supplies = new SupplySystem(this, this.player, {
      getHealth: () => this.isDuo
        ? Math.min(...[...this.playerActors.values()].map((actor) => actor.health))
        : this.health,
      heal: (amount) => this.healPlayer(amount),
      canAddFlare: () => this.flares.canAddCharge(),
      getFlareCharges: () => this.flares.chargeCount(),
      addFlare: () => this.flares.addCharge(),
      needsRepair: () => this.outpostNeedsRepair(),
      getBaseIntegrity: () => this.outpostIntegrity(),
      repairOutpost: () => this.repairOutpost(),
      announce: (title, subtitle) => this.announce(title, subtitle),
      isGameOver: () => this.isGameOver,
      emitNetworkEvent: (type, payload) => this.emitDuoEvent(type, payload),
    });
    if (this.isDuo) {
      const guest = this.actor('guest');
      if (guest) {
        this.flares.addPlayer(guest.sprite);
        this.supplies.addPlayer(guest.sprite);
      }
    }
    this.audio.startMusic();
    this.director = new WaveDirector(this, {
      spawnZombie: (edge) => this.spawnZombie(edge),
      spawnBoss: (kind, edge) => this.telegraphBoss(kind, edge),
      telegraphHorde: (edge) => this.telegraphHorde(edge),
      announce: (title, subtitle) => this.announce(title, subtitle),
      startPowerFailure: (wave) => this.startOutpostPowerFailure(wave),
      isGameOver: () => this.isGameOver,
    });
    if (!this.isDuo) this.director.start();

    this.attachNetworkHost();

    this.physics.add.overlap(this.bullets, this.zombies, this.hitZombie, undefined, this);
    this.physics.add.overlap(this.bullets, this.barrels, this.hitBarrel, undefined, this);
    this.physics.add.overlap(this.bullets, this.solidProps, this.hitProp, undefined, this);
    this.playerActors.forEach((actor) => {
      this.physics.add.overlap(actor.sprite, this.zombies, this.hurtPlayer, undefined, this);
    });
    this.physics.add.collider(
      this.zombies,
      this.solidProps,
      this.handleZombiePropCollision,
      this.shouldCollideZombieWithProp,
      this,
    );
    this.physics.add.collider(
      this.zombies,
      this.barrels,
      this.handleZombieBarrelCollision,
      this.shouldCollideZombieWithBarrel,
      this,
    );

    this.time.delayedCall(700, () => {
      if (!this.waitingForPartner) this.announce(
        'HOLD THE OUTPOST',
        this.touchEnabled
          ? 'TAP LEFT SIDE TO MOVE • HOLD RIGHT SIDE TO AIM • PUSH PAST INNER RING TO FIRE'
          : 'WASD TO MOVE • MOUSE TO AIM AND FIRE',
      );
    });
    this.cameras.main.fadeIn(350, 4, 7, 6);
    window.dispatchEvent(new CustomEvent('last-light:game-ready'));
  }

  private attachNetworkHost(): void {
    if (!this.duoOptions || this.duoOptions.role !== 'host') return;
    this.duoOptions.session.setRuntimeCallbacks({
      input: (input) => {
        this.remoteInput = sanitizeDuoInput(input);
      },
      ready: () => this.beginDuoSimulation(),
    });
  }

  private attachNetworkClient(): void {
    if (!this.duoOptions || this.duoOptions.role !== 'guest') return;
    this.duoOptions.session.setRuntimeCallbacks({
      snapshot: (snapshot) => {
        if (!snapshot || snapshot.tick <= this.lastRemoteSnapshotTick) return;
        this.lastRemoteSnapshotTick = snapshot.tick;
        this.snapshotBuffer.push({ snapshot, receivedAt: performance.now() });
        if (this.snapshotBuffer.length > 12) this.snapshotBuffer.shift();
      },
      redeploy: () => {
        if (!this.isGameOver) return;
        this.audio.fadeOutMusic(() => this.scene.restart());
      },
      paused: (paused) => this.setNetworkPaused(paused),
      event: (event) => this.handleNetworkEvent(event),
    });
  }

  private emitDuoEvent(type: DuoEventType, payload: Record<string, unknown>): void {
    if (!this.isDuo || this.isNetworkClient || !this.duoOptions || this.duoOptions.role !== 'host') return;
    this.duoOptions.session.sendEvent({
      id: `${this.runId}:${this.networkEventSequence}`,
      sequence: this.networkEventSequence++,
      tick: this.snapshotTick,
      type,
      payload,
    });
  }

  private handleNetworkEvent(event: DuoEvent): void {
    if (!this.isNetworkClient || !event?.payload || !event.type) return;
    const payload = event.payload;
    const number = (key: string, fallback = 0): number => {
      const value = Number(payload[key]);
      return Number.isFinite(value) ? value : fallback;
    };
    const string = (key: string, fallback = ''): string => String(payload[key] ?? fallback);
    switch (event.type) {
      case 'announcement':
        this.announce(string('title'), string('subtitle'), false);
        break;
      case 'horde-warning':
        this.telegraphHorde(number('edge'), false);
        break;
      case 'boss-introduction': {
        const kind = string('kind') as BossKind;
        if (kind in BOSS_DEFINITIONS) this.telegraphBoss(kind, number('edge'), false);
        break;
      }
      case 'boss-warning':
        this.renderRemoteBossWarning(payload, number, string);
        break;
      case 'flare-cartridge':
        this.renderRemoteFlareCartridge(payload, number);
        break;
      case 'flare-collected':
        this.clearRemoteFlareCartridge();
        break;
      case 'flare-launch':
        this.renderRemoteFlareLaunch(payload, number);
        break;
      case 'flare-ignite':
        this.lighting.igniteAerialFlare(number('x'), number('y'), number('duration', 14000));
        break;
      case 'supply-drop':
        this.renderRemoteSupplyDrop(number('x', 585), number('y', 270), number('duration', 1050));
        break;
      case 'supply-ready':
        this.finishRemoteSupplyDrop(number('x', 585), number('y', 270), string('textureKey', 'supply-cache-closed'));
        break;
      case 'supply-opened':
        this.showRemoteSupplyPickup(string('kind', 'medkit'), number('x', 585), number('y', 262));
        break;
      case 'player-hit': {
        if (string('playerId') !== this.localPlayerId) break;
        const local = this.actor(this.localPlayerId);
        if (local) this.playLocalDamageFeedback(local);
        break;
      }
      case 'music-cue':
        this.audio.applyNetworkCue({ key: string('key'), loop: Boolean(payload.loop) } satisfies MusicCue);
        break;
      case 'sound-effect': {
        if (String(payload.ownerId ?? '') === this.localPlayerId
          && Number.isInteger(Number(payload.shotSequence))) break;
        const listener = this.actor(this.localPlayerId)?.sprite ?? this.player;
        if (string('kind') === 'monster') {
          this.monsterAudio.playNetworkSound(payload, listener.x, listener.y);
        } else {
          this.audio.playNetworkSound(payload, listener);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleNetworkConnection(state: 'connected' | 'reconnecting' | 'failed'): void {
    if (!this.isDuo || this.isGameOver) return;
    if (state === 'reconnecting') {
      this.networkPausedByConnection = true;
      this.networkPaused = true;
      this.pauseMenu?.setVisible(true);
      this.pauseTitleText?.setText('RECONNECTING');
      this.pauseStatusText?.setText('PRIVATE LINK // RESTORING SIGNAL');
      this.crosshair?.setVisible(false);
      this.playerActors.forEach((actor) => actor.sprite.setVelocity(0));
    } else if (state === 'connected' && this.networkPausedByConnection) {
      this.networkPausedByConnection = false;
      this.networkPaused = false;
      if (!this.isPaused) this.pauseMenu?.setVisible(false);
      this.crosshair?.setVisible(!this.isPaused);
    } else if (state === 'failed') {
      this.handleNetworkDisconnect('CONNECTION LOST // THE MULTIPLAYER CONNECTION FAILED');
    }
  }

  private beginDuoSimulation(): void {
    if (!this.isDuo || this.isNetworkClient || this.isGameOver || !this.waitingForPartner) return;
    this.waitingForPartner = false;
    this.director.start();
    this.waveText?.setText('THREAT 01');
    this.announce('HOLD THE OUTPOST', 'WASD TO MOVE • MOUSE TO AIM AND FIRE');
  }

  private setNetworkPaused(paused: boolean): void {
    if (!this.isNetworkClient) return;
    this.networkPaused = paused;
    this.pauseMenu?.setVisible(paused);
    this.crosshair?.setVisible(!paused);
    if (paused) {
      this.pauseStatusText?.setText('HOST CONTROL // FIELD OPERATIONS SUSPENDED');
      this.pauseTitleText?.setText('PAUSED');
      this.playerActors.forEach((actor) => actor.sprite.setVelocity(0));
    }
  }

  private updatePing(milliseconds: number | null): void {
    if (!this.pingText) return;
    if (milliseconds === null || !Number.isFinite(milliseconds)) {
      this.pingText.setText('PING  --').setColor('#817d76');
      return;
    }
    const rounded = Math.max(0, Math.round(milliseconds));
    this.pingText
      .setText(`PING  ${rounded}ms`)
      .setColor(rounded >= 220 ? '#d04d3d' : rounded >= 140 ? '#b49a69' : '#817d76');
  }

  private handleNetworkDisconnect(reason: string): void {
    if (!this.isDuo || this.isGameOver) return;
    this.gameOver(reason.startsWith('OPERATION ENDED')
      ? reason
      : `CONNECTION LOST // ${reason.toUpperCase()}`);
  }

  private actor(id: DuoPlayerId): PlayerActor | undefined {
    return this.playerActors.get(id);
  }

  private livingActors(): PlayerActor[] {
    return [...this.playerActors.values()].filter((player) => player.alive && player.health > 0);
  }

  private closestLivingActor(x: number, y: number): PlayerActor | undefined {
    let closest: PlayerActor | undefined;
    let closestDistance = Infinity;
    this.playerActors.forEach((actor) => {
      if (!actor.alive || actor.health <= 0) return;
      const distance = Phaser.Math.Distance.Squared(x, y, actor.sprite.x, actor.sprite.y);
      if (distance < closestDistance) {
        closest = actor;
        closestDistance = distance;
      }
    });
    return closest;
  }

  private enemyTarget(enemy: any, time = this.time.now): PlayerActor | undefined {
    const currentId = enemy.getData('targetPlayerId') as DuoPlayerId | undefined;
    const current = currentId ? this.actor(currentId) : undefined;
    const nearest = this.closestLivingActor(enemy.x, enemy.y);
    if (!nearest) return undefined;
    if (current?.alive && current.health > 0) {
      const currentDistance = Phaser.Math.Distance.Squared(enemy.x, enemy.y, current.sprite.x, current.sprite.y);
      const nearestDistance = Phaser.Math.Distance.Squared(enemy.x, enemy.y, nearest.sprite.x, nearest.sprite.y);
      const lockUntil = Number(enemy.getData('targetLockedUntil') ?? 0);
      if (time < lockUntil || currentDistance <= nearestDistance * 1.24 + 900) return current;
    }
    enemy.setData({ targetPlayerId: nearest.id, targetLockedUntil: time + 900 });
    return nearest;
  }

  private enemyFacingAngle(enemy: any, target: PlayerActor): number {
    const deltaX = target.sprite.x - enemy.x;
    const deltaY = target.sprite.y - enemy.y;
    const previousAngle = Number(enemy.getData('facingAngle'));
    if (Math.hypot(deltaX, deltaY) <= ENEMY_FACING_EPSILON && Number.isFinite(previousAngle)) {
      // Angle.Between is undefined as a gameplay direction when both bodies
      // occupy the same point. Keep the last meaningful heading instead of
      // allowing tiny physics rounding changes to flip the sprite every frame.
      return previousAngle;
    }

    const angle = Phaser.Math.Angle.Between(enemy.x, enemy.y, target.sprite.x, target.sprite.y);
    enemy.setData('facingAngle', angle);
    return angle;
  }

  private enemyIsAtContactDistance(enemy: any, target: PlayerActor): boolean {
    const enemyBody = enemy.body as Phaser.Physics.Arcade.Body | null;
    const targetBody = target.sprite.body as Phaser.Physics.Arcade.Body | null;
    if (!enemyBody || !targetBody) return false;

    // Use Arcade's actual shape test instead of sprite-center distance. Enemy
    // bodies are offset behind their artwork, and crawlers use rectangles, so
    // a summed-radius approximation can stop them before the attack overlap.
    return this.physics.world.intersects(enemyBody, targetBody);
  }

  private withCombatTarget<T>(target: PlayerActor | undefined, action: () => T): T {
    if (!target) return action();
    const previousPlayer = this.player;
    const previousTarget = this.combatTargetId;
    this.player = target.sprite;
    this.combatTargetId = target.id;
    try {
      return action();
    } finally {
      this.player = previousPlayer;
      this.combatTargetId = previousTarget;
    }
  }

  private updateActorMotion(actor: PlayerActor, input: Pick<DuoInput, 'moveX' | 'moveY' | 'aim'>, time: number): void {
    if (!actor.alive || actor.health <= 0) {
      actor.sprite.setVelocity(0);
      return;
    }
    const movement = new Phaser.Math.Vector2(
      Phaser.Math.Clamp(input.moveX, -1, 1),
      Phaser.Math.Clamp(input.moveY, -1, 1),
    );
    if (movement.lengthSq() > 1) movement.normalize();
    const speedMultiplier = this.supplies
      ? this.supplies.movementMultiplier(time, actor.sprite)
      : time < actor.adrenalineUntil ? 1.22 : 1;
    const moveSpeed = PLAYER_SPEED * speedMultiplier;
    const body = actor.sprite.body as Phaser.Physics.Arcade.Body;
    if (time < actor.knockbackUntil) {
      const remaining = actor.knockbackDuration > 0
        ? (actor.knockbackUntil - time) / actor.knockbackDuration
        : 0;
      const force = 0.35 + Phaser.Math.Clamp(remaining, 0, 1) * 0.65;
      body.setMaxVelocity(actor.knockbackVelocity.length());
      actor.sprite.setVelocity(actor.knockbackVelocity.x * force, actor.knockbackVelocity.y * force);
    } else {
      body.setMaxVelocity(moveSpeed);
      actor.sprite.setVelocity(movement.x * moveSpeed, movement.y * moveSpeed);
    }
    actor.aim = Number.isFinite(input.aim) ? input.aim : actor.aim;
    actor.sprite.rotation = actor.aim - SOUTH_OFFSET;
  }

  private updateActorDisplay(actor: PlayerActor): void {
    const aim = actor.aim;
    // sprite.x/y is the collision-centered pivot, so player markers follow it directly.
    const pivotX = actor.sprite.x;
    const pivotY = actor.sprite.y;
    actor.shadow.setPosition(pivotX + 2, pivotY + 3).setRotation(actor.sprite.rotation);
    actor.glow.setPosition(pivotX, pivotY);
    actor.ring?.setPosition(pivotX, pivotY)
      .setStrokeStyle(2, actor.color, actor.alive ? 0.82 : 0.3)
      .setAlpha(actor.alive ? 1 : 0.35);
    const healthBackX = actor.sprite.x - Math.cos(aim) * 36;
    const healthBackY = actor.sprite.y - Math.sin(aim) * 36;
    const labelX = healthBackX - Math.cos(aim) * 6;
    const labelY = healthBackY - Math.sin(aim) * 6;
    actor.nameLabel?.setPosition(labelX, labelY)
      .setAlpha(actor.alive ? 1 : 0.58)
      .setVisible(this.isDuo && actor.id !== this.localPlayerId);
    actor.youLabel?.setPosition(labelX, labelY);
    const barRotation = actor.sprite.rotation;
    actor.healthBack?.setPosition(healthBackX, healthBackY).setRotation(barRotation);
    const healthRatio = Phaser.Math.Clamp(actor.health / 100, 0, 1);
    const fillStartX = healthBackX - Math.cos(barRotation) * 17;
    const fillStartY = healthBackY - Math.sin(barRotation) * 17;
    actor.healthBar
      ?.setPosition(
        fillStartX,
        fillStartY,
      )
      .setRotation(barRotation)
      .setScale(healthRatio, 1)
      .setFillStyle(actor.health <= 35 ? 0xd4513f : actor.color, actor.alive ? 0.9 : 0.35);
    actor.sprite.setAlpha(actor.alive ? 1 : 0.44);
    if (!actor.alive) actor.sprite.setTint(0x6f5550);
  }

  private localDuoInput(time: number): DuoInput {
    const pointer = this.input.activePointer;
    const actor = this.actor(this.localPlayerId)!;
    const moveX = Number(this.keys.right.isDown || this.keys.rightAlt.isDown)
      - Number(this.keys.left.isDown || this.keys.leftAlt.isDown);
    const moveY = Number(this.keys.down.isDown || this.keys.downAlt.isDown)
      - Number(this.keys.up.isDown || this.keys.upAlt.isDown);
    const aim = Phaser.Math.Angle.Between(actor.sprite.x, actor.sprite.y, pointer.worldX, pointer.worldY);
    if (actor.alive && Phaser.Input.Keyboard.JustDown(this.keys.flare!)) this.pendingFlareInput = true;
    if (!actor.alive) {
      this.pendingFlareInput = false;
      this.flareInputSequence = -1;
    }
    this.pendingInteractInput ||= Phaser.Input.Keyboard.JustDown(this.keys.interact!);
    return {
      sequence: this.inputSequence + 1,
      moveX,
      moveY,
      aim,
      firing: pointer.isDown,
      flare: this.pendingFlareInput,
      interact: this.pendingInteractInput,
    };
  }

  private updateGuest(time: number): void {
    const actor = this.actor(this.localPlayerId);
    if (!actor) return;
    const snapshot = this.renderSnapshot(performance.now());
    if (snapshot) this.applySnapshot(snapshot);
    const input = this.localDuoInput(time);
    this.updateActorMotion(actor, input, time);
    const fireInterval = time < actor.adrenalineUntil ? 78 : 105;
    if (actor.alive && input.firing && time - actor.lastShot >= fireInterval) {
      actor.lastShot = time;
      this.shootForActor(actor, input.aim, time, true, input.sequence);
    }
    if (time - this.lastInputSentAt >= 33) {
      this.lastInputSentAt = time;
      this.inputSequence = input.sequence;
      if (input.flare && this.flareInputSequence < 0) this.flareInputSequence = input.sequence;
      if (input.interact && this.interactInputSequence < 0) this.interactInputSequence = input.sequence;
      this.pendingInputs.push(input);
      if (this.pendingInputs.length > 90) this.pendingInputs.shift();
      this.duoOptions?.session.sendInput(input);
    }
    this.playerActors.forEach((player) => this.updateActorDisplay(player));
    this.crosshair.setPosition(Math.round(this.input.activePointer.worldX), Math.round(this.input.activePointer.worldY));
    this.waveText.setText(this.waitingForPartner
      ? 'WAITING FOR HOST TO BEGIN...'
      : `THREAT ${String(this.networkWave ?? 1).padStart(2, '0')}`);
    this.scoreText.setText(String(this.score).padStart(5, '0'));
    this.tracers.clear().lineStyle(2, 0xffd66f, 0.7);
    this.lighting.lowHealthShade.setAlpha(actor.health <= 35 && actor.alive
      ? 0.035 + Math.sin(time * 0.006) * 0.025
      : 0);
    this.trees.forEach(({ x, y, canopy }) => {
      const targetAlpha = Phaser.Math.Distance.Between(actor.sprite.x, actor.sprite.y, x, y) < 54 ? 0.34 : 0.96;
      canopy.setAlpha(Phaser.Math.Linear(canopy.alpha, targetAlpha, 0.12));
    });
    const aim = actor.aim;
    const emberLights = this.zombies.getChildren()
      .filter((zombie) => zombie.active
        && (zombie.getData('type') === 'charred' || zombie.getData('bossKind') === 'furnace'))
      .map((zombie) => ({ x: zombie.x, y: zombie.y }));
    this.lighting.redraw(
      actor.sprite.x,
      actor.sprite.y,
      aim,
      this.collectShadowCasters(),
      emberLights,
      this.playerLightSources(),
    );
    this.updateGuestBullets(time);
    this.predictGuestBulletImpacts(time);
  }

  private updateGuestBullets(time: number): void {
    const now = performance.now();
    this.bullets.children.iterate((bullet) => {
      if (!bullet?.active) return;
      if (bullet.getData('remoteAuthoritative') === true) {
        const updatedAt = Number(bullet.getData('networkUpdatedAt'));
        const baseX = Number(bullet.getData('networkBaseX'));
        const baseY = Number(bullet.getData('networkBaseY'));
        const velocityX = Number(bullet.getData('networkVelocityX'));
        const velocityY = Number(bullet.getData('networkVelocityY'));
        if ([updatedAt, baseX, baseY, velocityX, velocityY].every(Number.isFinite)) {
          const elapsed = Phaser.Math.Clamp(
            SNAPSHOT_RENDER_DELAY_MS + now - updatedAt,
            0,
            260,
          ) / 1000;
          bullet.setPosition(baseX + velocityX * elapsed, baseY + velocityY * elapsed);
          bullet.setRotation(Number(bullet.getData('networkRotation')) || bullet.rotation);
        }
      }
      bullet.getData('glow')?.setPosition(bullet.x, bullet.y);
      this.tracers.lineBetween(
        bullet.x - Math.cos(bullet.rotation) * 24,
        bullet.y - Math.sin(bullet.rotation) * 24,
        bullet.x,
        bullet.y,
      );
      const predicted = bullet.getData('predicted') === true;
      const createdAt = Number(bullet.getData('createdAt') ?? time);
      if (
        (predicted && time - createdAt > 1400)
        || bullet.x < -20
        || bullet.x > WIDTH + 20
        || bullet.y < -20
        || bullet.y > HEIGHT + 20
      ) {
        this.destroyBullet(bullet);
      }
    });
  }

  private predictGuestBulletImpacts(time: number): void {
    this.predictedImpacts = this.predictedImpacts.filter((impact) => time - impact.at < 260);
    this.bullets.children.iterate((bullet) => {
      if (!bullet?.active || bullet.getData('predicted') !== true) return;
      const zombie = this.zombies.getChildren().find((candidate) => candidate.active
        && Phaser.Math.Distance.Between(bullet.x, bullet.y, candidate.x, candidate.y)
          <= (candidate.getData('bossKind') ? 31 : 20));
      if (zombie) {
        const impactAngle = bullet.rotation;
        this.predictedImpacts.push({ x: bullet.x, y: bullet.y, at: time });
        this.playImpactEffect('blood-hit', bullet.x, bullet.y, impactAngle);
        this.makeBlood(bullet.x, bullet.y, impactAngle, zombie.getData('bossKind') ? 4 : 2);
        zombie.setTintFill(0xf0d6ae);
        this.time.delayedCall(55, () => zombie.active && zombie.setTint(zombie.getData('tint') ?? 0xffffff));
        this.destroyBullet(bullet);
        return;
      }
      const prop = [...this.solidProps.getChildren(), ...this.barrels.getChildren()].find((candidate) => candidate.active
        && !candidate.getData('bulletPassThrough')
        && Phaser.Math.Distance.Between(bullet.x, bullet.y, candidate.x, candidate.y) <= 23);
      if (prop) {
        this.predictedImpacts.push({ x: bullet.x, y: bullet.y, at: time });
        this.playImpactEffect('bullet-impact', bullet.x, bullet.y, bullet.rotation);
        this.makeSparks(bullet.x, bullet.y, bullet.rotation, 4);
        this.destroyBullet(bullet);
      }
    });
  }

  private updateRemoteActor(time: number): void {
    const actor = this.actor('guest');
    if (!actor || !this.isDuo || this.isNetworkClient) return;
    this.updateActorMotion(actor, this.remoteInput, time);
    if (actor.alive && this.remoteInput.firing
      && time - actor.lastShot >= this.supplies.fireInterval(time, actor.sprite)) {
      actor.lastShot = time;
      this.shootForActor(actor, actor.aim, time, false, this.remoteInput.sequence);
    }
    if (actor.alive && this.remoteInput.flare && !actor.lastFlare) this.flares.launch(actor.aim, time, actor.sprite);
    if (actor.alive && this.remoteInput.interact && !actor.lastInteract) this.supplies.interact(actor.sprite);
    actor.lastFlare = this.remoteInput.flare;
    actor.lastInteract = this.remoteInput.interact;
  }

  private sendHostSnapshot(time: number): void {
    if (!this.isDuo || this.isNetworkClient || time - this.lastSnapshotSentAt < SNAPSHOT_INTERVAL_MS) return;
    this.lastSnapshotSentAt = time;
    this.snapshotTick += 1;
    this.duoOptions?.session.sendSnapshot(this.buildSnapshot(time));
  }

  private buildSnapshot(time: number): DuoSnapshot {
    this.networkEffects = this.networkEffects.filter((effect) => time - effect.createdAt <= 1800);
    const players: PlayerSnapshot[] = [...this.playerActors.values()].map((actor) => ({
      id: actor.id,
      callsign: actor.callsign,
      skinId: actor.skinId,
      color: actor.color,
      x: actor.sprite.x,
      y: actor.sprite.y,
      rotation: actor.sprite.rotation,
      health: actor.health,
      alive: actor.alive,
      invulnerableUntil: actor.invulnerableUntil,
      flareCharges: this.flares?.chargeCount() ?? actor.flareCharges,
      adrenalineMs: this.supplies?.adrenalineRemaining(time, actor.sprite) ?? 0,
      lastProcessedInput: actor.id === 'guest' ? this.duoOptions?.session.lastProcessedInput : undefined,
    }));
    const zombies: ZombieSnapshot[] = this.zombies.getChildren()
      .filter((zombie) => zombie.active && zombie.getData('networkId'))
      .map((zombie) => ({
        id: zombie.getData('networkId'),
        textureKey: zombie.getData('textureKey') ?? zombie.texture.key,
        type: zombie.getData('type') ?? 'shambler',
        x: zombie.x,
        y: zombie.y,
        rotation: zombie.rotation,
        health: zombie.getData('health'),
        maxHealth: zombie.getData('maxHealth') ?? Math.max(1, zombie.getData('health')),
        scale: zombie.scaleX,
        tint: zombie.tintTopLeft ?? 0xffffff,
        alpha: zombie.alpha,
        bossKind: zombie.getData('bossKind'),
        bossState: zombie.getData('bossState'),
        phase: zombie.getData('phase'),
      }));
    const bullets: BulletSnapshot[] = this.bullets.getChildren()
      .filter((bullet) => bullet.active && bullet.getData('networkId'))
      .map((bullet) => ({
        id: bullet.getData('networkId'),
        x: bullet.x,
        y: bullet.y,
        rotation: bullet.rotation,
        ownerId: bullet.getData('ownerId') ?? 'host',
        shotSequence: bullet.getData('shotSequence'),
      }));
    const props: PropSnapshot[] = [
      ...this.solidProps.getChildren(),
      ...this.barrels.getChildren(),
    ].filter((prop) => prop.getData('networkId')).map((prop) => ({
      id: prop.getData('networkId'),
      kind: prop.getData('kind') ?? 'barrel',
      x: prop.x,
      y: prop.y,
      rotation: prop.rotation,
      health: prop.getData('health') ?? 0,
      maxHealth: prop.getData('maxHealth') ?? 0,
      active: prop.active && prop.body?.enable !== false,
      textureKey: prop.texture.key,
    }));
    return {
      tick: this.snapshotTick,
      elapsedMs: Math.max(0, Math.round(this.getSurvivalMs())),
      score: this.score,
      wave: this.director?.wave ?? 1,
      waitingForPartner: this.waitingForPartner,
      paused: this.isPaused,
      players,
      zombies,
      bullets,
      effects: this.networkEffects.map(({ createdAt: _createdAt, ...effect }) => effect),
      props,
      generatorOnline: !this.lighting.generatorDestroyed,
      generatorUnstable: this.lighting.isGeneratorUnstable(),
      supplyStatus: this.generatorMarker?.text ?? '',
      supply: this.supplies?.networkState() ?? { state: 'waiting' },
      flare: this.lighting.networkFlareState(),
    };
  }

  private renderSnapshot(now: number): DuoSnapshot | undefined {
    if (this.snapshotBuffer.length === 0) return undefined;
    const target = now - SNAPSHOT_RENDER_DELAY_MS;
    while (this.snapshotBuffer.length > 2 && this.snapshotBuffer[1].receivedAt <= target) {
      this.snapshotBuffer.shift();
    }
    const first = this.snapshotBuffer[0];
    const second = this.snapshotBuffer[1];
    if (!second || target <= first.receivedAt) return first.snapshot;
    if (target >= second.receivedAt) return second.snapshot;
    const alpha = Phaser.Math.Clamp(
      (target - first.receivedAt) / Math.max(1, second.receivedAt - first.receivedAt),
      0,
      1,
    );
    return interpolateDuoSnapshots(first.snapshot, second.snapshot, alpha);
  }

  private applySnapshot(snapshot: DuoSnapshot): void {
    this.score = snapshot.score;
    this.networkWave = snapshot.wave;
    this.waitingForPartner = snapshot.waitingForPartner;
    if (snapshot.paused !== this.networkPaused) this.setNetworkPaused(snapshot.paused);
    snapshot.players.forEach((player) => {
      const actor = this.actor(player.id);
      if (!actor) return;
      actor.callsign = player.callsign;
      this.applyActorSkin(actor, player.skinId, player.callsign, player.color);
      if (player.id !== this.localPlayerId) {
        actor.sprite.setPosition(player.x, player.y).setRotation(player.rotation);
      } else {
        if (Number.isInteger(player.lastProcessedInput) && player.lastProcessedInput! > this.acknowledgedInputSequence) {
          this.acknowledgedInputSequence = player.lastProcessedInput!;
          this.pendingInputs = this.pendingInputs.filter((input) => input.sequence > this.acknowledgedInputSequence);
          if (this.flareInputSequence >= 0 && this.acknowledgedInputSequence >= this.flareInputSequence) {
            this.pendingFlareInput = false;
            this.flareInputSequence = -1;
          }
          if (this.interactInputSequence >= 0 && this.acknowledgedInputSequence >= this.interactInputSequence) {
            this.pendingInteractInput = false;
            this.interactInputSequence = -1;
          }
        }
        const latestLocalPlayer = this.snapshotBuffer.at(-1)?.snapshot.players
          .find((candidate) => candidate.id === this.localPlayerId);
        const authoritativeX = latestLocalPlayer?.x ?? player.x;
        const authoritativeY = latestLocalPlayer?.y ?? player.y;
        const correctionX = authoritativeX - actor.sprite.x;
        const correctionY = authoritativeY - actor.sprite.y;
        const correctionDistance = Math.hypot(correctionX, correctionY);
        const authorityCaughtUp = (latestLocalPlayer?.lastProcessedInput ?? player.lastProcessedInput ?? -1)
          >= this.inputSequence;
        const locallyMoving = this.keys.left.isDown || this.keys.leftAlt.isDown
          || this.keys.right.isDown || this.keys.rightAlt.isDown
          || this.keys.up.isDown || this.keys.upAlt.isDown
          || this.keys.down.isDown || this.keys.downAlt.isDown;
        if (authorityCaughtUp && correctionDistance > 90) {
          actor.sprite.setPosition(authoritativeX, authoritativeY);
        } else if (authorityCaughtUp && correctionDistance > 1 && locallyMoving) {
          // Correct against the newest authority only while moving. Applying
          // delayed movement snapshots after key-up made the guest coast.
          actor.sprite.setPosition(
            actor.sprite.x + correctionX * 0.2,
            actor.sprite.y + correctionY * 0.2,
          );
        }
      }
      actor.health = Phaser.Math.Clamp(player.health, 0, 100);
      actor.alive = player.alive && actor.health > 0;
      actor.invulnerableUntil = player.invulnerableUntil;
      actor.flareCharges = player.flareCharges;
      actor.adrenalineUntil = this.time.now + Math.max(0, player.adrenalineMs ?? 0);
      if (player.id === this.localPlayerId) {
        this.networkFlareInventory?.setText(`FLARES  ${player.flareCharges} / 3  •  F TO LAUNCH`);
      }
      if (player.id !== this.localPlayerId) actor.aim = player.rotation + SOUTH_OFFSET;
      if (actor.sprite.body) actor.sprite.body.enable = actor.alive;
      actor.nameLabel?.setText(actor.callsign);
    });
    snapshot.effects?.forEach((effect) => this.applyNetworkEffect(effect));
    const knownZombieIds = new Set<string>();
    snapshot.zombies.forEach((zombie) => {
      knownZombieIds.add(zombie.id);
      const visual = this.findNetworkObject(this.zombies, zombie.id)
        ?? this.createRemoteZombie(zombie);
      if (visual) this.updateRemoteZombie(visual, zombie);
    });
    this.zombies.getChildren().slice().forEach((zombie) => {
      const id = zombie.getData('networkId');
      if (id && !knownZombieIds.has(id)) this.destroyRemoteZombie(zombie);
    });

    const knownBulletIds = new Set<string>();
    snapshot.bullets.forEach((bullet) => {
      // The guest owns the visual for their own shot immediately. Do not
      // create a second host-snapshot copy and let it race the prediction.
      if (bullet.ownerId === this.localPlayerId) return;
      knownBulletIds.add(bullet.id);
      const visual = this.findNetworkObject(this.bullets, bullet.id) ?? this.createRemoteBullet(bullet);
      if (visual) {
        if (visual.getData('lastSnapshotTick') !== snapshot.tick) {
          visual.setData({
            lastSnapshotTick: snapshot.tick,
            networkBaseX: bullet.x,
            networkBaseY: bullet.y,
            networkRotation: bullet.rotation,
            networkUpdatedAt: performance.now(),
          });
        }
      }
    });
    this.bullets.getChildren().slice().forEach((bullet) => {
      const id = bullet.getData('networkId');
      if (id && !knownBulletIds.has(id) && bullet.getData('remoteAuthoritative') === true) {
        this.destroyBullet(bullet);
      }
    });
    this.applyRemoteProps(snapshot.props);
    this.applySupplySnapshot(snapshot.supply);
    this.lighting.syncAerialFlare(snapshot.flare);
    if (!snapshot.generatorOnline && !this.lighting.generatorDestroyed) {
      this.lighting.destroyGenerator();
      this.setGeneratorBeacon(null);
    }
    if (snapshot.generatorOnline && this.lighting.generatorDestroyed) {
      this.lighting.restoreOutpost();
      this.setGeneratorBeacon(0x78ff76, 980);
    }
    if (snapshot.generatorUnstable && !this.lighting.isGeneratorUnstable()) {
      this.lighting.startPowerFailure(snapshot.wave);
    }
    if (snapshot.generatorOnline && !snapshot.generatorUnstable && this.lighting.isGeneratorUnstable()) {
      this.lighting.restoreOutpost();
    }
    this.generatorMarker.setText(snapshot.supplyStatus || (snapshot.generatorOnline ? 'FLARE OUTPUT' : 'OUTPOST GENERATOR  •  OFFLINE'));
    this.generatorMarker.setColor(snapshot.generatorOnline ? '#e4efbd' : '#ed5945');
  }

  private applyNetworkEffect(effect: DuoEffectSnapshot): void {
    if (this.seenNetworkEffectIds.has(effect.id)) return;
    this.seenNetworkEffectIds.add(effect.id);
    if (this.seenNetworkEffectIds.size > 512) {
      const oldest = this.seenNetworkEffectIds.values().next().value;
      if (oldest) this.seenNetworkEffectIds.delete(oldest);
    }
    if ((effect.kind === 'bullet-impact' || effect.kind === 'blood-hit' || effect.kind === 'blood')
      && this.predictedImpacts.some((impact) => Math.abs(this.time.now - impact.at) < 220
        && Phaser.Math.Distance.Between(effect.x, effect.y, impact.x, impact.y) < 30)) {
      return;
    }
    switch (effect.kind) {
      case 'bullet-impact':
        this.playImpactEffect('bullet-impact', effect.x, effect.y, effect.angle);
        break;
      case 'blood-hit':
        this.playImpactEffect('blood-hit', effect.x, effect.y, effect.angle);
        break;
      case 'blood':
        this.makeBlood(effect.x, effect.y, effect.angle, effect.amount ?? 3);
        break;
      case 'blast':
        this.makeBlast(effect.x, effect.y, effect.angle, effect.radius ?? 76, 0, undefined, false);
        break;
      case 'sparks':
        this.makeSparks(effect.x, effect.y, effect.angle, effect.amount ?? 5);
        break;
      case 'boss-shockwave':
        this.makeBossShockwave(effect.x, effect.y, effect.color ?? 0xc83e32);
        break;
      default:
        break;
    }
  }

  private queueNetworkEffect(effect: Omit<DuoEffectSnapshot, 'id'>): void {
    if (!this.isDuo || this.isNetworkClient) return;
    this.networkEffects.push({
      ...effect,
      id: `effect-${this.networkEffectId++}`,
      createdAt: this.time.now,
    });
    if (this.networkEffects.length > 64) this.networkEffects.shift();
  }

  private findNetworkObject(group: any, id: string): any | undefined {
    return group.getChildren().find((object) => object.getData('networkId') === id);
  }

  private createRemoteZombie(snapshot: ZombieSnapshot): any {
    const shadow = this.add.image(snapshot.x + 2, snapshot.y + 3, 'soft-shadow')
      .setDepth(1)
      .setDisplaySize(snapshot.bossKind ? 66 : 38, snapshot.bossKind ? 27 : 16)
      .setAlpha(0.34);
    const aura = snapshot.type === 'charred' || snapshot.bossKind === 'furnace'
      ? this.add.image(snapshot.x, snapshot.y, 'glow')
        .setDepth(16)
        .setScale(snapshot.bossKind ? 0.72 : 0.5)
        .setTint(snapshot.tint)
        .setAlpha(0.2)
        .setBlendMode(Phaser.BlendModes.ADD)
      : undefined;
    const bossDefinition = snapshot.bossKind
      ? BOSS_DEFINITIONS[snapshot.bossKind as BossKind]
      : undefined;
    const bossColor = bossDefinition?.color ?? snapshot.tint;
    const bossHealthTicks = snapshot.bossKind
      ? [1, 2, 3, 4].map((segment) => this.add.rectangle(
        snapshot.x - 28 + segment * 11.2,
        snapshot.y - 45,
        1,
        5,
        0x090706,
        0.9,
      ).setDepth(21))
      : undefined;
    const zombie = this.zombies.create(snapshot.x, snapshot.y, snapshot.textureKey)
      .setDepth(3)
      .setData({
        networkId: snapshot.id,
        textureKey: snapshot.textureKey,
        type: snapshot.type,
        shadow,
        aura,
        bossKind: snapshot.bossKind,
        bossName: snapshot.bossKind
          ? this.add.text(snapshot.x, snapshot.y - 58, BOSS_DEFINITIONS[snapshot.bossKind as BossKind]?.name ?? 'APEX', {
            fontFamily: '"Share Tech Mono", monospace',
            fontSize: '11px',
            color: Phaser.Display.Color.IntegerToColor(bossColor).rgba,
            backgroundColor: '#090706e6',
            padding: { x: 5, y: 2 },
          }).setOrigin(0.5).setDepth(19)
          : undefined,
        bossHealthBack: snapshot.bossKind
          ? this.add.rectangle(snapshot.x, snapshot.y - 45, 60, 6, 0x090706, 0.9)
            .setStrokeStyle(1, 0x3e1714, 0.95).setDepth(19)
          : undefined,
        bossHealthFill: snapshot.bossKind
          ? this.add.rectangle(snapshot.x - 28, snapshot.y - 45, 56, 3, bossColor, 0.95)
            .setOrigin(0, 0.5).setDepth(20)
          : undefined,
        bossHealthTicks,
      });
    zombie.body.enable = false;
    return zombie;
  }

  private updateRemoteZombie(zombie: any, snapshot: ZombieSnapshot): void {
    zombie.setPosition(snapshot.x, snapshot.y)
      .setRotation(snapshot.rotation)
      .setScale(snapshot.scale)
      .setAlpha(snapshot.alpha)
      .setTint(snapshot.tint);
    zombie.setData({
      health: snapshot.health,
      maxHealth: snapshot.maxHealth,
      bossState: snapshot.bossState,
      phase: snapshot.phase,
    });
    zombie.getData('shadow')?.setPosition(snapshot.x + 2, snapshot.y + 3).setRotation(snapshot.rotation);
    zombie.getData('aura')?.setPosition(snapshot.x, snapshot.y);
    const bossKind = snapshot.bossKind as BossKind | undefined;
    const bossDefinition = bossKind ? BOSS_DEFINITIONS[bossKind] : undefined;
    const bossColor = snapshot.phase === 2 ? bossDefinition?.enragedColor : bossDefinition?.color;
    zombie.getData('bossName')?.setPosition(snapshot.x, snapshot.y - 58)
      .setColor(Phaser.Display.Color.IntegerToColor(bossColor ?? snapshot.tint).rgba);
    zombie.getData('bossHealthBack')?.setPosition(snapshot.x, snapshot.y - 45);
    zombie.getData('bossHealthFill')
      ?.setPosition(snapshot.x - 28, snapshot.y - 45)
      .setFillStyle(bossColor ?? snapshot.tint, 0.95)
      .setScale(Phaser.Math.Clamp(snapshot.health / Math.max(1, snapshot.maxHealth), 0, 1), 1);
    zombie.getData('bossHealthTicks')?.forEach((tick: Phaser.GameObjects.Rectangle, index: number) => {
      tick.setPosition(snapshot.x - 28 + (index + 1) * 11.2, snapshot.y - 45);
    });
  }

  private destroyRemoteZombie(zombie: any): void {
    zombie.getData('shadow')?.destroy();
    zombie.getData('aura')?.destroy();
    zombie.getData('bossName')?.destroy();
    zombie.getData('bossHealthBack')?.destroy();
    zombie.getData('bossHealthFill')?.destroy();
    zombie.getData('bossHealthTicks')?.forEach((tick: Phaser.GameObjects.Rectangle) => tick.destroy());
    zombie.destroy();
  }

  private createRemoteBullet(snapshot: BulletSnapshot): any {
    const bullet = this.bullets.get(snapshot.x, snapshot.y, 'bullet')
      ?? this.bullets.create(snapshot.x, snapshot.y, 'bullet');
    if (!bullet) return undefined;
    bullet.enableBody(true, snapshot.x, snapshot.y, true, true);
    bullet.body.enable = false;
    bullet.setDepth(8).setData({
      networkId: snapshot.id,
      ownerId: snapshot.ownerId,
      shotSequence: snapshot.shotSequence,
      authoritative: true,
      remoteAuthoritative: true,
      networkBaseX: snapshot.x,
      networkBaseY: snapshot.y,
      networkRotation: snapshot.rotation,
      networkVelocityX: Math.cos(snapshot.rotation) * BULLET_SPEED,
      networkVelocityY: Math.sin(snapshot.rotation) * BULLET_SPEED,
      networkUpdatedAt: performance.now(),
    });
    const owner = this.actor(snapshot.ownerId);
    if (owner) {
      const angle = snapshot.rotation;
      const muzzleX = owner.sprite.x + Math.cos(angle) * 29;
      const muzzleY = owner.sprite.y + Math.sin(angle) * 29;
      const flash = this.add.image(muzzleX, muzzleY, 'flash')
        .setScale(1.8)
        .setRotation(angle)
        .setDepth(22)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: flash,
        alpha: 0,
        scale: 0.2,
        duration: 75,
        onComplete: () => flash.destroy(),
      });
    }
    return bullet;
  }

  private applyRemoteProps(props: PropSnapshot[]): void {
    const knownProps = new Set(props.map((prop) => prop.id));
    props.forEach((snapshot) => {
      const candidates = [...this.solidProps.getChildren(), ...this.barrels.getChildren()]
        .filter((candidate) => candidate.getData('networkId') === snapshot.id);
      const prop = candidates.find((candidate) => candidate.active) ?? candidates[0];
      if (!prop) return;
      prop.setPosition(snapshot.x, snapshot.y).setRotation(snapshot.rotation);
      prop.setData({ health: snapshot.health, maxHealth: snapshot.maxHealth });
      if (snapshot.kind === 'floodlight') {
        const lightIndex = prop.getData('lightIndex');
        if (snapshot.active) this.lighting.enableLight(lightIndex);
        else this.lighting.disableLight(lightIndex);
      }
      if (snapshot.active) {
        prop.setVisible(true).setAlpha(1);
        prop.enableBody?.(false, snapshot.x, snapshot.y, true, true);
      } else {
        prop.disableBody?.(true, true).setVisible(false);
      }
    });
    [...this.solidProps.getChildren(), ...this.barrels.getChildren()].forEach((prop) => {
      const id = prop.getData('networkId');
      if (id && !knownProps.has(id)) prop.setVisible(false);
    });
  }

  private applySupplySnapshot(supply?: SupplySnapshot): void {
    const cache = supply?.cache;
    if (!cache) {
      if (supply?.state !== 'descending') {
        this.networkSupplyCache?.destroy();
        this.networkSupplyCache = undefined;
        this.networkSupplyLabel?.setVisible(false);
        this.networkSupplyPrompt?.setVisible(false);
        this.networkSupplyLandingZone?.setVisible(false);
      }
    } else {
      if (!this.networkSupplyCache) {
        this.networkSupplyCache = this.add.image(cache.x, cache.y, cache.textureKey).setDepth(3);
      }
      this.networkSupplyCache
        .setPosition(cache.x, cache.y)
        .setTexture(cache.textureKey)
        .setVisible(true);
      this.networkSupplyDrop?.destroy();
      this.networkSupplyDropShadow?.destroy();
      this.networkSupplyDrop = undefined;
      this.networkSupplyDropShadow = undefined;
      this.networkSupplyLabel
        ?.setPosition(cache.x, cache.y + 40)
        .setText(supply?.pickup ? `${String(supply.pickup.kind).toUpperCase()} READY` : 'SUPPLY READY')
        .setVisible(true);
      this.networkSupplyLandingZone?.setPosition(cache.x, cache.y).setVisible(true);
      const local = this.actor(this.localPlayerId);
      const canOpen = supply?.state === 'ready'
        && !!local?.alive
        && Phaser.Math.Distance.Between(local.sprite.x, local.sprite.y, cache.x, cache.y) <= 58;
      this.networkSupplyPrompt
        ?.setPosition(cache.x, cache.y - 48)
        .setVisible(canOpen);
    }

    const pickup = supply?.pickup;
    if (!pickup) {
      this.networkSupplyPickup?.destroy();
      this.networkSupplyGlow?.destroy();
      this.networkSupplyPickup = undefined;
      this.networkSupplyGlow = undefined;
      return;
    }
    const texture = pickup.kind === 'flare'
      ? 'flare-cartridge'
      : pickup.kind === 'repair'
        ? 'repair-kit'
        : pickup.kind === 'adrenaline'
          ? 'adrenaline'
          : 'medkit';
    if (!this.networkSupplyPickup || this.networkSupplyPickup.getData('kind') !== pickup.kind) {
      this.networkSupplyPickup?.destroy();
      this.networkSupplyGlow?.destroy();
      this.networkSupplyPickup = this.add.image(pickup.x, pickup.y, texture)
        .setDepth(3)
        .setData('kind', pickup.kind);
      this.networkSupplyGlow = this.add.image(pickup.x, pickup.y, 'glow')
        .setDepth(16)
        .setScale(0.72)
        .setTint(pickup.kind === 'flare' ? 0xff4a2c : 0x84e996)
        .setAlpha(0.7)
        .setBlendMode(Phaser.BlendModes.ADD);
    }
    this.networkSupplyPickup.setPosition(pickup.x, pickup.y);
    this.networkSupplyGlow?.setPosition(pickup.x, pickup.y);
  }

  private renderRemoteFlareCartridge(payload: Record<string, unknown>, number: (key: string, fallback?: number) => number): void {
    this.clearRemoteFlareCartridge();
    const startX = number('startX', GENERATOR_POSITION.x + 20);
    const startY = number('startY', GENERATOR_POSITION.y + 2);
    const targetX = number('targetX', GENERATOR_POSITION.x + 52);
    const targetY = number('targetY', GENERATOR_POSITION.y + 7);
    const duration = number('duration', 620);
    const shadow = this.add.ellipse(startX, startY + 7, 20, 9, 0x000000, 0.3).setDepth(2).setScale(0.45);
    const glow = this.add.image(startX, startY, 'glow')
      .setDepth(16).setScale(0.38).setAlpha(0.35).setTint(0xff3d24).setBlendMode(Phaser.BlendModes.ADD);
    const cartridge = this.add.image(startX, startY, 'flare-cartridge')
      .setDepth(3).setScale(0.55).setAlpha(0.3).setRotation(-0.55);
    this.networkFlareCartridge = cartridge;
    this.networkFlareCartridgeShadow = shadow;
    this.networkFlareCartridgeGlow = glow;
    this.tweens.add({
      targets: cartridge,
      x: targetX,
      y: targetY,
      scale: 1,
      alpha: 1,
      rotation: 0.18,
      duration,
      ease: 'Back.out',
      onUpdate: () => {
        shadow.setPosition(cartridge.x + 1, cartridge.y + 7).setScale(0.45 + cartridge.scale * 0.55);
        glow.setPosition(cartridge.x, cartridge.y).setScale(0.3 + cartridge.scale * 0.5);
      },
      onComplete: () => {
        if (!cartridge.active) return;
        this.tweens.add({ targets: cartridge, y: targetY - 4, duration: 720, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
        this.tweens.add({ targets: [glow, shadow], alpha: { from: 0.58, to: 0.95 }, duration: 760, yoyo: true, repeat: -1 });
      },
    });
  }

  private clearRemoteFlareCartridge(): void {
    const targets = [this.networkFlareCartridge, this.networkFlareCartridgeShadow, this.networkFlareCartridgeGlow];
    targets.forEach((target) => {
      if (!target) return;
      this.tweens.killTweensOf(target);
      target.destroy();
    });
    this.networkFlareCartridge = undefined;
    this.networkFlareCartridgeShadow = undefined;
    this.networkFlareCartridgeGlow = undefined;
  }

  private renderRemoteFlareLaunch(payload: Record<string, unknown>, number: (key: string, fallback?: number) => number): void {
    this.clearRemoteFlareCartridge();
    const startX = number('startX');
    const startY = number('startY');
    const targetX = number('targetX');
    const airborneY = number('airborneY', number('targetY') - 92);
    const duration = number('duration', 650);
    const angle = Phaser.Math.Angle.Between(startX, startY, targetX, airborneY);
    const projectile = this.add.image(startX, startY, 'flare-cartridge')
      .setDepth(23).setRotation(angle).setScale(1.15);
    const glow = this.add.image(startX, startY, 'glow')
      .setDepth(22).setScale(0.24).setTint(0xff321c).setAlpha(0.75).setBlendMode(Phaser.BlendModes.ADD);
    const trail = this.add.graphics().setDepth(21).setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({
      targets: projectile,
      x: targetX,
      y: airborneY,
      scale: 0.28,
      duration,
      ease: 'Quad.out',
      onUpdate: () => {
        glow.setPosition(projectile.x, projectile.y).setScale(0.2 + projectile.scale * 0.16);
        trail.clear().lineStyle(2, 0xff5933, 0.7).lineBetween(startX, startY, projectile.x, projectile.y);
      },
      onComplete: () => {
        projectile.destroy();
        glow.destroy();
        trail.destroy();
      },
    });
  }

  private renderRemoteSupplyDrop(x: number, y: number, duration: number): void {
    this.networkSupplyDrop?.destroy();
    this.networkSupplyDropShadow?.destroy();
    this.networkSupplyDropShadow = this.add.ellipse(x, y + 7, 38, 18, 0x000000, 0.36).setDepth(1).setScale(0.25);
    this.networkSupplyDrop = this.add.image(x - 54, y - 85, 'supply-cache-closed')
      .setDepth(2).setScale(1.45).setAlpha(0);
    this.tweens.add({
      targets: this.networkSupplyDrop,
      x,
      y,
      scale: 1,
      alpha: 1,
      duration,
      ease: 'Quad.in',
      onUpdate: () => this.networkSupplyDropShadow?.setScale(0.25 + (this.networkSupplyDrop?.scaleX ?? 1) * 0.75),
    });
    this.tweens.add({ targets: this.networkSupplyDropShadow, scale: 1, duration, ease: 'Quad.in' });
  }

  private finishRemoteSupplyDrop(x: number, y: number, textureKey: string): void {
    this.networkSupplyDrop?.destroy();
    this.networkSupplyDropShadow?.destroy();
    this.networkSupplyDrop = undefined;
    this.networkSupplyDropShadow = undefined;
    if (!this.networkSupplyCache) this.networkSupplyCache = this.add.image(x, y, textureKey).setDepth(3);
    this.networkSupplyCache.setPosition(x, y).setTexture(textureKey).setVisible(true);
    this.networkSupplyLabel?.setPosition(x, y + 40).setText('SUPPLY READY').setVisible(true);
  }

  private showRemoteSupplyPickup(kind: string, x: number, y: number): void {
    const texture = kind === 'flare'
      ? 'flare-cartridge'
      : kind === 'repair'
        ? 'repair-kit'
        : kind === 'adrenaline'
          ? 'adrenaline'
          : 'medkit';
    this.networkSupplyCache?.setTexture('supply-cache-open');
    this.networkSupplyLabel?.setText(`${kind.toUpperCase()} READY`).setVisible(true);
    if (!this.networkSupplyPickup || this.networkSupplyPickup.getData('kind') !== kind) {
      this.networkSupplyPickup?.destroy();
      this.networkSupplyGlow?.destroy();
      this.networkSupplyPickup = this.add.image(x, y, texture).setDepth(3).setData('kind', kind);
      this.networkSupplyGlow = this.add.image(x, y, 'glow')
        .setDepth(16).setScale(0.72)
        .setTint(kind === 'flare' ? 0xff4a2c : 0x84e996)
        .setAlpha(0.7).setBlendMode(Phaser.BlendModes.ADD);
    }
    this.networkSupplyPickup.setPosition(x, y);
    this.networkSupplyGlow?.setPosition(x, y);
  }

  private renderRemoteBossWarning(
    payload: Record<string, unknown>,
    number: (key: string, fallback?: number) => number,
    string: (key: string, fallback?: string) => string,
  ): void {
    const style = string('style', 'circle');
    if (style === 'charge') {
      const x = number('x');
      const y = number('y');
      const angle = number('angle');
      const color = number('color', 0xc83e32);
      const duration = number('duration', 900);
      const line = this.add.graphics().setDepth(17);
      line.lineStyle(4, color, 0.3).lineBetween(x, y, x + Math.cos(angle) * 390, y + Math.sin(angle) * 390);
      line.lineStyle(1, 0xffb09a, 0.9).lineBetween(x, y, x + Math.cos(angle) * 390, y + Math.sin(angle) * 390);
      const ring = this.add.circle(x, y, 36, color, 0.08).setStrokeStyle(3, color, 0.9).setDepth(17);
      this.tweens.add({ targets: [line, ring], alpha: 0, duration, onComplete: () => { line.destroy(); ring.destroy(); } });
      return;
    }
    if (style === 'lane') {
      const x = number('x');
      const y = number('y');
      const angle = number('angle');
      const color = number('color', 0xff7028);
      const duration = number('duration', 820);
      const lanes = [angle, angle + Math.PI / 2].map((rotation) => this.add.rectangle(x, y, 380, 38, color, 0.09)
        .setStrokeStyle(2, color, 0.85).setRotation(rotation).setDepth(17));
      this.tweens.add({ targets: lanes, alpha: 0, duration, onComplete: () => lanes.forEach((lane) => lane.destroy()) });
      return;
    }
    if (style === 'rake') {
      const x = number('x');
      const y = number('y');
      const angle = number('angle');
      const color = number('color', 0x9e2728);
      const duration = number('duration', 500);
      const spread = 0.52;
      const distance = 165;
      const warning = this.add.graphics().setDepth(17);
      warning.fillStyle(color, 0.1)
        .fillTriangle(
          x,
          y,
          x + Math.cos(angle - spread) * distance,
          y + Math.sin(angle - spread) * distance,
          x + Math.cos(angle + spread) * distance,
          y + Math.sin(angle + spread) * distance,
        )
        .lineStyle(3, color, 0.9)
        .lineBetween(x, y, x + Math.cos(angle - spread) * distance, y + Math.sin(angle - spread) * distance)
        .lineBetween(x, y, x + Math.cos(angle + spread) * distance, y + Math.sin(angle + spread) * distance);
      this.tweens.add({ targets: warning, alpha: 0, duration, onComplete: () => warning.destroy() });
      return;
    }
    if (style === 'overheat') {
      const x = number('x');
      const y = number('y');
      const color = number('color', 0xff7028);
      const duration = number('duration', 2400);
      const danger = this.add.circle(x, y, number('dangerRadius', 128), color, 0.025)
        .setStrokeStyle(2, color, 0.5).setDepth(17);
      const countdown = this.add.circle(x, y, number('countdownRadius', 92), color, 0.06)
        .setStrokeStyle(3, 0xffc05b, 0.9).setDepth(17);
      this.tweens.add({
        targets: countdown,
        scale: 0.28,
        alpha: 0.2,
        duration,
        ease: 'Quad.in',
      });
      this.tweens.add({
        targets: [danger, countdown],
        alpha: 0,
        delay: duration,
        duration: 120,
        onComplete: () => { danger.destroy(); countdown.destroy(); },
      });
      return;
    }
    if (style === 'spitter-projectile') {
      const startX = number('startX');
      const startY = number('startY');
      const targetX = number('targetX');
      const targetY = number('targetY');
      const duration = number('duration', 460);
      const projectileGlow = this.add.image(0, 0, 'glow')
        .setScale(0.34).setTint(BOSS_DEFINITIONS.spitter.color).setAlpha(0.85)
        .setBlendMode(Phaser.BlendModes.ADD);
      const projectileFire = this.add.sprite(0, 0, 'ground-fire')
        .setScale(0.52).setTint(0xe8da72).setRotation(Phaser.Math.FloatBetween(0, Math.PI * 2));
      projectileFire.play('ground-fire');
      const projectile = this.add.container(startX, startY, [projectileGlow, projectileFire])
        .setDepth(22).setScale(0.55);
      this.tweens.add({
        targets: projectile,
        x: targetX,
        y: targetY,
        scale: 1,
        duration,
        ease: 'Quad.in',
        onComplete: () => {
          projectile.destroy(true);
          this.renderRemoteSpitterPool(targetX, targetY);
        },
      });
      return;
    }
    if (style === 'fire-release') {
      const x = number('x');
      const y = number('y');
      const angle = number('angle');
      const color = number('color', BOSS_DEFINITIONS.furnace.color);
      [angle, angle + Math.PI / 2].forEach((rotation) => {
        for (let distance = -160; distance <= 160; distance += 40) {
          const fire = this.add.sprite(
            x + Math.cos(rotation) * distance,
            y + Math.sin(rotation) * distance,
            'ground-fire',
          ).setDepth(3).setScale(0.9).setTint(color).setRotation(Phaser.Math.FloatBetween(0, Math.PI * 2));
          fire.play('ground-fire');
          this.tweens.add({
            targets: fire,
            alpha: 0,
            scale: 1.15,
            delay: 620,
            duration: 420,
            onComplete: () => fire.destroy(),
          });
        }
      });
      return;
    }
    if (style === 'rake-release') {
      const x = number('x');
      const y = number('y');
      const angle = number('angle');
      const color = number('color', BOSS_DEFINITIONS.lurker.color);
      [-0.32, 0, 0.32].forEach((offset, index) => {
        const slashAngle = angle + offset;
        const slash = this.add.rectangle(
          x + Math.cos(slashAngle) * 82,
          y + Math.sin(slashAngle) * 82,
          164,
          8,
          color,
          0.95,
        ).setRotation(slashAngle).setDepth(23).setBlendMode(Phaser.BlendModes.ADD);
        this.tweens.add({
          targets: slash,
          alpha: 0,
          scaleY: 2.4,
          duration: 240 + index * 45,
          onComplete: () => slash.destroy(),
        });
      });
      return;
    }
    const warning = this.makeBossWarningCircle(
      number('x'),
      number('y'),
      number('radius', 80),
      number('color', 0xc83e32),
      number('duration', 700),
      false,
    );
    this.tweens.add({ targets: warning, alpha: 0, delay: number('duration', 700), duration: 120, onComplete: () => warning.destroy() });
  }

  private renderRemoteSpitterPool(x: number, y: number): void {
    const color = BOSS_DEFINITIONS.spitter.color;
    const pool = this.add.sprite(x, y, 'ground-fire')
      .setDepth(2).setScale(0.55).setTint(0xe8da72).setAlpha(0.95)
      .setRotation(Phaser.Math.FloatBetween(0, Math.PI * 2));
    pool.play('ground-fire');
    const glow = this.add.image(x, y, 'glow')
      .setDepth(15).setScale(0.7).setTint(color).setAlpha(0.28)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: pool, scale: 1.35, duration: 260, ease: 'Back.out' });
    this.tweens.add({ targets: glow, alpha: { from: 0.18, to: 0.38 }, duration: 420, yoyo: true, repeat: -1 });
    this.time.delayedCall(5200, () => {
      this.tweens.add({
        targets: [pool, glow],
        alpha: 0,
        duration: 300,
        onComplete: () => { pool.destroy(); glow.destroy(); },
      });
    });
  }

  makeTextures() {
    // Generated textures live across scene restarts.
    if (this.textures.exists('bullet')) return;

    const g = new Phaser.GameObjects.Graphics(this);

    g.fillStyle(0xfff3b0).fillRect(0, 1, 8, 3);
    g.fillStyle(0xffad32).fillRect(0, 2, 5, 1);
    g.generateTexture('bullet', 8, 5).clear();

    g.fillStyle(0xe9b949).fillRect(0, 0, 4, 2);
    g.generateTexture('casing', 4, 2).clear();

    g.fillStyle(0xffffff).fillRect(2, 0, 3, 7).fillRect(0, 2, 7, 3);
    g.fillStyle(0xffcf4b).fillRect(2, 2, 3, 3);
    g.generateTexture('flash', 7, 7).clear();

    g.fillStyle(0x8b211e).fillRect(2, 0, 3, 2).fillRect(0, 2, 7, 4).fillRect(2, 6, 4, 2);
    g.fillStyle(0x4b1514).fillRect(2, 3, 5, 3);
    g.generateTexture('blood', 8, 8).clear();

    g.fillStyle(0xbca77e).fillRect(0, 0, 2, 2);
    g.generateTexture('dust', 2, 2).destroy();

    const glow = this.textures.createCanvas('glow', 128, 128)!;
    const context = glow.getContext();
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,213,107,0.34)');
    gradient.addColorStop(0.35, 'rgba(255,153,56,0.11)');
    gradient.addColorStop(1, 'rgba(255,110,20,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    glow.refresh();

    const statusVignette = this.textures.createCanvas('status-vignette', WIDTH, HEIGHT)!;
    const statusContext = statusVignette.getContext();
    const statusGradient = statusContext.createRadialGradient(
      WIDTH / 2,
      HEIGHT / 2,
      105,
      WIDTH / 2,
      HEIGHT / 2,
      515,
    );
    statusGradient.addColorStop(0, 'rgba(255,255,255,0)');
    statusGradient.addColorStop(0.52, 'rgba(255,255,255,0)');
    statusGradient.addColorStop(0.78, 'rgba(255,255,255,0.28)');
    statusGradient.addColorStop(1, 'rgba(255,255,255,0.9)');
    statusContext.fillStyle = statusGradient;
    statusContext.fillRect(0, 0, WIDTH, HEIGHT);
    statusVignette.refresh();

    const softShadow = this.textures.createCanvas('soft-shadow', 64, 32)!;
    const shadowContext = softShadow.getContext();
    shadowContext.save();
    shadowContext.scale(1, 0.5);
    const shadowGradient = shadowContext.createRadialGradient(32, 32, 3, 32, 32, 30);
    shadowGradient.addColorStop(0, 'rgba(0,0,0,0.62)');
    shadowGradient.addColorStop(0.48, 'rgba(0,0,0,0.4)');
    shadowGradient.addColorStop(0.78, 'rgba(0,0,0,0.13)');
    shadowGradient.addColorStop(1, 'rgba(0,0,0,0)');
    shadowContext.fillStyle = shadowGradient;
    shadowContext.fillRect(2, 2, 60, 60);
    shadowContext.restore();
    softShadow.refresh();

    const projectedShadow = this.textures.createCanvas('projected-shadow', 192, 64)!;
    const projectedContext = projectedShadow.getContext();
    const projectedPixels = projectedContext.createImageData(192, 64);
    const smoothstep = (start: number, end: number, value: number) => {
      const amount = Phaser.Math.Clamp((value - start) / (end - start), 0, 1);
      return amount * amount * (3 - 2 * amount);
    };
    for (let pixelY = 0; pixelY < 64; pixelY += 1) {
      for (let pixelX = 0; pixelX < 192; pixelX += 1) {
        const progress = pixelX / 191;
        const halfWidth = 10 + progress * 15;
        const edgeDistance = Math.abs(pixelY - 31.5) / halfWidth;
        const edgeFade = Math.exp(-Math.pow(edgeDistance * 1.65, 2));
        const lengthFade = Math.pow(1 - progress, 1.05);
        const startRound = smoothstep(0, 0.055, progress);
        const alpha = Math.round(190 * edgeFade * lengthFade * startRound);
        const offset = (pixelY * 192 + pixelX) * 4;
        projectedPixels.data[offset + 3] = alpha;
      }
    }
    projectedContext.putImageData(projectedPixels, 0, 0);
    projectedShadow.refresh();

    const flareColorMask = this.textures.createCanvas('flare-color-mask', 512, 512)!;
    const flareContext = flareColorMask.getContext();
    const flareGradient = flareContext.createRadialGradient(256, 256, 0, 256, 256, 256);
    flareGradient.addColorStop(0, 'rgba(255,255,248,1)');
    flareGradient.addColorStop(0.035, 'rgba(255,250,232,1)');
    flareGradient.addColorStop(0.07, 'rgba(255,148,104,0.98)');
    flareGradient.addColorStop(0.12, 'rgba(255,35,24,0.9)');
    flareGradient.addColorStop(0.4, 'rgba(204,5,22,0.68)');
    flareGradient.addColorStop(0.7, 'rgba(106,0,20,0.42)');
    flareGradient.addColorStop(0.9, 'rgba(52,0,13,0.14)');
    flareGradient.addColorStop(1, 'rgba(32,0,9,0)');
    flareContext.fillStyle = flareGradient;
    flareContext.fillRect(0, 0, 512, 512);
    flareColorMask.refresh();

    const lightMask = this.textures.createCanvas('light-mask', 256, 256)!;
    const maskContext = lightMask.getContext();
    const maskGradient = maskContext.createRadialGradient(128, 128, 0, 128, 128, 128);
    maskGradient.addColorStop(0, 'rgba(255,255,255,1)');
    maskGradient.addColorStop(0.42, 'rgba(255,255,255,0.82)');
    maskGradient.addColorStop(0.72, 'rgba(255,255,255,0.28)');
    maskGradient.addColorStop(1, 'rgba(255,255,255,0)');
    maskContext.fillStyle = maskGradient;
    maskContext.fillRect(0, 0, 256, 256);
    lightMask.refresh();

    // A continuous directional falloff avoids visible nested-cone bands.
    const beamMask = this.textures.createCanvas('beam-mask', 512, 512)!;
    const beamContext = beamMask.getContext();
    const beamPixels = beamContext.createImageData(512, 512);
    const sourceX = 40;
    const sourceY = 256;
    const beamSmoothstep = (start: number, end: number, value: number) => {
      const amount = Phaser.Math.Clamp((value - start) / (end - start), 0, 1);
      return amount * amount * (3 - 2 * amount);
    };
    for (let pixelY = 0; pixelY < 512; pixelY += 1) {
      for (let pixelX = 0; pixelX < 512; pixelX += 1) {
        const dx = pixelX - sourceX;
        const dy = pixelY - sourceY;
        const distance = Math.hypot(dx, dy);
        const angle = Math.abs(Math.atan2(dy, Math.max(dx, 0.001)));
        const distanceFade = 1 - beamSmoothstep(24, 445, distance);
        const edgeFade = dx > 0 ? 1 - beamSmoothstep(0.08, 0.42, angle) : 0;
        const alpha = Math.round(255 * Math.pow(distanceFade * edgeFade, 1.35));
        const offset = (pixelY * 512 + pixelX) * 4;
        beamPixels.data[offset] = 255;
        beamPixels.data[offset + 1] = 255;
        beamPixels.data[offset + 2] = 255;
        beamPixels.data[offset + 3] = alpha;
      }
    }
    beamContext.putImageData(beamPixels, 0, 0);
    beamMask.refresh();
  }

  makeArena() {
    const groundKeys = ['ground-a', 'ground-b', 'ground-c', 'ground-d'];
    const groundRandom = new Phaser.Math.RandomDataGenerator(['wasteland-arena']);
    const columns = Math.ceil(WIDTH / 64);
    const rows = Math.ceil(HEIGHT / 64);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        this.add.image(column * 64 + 32, row * 64 + 32, groundRandom.pick(groundKeys))
          .setFlip(groundRandom.integerInRange(0, 1) === 1, groundRandom.integerInRange(0, 1) === 1)
          .setDepth(-20);
      }
    }

    const marks = this.add.graphics().setDepth(-19);
    marks.lineStyle(2, 0x5e4a32, 0.55).strokeRect(11, 11, WIDTH - 22, HEIGHT - 22);
    marks.lineStyle(1, 0x1c130d, 0.75).strokeRect(15, 15, WIDTH - 30, HEIGHT - 30);

    // Faded range markings provide movement reference without obscuring the ground art.
    marks.lineStyle(2, 0xc2a36f, 0.1);
    marks.strokeCircle(WIDTH / 2, HEIGHT / 2, 116);
    marks.lineBetween(WIDTH / 2 - 140, HEIGHT / 2, WIDTH / 2 + 140, HEIGHT / 2);
    marks.lineBetween(WIDTH / 2, HEIGHT / 2 - 140, WIDTH / 2, HEIGHT / 2 + 140);

    this.add.rectangle(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, 0x0e0906, 0.1).setDepth(13);
  }

  makeActors() {
    this.bullets = this.physics.add.group({ classType: Phaser.Physics.Arcade.Image, maxSize: 80 });
    this.zombies = this.physics.add.group();

    const positions: Record<DuoPlayerId, { x: number; y: number }> = {
      host: this.isDuo ? { x: WIDTH / 2 - 28, y: HEIGHT / 2 } : { x: WIDTH / 2, y: HEIGHT / 2 },
      guest: { x: WIDTH / 2 + 28, y: HEIGHT / 2 },
    };
    const callsigns: Record<DuoPlayerId, string> = this.duoOptions
      ? {
        host: this.duoOptions.role === 'host' ? this.duoOptions.callsign : this.duoOptions.partnerCallsign,
        guest: this.duoOptions.role === 'guest' ? this.duoOptions.callsign : this.duoOptions.partnerCallsign,
      }
      : { host: this.launchOptions.callsign, guest: '' };
    const skinIds: Record<DuoPlayerId, string> = this.duoOptions
      ? {
        host: this.duoOptions.role === 'host' ? this.duoOptions.skinId : this.duoOptions.partnerSkinId,
        guest: this.duoOptions.role === 'guest' ? this.duoOptions.skinId : this.duoOptions.partnerSkinId,
      }
      : { host: this.launchOptions.skinId, guest: '' };
    const ids: DuoPlayerId[] = this.isDuo ? ['host', 'guest'] : ['host'];
    ids.forEach((id) => {
      const actor = this.createPlayerActor(id, positions[id], callsigns[id], skinIds[id]);
      this.playerActors.set(id, actor);
    });

    const local = this.playerActors.get(this.localPlayerId) ?? this.playerActors.get('host')!;
    this.player = local.sprite;
    this.playerShadow = local.shadow;
    this.playerGlow = local.glow;

    this.tracers = this.add.graphics().setDepth(18).setBlendMode(Phaser.BlendModes.ADD);
  }

  private createPlayerActor(
    id: DuoPlayerId,
    position: { x: number; y: number },
    callsign: string,
    skinId: string,
  ): PlayerActor {
    const skin = getPlayerSkin(skinId, callsign);
    const resolvedSkinId = skin.id;
    const color = skin.color;
    const shadow = this.add.image(position.x + 2, position.y + 3, 'soft-shadow')
      .setDisplaySize(36, 18)
      .setAlpha(0.72)
      .setDepth(1);
    const glow = this.add.image(position.x, position.y, 'glow')
      .setScale(0.85)
      .setAlpha(this.isDuo ? 0.24 : 0.38)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(16);
    // Move the sprite origin to the existing collision center in the 64px texture.
    const sprite = this.physics.add.sprite(position.x, position.y, skin.textureKey)
      .setOrigin(PLAYER_PIVOT_X, PLAYER_PIVOT_Y)
      .setDepth(4);
    sprite.setCollideWorldBounds(true).setData('playerId', id);
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.setCircle(PLAYER_COLLISION_RADIUS, PLAYER_COLLISION_OFFSET_X, PLAYER_COLLISION_OFFSET_Y);
    body.updateFromGameObject();
    body.setMaxVelocity(PLAYER_SPEED);
    return {
      id,
      callsign,
      skinId: resolvedSkinId,
      color,
      sprite,
      shadow,
      glow,
      health: 100,
      alive: true,
      aim: -Math.PI / 2,
      flareCharges: 0,
      knockbackUntil: 0,
      knockbackDuration: 0,
      knockbackVelocity: new Phaser.Math.Vector2(),
      targetLockedUntil: 0,
      invulnerableUntil: 0,
      adrenalineUntil: 0,
      lastShot: -Infinity,
      lastFlare: false,
      lastInteract: false,
    };
  }

  private applyActorSkin(actor: PlayerActor, skinId: string | undefined, callsign: string, fallbackColor?: number): void {
    if (!this.isDuo) return;
    const skin = getPlayerSkin(skinId, callsign);
    if (actor.skinId !== skin.id || actor.sprite.texture.key !== skin.textureKey) {
      actor.sprite.setTexture(skin.textureKey);
    }
    actor.skinId = skin.id;
    actor.color = skin.color;
    actor.glow.setTint(skin.color);
    actor.ring?.setFillStyle(skin.color, 0.035).setStrokeStyle(2, skin.color, actor.alive ? 0.82 : 0.3);
    actor.healthBack?.setStrokeStyle(1, skin.color, 0.65);
    actor.healthBar?.setFillStyle(actor.health <= 35 ? 0xd4513f : skin.color, actor.alive ? 0.9 : 0.35);
    actor.nameLabel?.setColor(Phaser.Display.Color.IntegerToColor(skin.color).rgba);
    if (fallbackColor !== undefined && !skinId) actor.color = fallbackColor;
  }

  makeEnvironment() {
    this.solidProps = this.physics.add.staticGroup();
    this.barrels = this.physics.add.staticGroup();
    this.trees = [];
    this.floodlightPositions = [
      { x: 285, y: 170 },
      { x: 675, y: 170 },
      { x: 285, y: 370 },
      { x: 675, y: 370 },
    ];

    const addShadow = (x, y, key, rotation = 0, alpha = 0.25) => this.add.image(x + 3, y + 4, key)
      .setDepth(1)
      .setRotation(rotation)
      .setTintFill(0x000000)
      .setAlpha(alpha);

    const addSolid = (x, y, key, width, height, rotation = 0, health = 0) => {
      const prop = this.solidProps.create(x, y, key).setDepth(2).setRotation(rotation);
      prop.refreshBody();
      prop.body.setSize(width, height, false);
      this.centerStaticBody(prop.body, x, y);
      prop.setData({
        networkId: `prop-${this.networkId++}`,
        health,
        maxHealth: health,
        shadow: addShadow(x, y, key, rotation),
      });
      return prop;
    };

    const generator = addSolid(
      GENERATOR_POSITION.x,
      GENERATOR_POSITION.y,
      'generator',
      48,
      36,
      0,
      7,
    ).setData('kind', 'generator');
    this.generatorBeacon = this.add.image(350, 280, 'glow')
      .setDepth(16)
      .setScale(0.3)
      .setAlpha(0.18)
      .setTint(0x78ff76)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.generatorBeaconLight = this.add.circle(350, 280, 2, 0xb6ff96, 0.95).setDepth(17);
    this.setGeneratorBeacon(0x78ff76, 980);
    this.generatorMarker = this.add.text(GENERATOR_POSITION.x, 307, 'FLARE OUTPUT', {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '11px',
      color: '#e4efbd',
      backgroundColor: '#081008e8',
      padding: { x: 6, y: 3 },
    }).setOrigin(0.5).setDepth(18).setAlpha(0.92);
    generator.setData({ kind: 'generator', marker: this.generatorMarker });

    [[390, 170, 0, 52, 12], [446, 170, 0, 52, 12], [514, 370, 0, 52, 12], [570, 370, 0, 52, 12],
      [285, 246, Math.PI / 2, 12, 52], [675, 294, Math.PI / 2, 12, 52]].forEach(([x, y, rotation, width, height]) => {
      addSolid(x, y, 'sandbags', width, height, rotation, 3)
        .setData({ kind: 'sandbag', bulletPassThrough: true });
    });

    this.floodlightPositions.forEach(({ x, y }, index) => {
      const rotation = Phaser.Math.Angle.Between(x, y, WIDTH / 2, HEIGHT / 2) + Math.PI / 2;
      const floodlight = addSolid(x, y, 'floodlight', 18, 18, rotation, 3);
      const bodyX = x + Math.sin(rotation) * 7;
      const bodyY = y - Math.cos(rotation) * 7;
      floodlight.body.setCircle(9, 0, 0);
      this.centerStaticBody(floodlight.body, bodyX, bodyY);
      floodlight.setData({ kind: 'floodlight', lightIndex: index });
    });

    // Decorative trees sit just inside the playable bounds. Their raised canopies
    // conceal edge spawns without creating an impassable collision wall.
    const forestRandom = new Phaser.Math.RandomDataGenerator(['last-light-forest']);
    const forestEdge: [number, number][] = [
      [38, 18], [142, 12], [252, 20], [365, 13], [478, 18], [590, 12], [704, 20],
      [32, HEIGHT - 17], [137, HEIGHT - 12], [246, HEIGHT - 19], [357, HEIGHT - 13],
      [472, HEIGHT - 18], [585, HEIGHT - 12], [700, HEIGHT - 19], [815, HEIGHT - 13], [930, HEIGHT - 18],
      [17, 70], [12, 180], [19, 292], [13, 405], [18, 510],
      [WIDTH - 18, 185], [WIDTH - 12, 296], [WIDTH - 19, 408], [WIDTH - 14, 512],
    ];
    forestEdge.forEach(([x, y]) => {
      const rotation = forestRandom.realInRange(-0.5, 0.5);
      const scale = forestRandom.realInRange(0.86, 1.08);
      this.add.image(x, y, 'tree-trunk')
        .setDepth(2)
        .setRotation(rotation)
        .setScale(scale)
        .setTint(0x8c826d);
      const canopyShadow = this.add.image(x + 7, y + 9, 'tree-canopy')
        .setDepth(0)
        .setRotation(rotation)
        .setScale(scale)
        .setTintFill(0x000000)
        .setAlpha(0.24);
      const canopy = this.add.image(x, y, 'tree-canopy')
        .setDepth(12)
        .setRotation(rotation)
        .setScale(scale)
        .setAlpha(0.98);
      this.trees.push({ x, y, canopy, canopyShadow });
    });

    this.barrelSlots = [[238, 270], [722, 270], [480, 420]].map(([x, y]) => ({
      x,
      y,
      occupied: true,
      incoming: false,
    }));
    this.barrelSlots.forEach((_, index) => this.createBarrel(index));
    if (!this.isNetworkClient) this.scheduleBarrelDrop(Phaser.Math.Between(30000, 45000));
  }

  private centerStaticBody(body, x: number, y: number): void {
    body.world.staticTree.remove(body);
    body.position.set(x - body.halfWidth, y - body.halfHeight);
    body.offset.set(0, 0);
    body.updateCenter();
    body.world.staticTree.insert(body);
  }

  private createBarrel(slotIndex: number): void {
    const slot = this.barrelSlots[slotIndex];
    const rotation = Phaser.Math.FloatBetween(-0.2, 0.2);
    const barrel = this.barrels.create(slot.x, slot.y, 'barrel').setDepth(2).setRotation(rotation);
    barrel.refreshBody();
    barrel.body.setCircle(21, 0, 0);
    this.centerStaticBody(barrel.body, slot.x, slot.y);
    const shadow = this.add.image(slot.x + 3, slot.y + 4, 'barrel')
      .setDepth(1)
      .setRotation(rotation)
      .setTintFill(0x000000)
      .setAlpha(0.3);
    barrel.setData({
      networkId: `barrel-${slotIndex}`,
      kind: 'barrel',
      health: 2,
      maxHealth: 2,
      shadow,
      exploded: false,
      slotIndex,
    });
    slot.occupied = true;
    slot.incoming = false;
  }

  private scheduleBarrelDrop(delay = Phaser.Math.Between(22000, 38000)): void {
    this.barrelDropEvent?.remove(false);
    this.barrelDropEvent = this.time.delayedCall(delay, () => {
      this.barrelDropEvent = undefined;
      this.tryDropBarrel();
      if (!this.isGameOver) this.scheduleBarrelDrop();
    });
  }

  private tryDropBarrel(): void {
    if (this.isGameOver) return;
    const available = this.barrelSlots
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => !slot.occupied && !slot.incoming);
    if (!available.length) return;

    const { slot, index } = Phaser.Math.RND.pick(available);
    slot.incoming = true;
    const shadow = this.add.ellipse(slot.x, slot.y + 7, 38, 18, 0x000000, 0.36).setDepth(1).setScale(0.25);
    const incoming = this.add.image(slot.x - 54, slot.y - 85, 'barrel')
      .setDepth(2)
      .setScale(1.45)
      .setAlpha(0)
      .setRotation(Phaser.Math.FloatBetween(-0.2, 0.2));
    this.tweens.add({
      targets: incoming,
      x: slot.x,
      y: slot.y,
      scale: 1,
      alpha: 1,
      duration: 1050,
      ease: 'Quad.in',
      onComplete: () => {
        incoming.destroy();
        shadow.destroy();
        if (this.isGameOver) {
          slot.incoming = false;
          return;
        }
        this.createBarrel(index);
        this.makeBarrelLandingImpact(slot.x, slot.y);
      },
    });
    this.tweens.add({ targets: shadow, scale: 1, duration: 1050, ease: 'Quad.in' });
  }

  private makeBarrelLandingImpact(x: number, y: number): void {
    const radius = 58;
    const ring = this.add.circle(x, y, 22, 0xd9a55c, 0.08)
      .setStrokeStyle(3, 0xd9a55c, 0.85)
      .setDepth(17);
    this.tweens.add({
      targets: ring,
      scale: 2.7,
      alpha: 0,
      duration: 260,
      onComplete: () => ring.destroy(),
    });
    this.makeSparks(x, y, -Math.PI / 2, 7);
    this.audio.playNoise(0.16, 0.08, 900);
    this.cameras.main.shake(110, 0.0045);

    this.livingActors().forEach((actor) => {
      const playerDistance = Phaser.Math.Distance.Between(x, y, actor.sprite.x, actor.sprite.y);
      if (playerDistance > radius) return;
      const angle = playerDistance < 1
        ? Phaser.Math.FloatBetween(0, Math.PI * 2)
        : Phaser.Math.Angle.Between(x, y, actor.sprite.x, actor.sprite.y);
      this.applyPlayerKnockback(angle, 250, 220, actor.id);
    });

    this.zombies.getChildren().slice().forEach((zombie) => {
      if (!zombie.active) return;
      const distance = Phaser.Math.Distance.Between(x, y, zombie.x, zombie.y);
      if (distance > radius) return;
      const angle = distance < 1
        ? Phaser.Math.FloatBetween(0, Math.PI * 2)
        : Phaser.Math.Angle.Between(x, y, zombie.x, zombie.y);
      const bossKind = zombie.getData('bossKind') as BossKind | undefined;
      const health = zombie.getData('health') - 1;
      zombie.setData('health', health);
      if (bossKind) {
        const healthFill = zombie.getData('bossHealthFill') as Phaser.GameObjects.Rectangle;
        healthFill.setScale(Phaser.Math.Clamp(health / Math.max(1, zombie.getData('maxHealth')), 0, 1), 1);
        this.maybeEnrageBoss(zombie, health);
      }
      this.makeBlood(zombie.x, zombie.y, angle, bossKind ? 4 : 2);
      if (health <= 0) {
        this.killZombie(zombie, angle);
        return;
      }
      zombie.setVelocity(Math.cos(angle) * (bossKind ? 180 : 270), Math.sin(angle) * (bossKind ? 180 : 270));
      zombie.setData('staggerUntil', this.time.now + 220);
      zombie.setTintFill(0xf0d6ae);
      this.time.delayedCall(70, () => zombie.active && zombie.setTint(zombie.getData('tint')));
    });
  }

  private setGeneratorBeacon(color: number | null, interval = 900): void {
    this.tweens.killTweensOf(this.generatorBeacon);
    this.tweens.killTweensOf(this.generatorBeaconLight);
    if (color === null) {
      this.generatorBeacon.setVisible(false);
      this.generatorBeaconLight.setVisible(false);
      return;
    }

    this.generatorBeacon.setVisible(true).setTint(color);
    this.generatorBeaconLight.setVisible(true).setFillStyle(color);
    this.tweens.add({
      targets: this.generatorBeacon,
      alpha: { from: 0.08, to: 0.4 },
      duration: interval * 0.24,
      hold: interval * 0.18,
      yoyo: true,
      repeat: -1,
      repeatDelay: interval * 0.48,
    });
    this.tweens.add({
      targets: this.generatorBeaconLight,
      alpha: { from: 0.4, to: 1 },
      duration: interval * 0.18,
      hold: interval * 0.18,
      yoyo: true,
      repeat: -1,
      repeatDelay: interval * 0.58,
    });
  }

  private outpostNeedsRepair(): boolean {
    if (this.lighting.needsRepair()) return true;
    return this.solidProps.getChildren().some((prop) => {
      const kind = prop.getData('kind');
      return (kind === 'generator' || kind === 'floodlight' || kind === 'sandbag')
        && (!prop.active || prop.getData('health') < prop.getData('maxHealth'));
    });
  }

  private outpostIntegrity(): number {
    let health = 0;
    let maxHealth = 0;
    this.solidProps.getChildren().forEach((prop) => {
      const kind = prop.getData('kind');
      if (kind !== 'generator' && kind !== 'floodlight' && kind !== 'sandbag') return;
      const maximum = prop.getData('maxHealth');
      maxHealth += maximum;
      health += prop.active ? prop.getData('health') : 0;
    });
    return maxHealth > 0 ? health / maxHealth : 1;
  }

  private repairOutpost(): void {
    this.lighting.restoreOutpost();
    this.solidProps.getChildren().forEach((prop: any) => {
      const kind = prop.getData('kind');
      if (kind !== 'generator' && kind !== 'floodlight' && kind !== 'sandbag') return;

      prop.setData('health', prop.getData('maxHealth'));
      prop.enableBody(false, prop.x, prop.y, true, true);
      prop.setAlpha(1).clearTint().setTintFill(0xb8ff9d);
      const shadow = prop.getData('shadow');
      if (!shadow?.active) {
        prop.setData('shadow', this.add.image(prop.x + 3, prop.y + 4, prop.texture.key)
          .setDepth(1)
          .setRotation(prop.rotation)
          .setTintFill(0x000000)
          .setAlpha(0.25));
      }
      this.time.delayedCall(180, () => prop.active && prop.clearTint());
    });
    this.tweens.killTweensOf(this.generatorMarker);
    this.generatorMarker
      .setText('FLARE OUTPUT')
      .setColor('#e4efbd')
      .setAlpha(0.92);
    this.setGeneratorBeacon(0x78ff76, 980);
    this.generatorWearEvent?.remove(false);
    this.generatorWearEvent = this.time.delayedCall(65000, () => {
      this.generatorWearEvent = undefined;
      if (this.isGameOver) return;
      if (this.startOutpostPowerFailure(this.director.wave)) {
        this.announce('GENERATOR DEGRADING', 'OUTPUT IS COLLAPSING • REPAIR KIT RECOMMENDED');
      }
    });
    this.cameras.main.flash(180, 118, 224, 132, false);
  }

  makeLightingAndAmbience() {
    this.lighting = new LightingSystem(this, this.floodlightPositions, () => this.spawnDust());
    this.lighting.redraw(this.player.x, this.player.y, Math.PI / 2);
  }

  makeInterface() {
    const labelStyle = {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '13px',
      color: '#ad8880',
    };
    this.add.text(24, 20, 'ELIMINATIONS', labelStyle).setDepth(30);
    this.scoreText = this.add.text(22, 31, '00000', {
      fontFamily: '"Changa One", sans-serif',
      fontSize: '34px',
      color: '#f3e7c4',
      stroke: '#0a0d0b',
      strokeThickness: 5,
    }).setDepth(30);

    this.playerActors.forEach((actor) => {
      const color = Phaser.Display.Color.IntegerToColor(actor.color).rgba;
      actor.ring = this.add.circle(actor.sprite.x, actor.sprite.y, 19, actor.color, 0.035)
        .setStrokeStyle(2, actor.color, 0.82)
        .setDepth(2);
      actor.nameLabel = this.add.text(actor.sprite.x, actor.sprite.y - 51, actor.callsign, {
        ...labelStyle,
        fontSize: '10px',
        color,
        backgroundColor: '#080b09e6',
        padding: { x: 4, y: 2 },
      }).setOrigin(0.5).setDepth(22).setVisible(this.isDuo && actor.id !== this.localPlayerId);
      actor.youLabel = this.add.text(actor.sprite.x, actor.sprite.y - 65, this.isDuo && actor.id === this.localPlayerId ? 'YOU' : '', {
        ...labelStyle,
        fontSize: '9px',
        color: '#e8dfcf',
        backgroundColor: '#080b09dc',
        padding: { x: 3, y: 1 },
      }).setOrigin(0.5).setDepth(22).setVisible(this.isDuo && actor.id === this.localPlayerId);
      actor.healthBack = this.add.rectangle(actor.sprite.x, actor.sprite.y - 36, 38, 6, 0x0a0b0a, 0.58)
        .setStrokeStyle(1, actor.color, 0.65)
        .setDepth(20);
      actor.healthBar = this.add.rectangle(actor.sprite.x - 17, actor.sprite.y - 36, 34, 2, actor.color, 0.9)
        .setOrigin(0, 0.5)
        .setDepth(21);
    });
    const localActor = this.playerActors.get(this.localPlayerId) ?? this.playerActors.get('host')!;
    this.healthBack = localActor.healthBack!;
    this.healthBar = localActor.healthBar!;
    this.pingText = this.add.text(18, HEIGHT - 18, 'PING  --', {
      ...labelStyle,
      fontSize: '10px',
      color: '#817d76',
      backgroundColor: '#080b09b8',
      padding: { x: 4, y: 2 },
    }).setOrigin(0, 1).setDepth(31).setVisible(this.isDuo);
    if (this.isNetworkClient) {
      this.networkSupplyLandingZone = this.add.graphics({ x: 585, y: 270 })
        .setDepth(2)
        .setAlpha(0.72)
        .setVisible(false);
      this.networkSupplyLandingZone.lineStyle(2, 0xd9e7a0, 0.95).strokeCircle(0, 0, 30);
      this.networkSupplyLandingZone.lineStyle(1, 0x82b96f, 0.72).strokeCircle(0, 0, 36);
      this.networkSupplyLandingZone.lineBetween(-39, 0, -28, 0).lineBetween(28, 0, 39, 0);
      this.networkSupplyLandingZone.lineBetween(0, -39, 0, -28).lineBetween(0, 28, 0, 39);
      this.networkSupplyLabel = this.add.text(585, 310, 'SUPPLY READY', {
        ...labelStyle,
        fontSize: '11px',
        color: '#e4efbd',
        backgroundColor: '#081008e8',
        padding: { x: 6, y: 3 },
      }).setOrigin(0.5).setDepth(18).setVisible(false);
      this.networkSupplyPrompt = this.add.text(585, 222, 'E  OPEN SUPPLY DROP', {
        ...labelStyle,
        fontSize: '13px',
        color: '#f1f4d2',
        backgroundColor: '#071007ee',
        padding: { x: 8, y: 4 },
      }).setOrigin(0.5).setDepth(40).setVisible(false);
      this.networkFlareInventory = this.add.text(WIDTH - 25, 16, 'FLARES  0 / 3  •  F TO LAUNCH', {
        ...labelStyle,
        fontSize: '14px',
        color: '#ff7663',
        backgroundColor: '#090c0acc',
        padding: { x: 7, y: 4 },
      }).setOrigin(1, 0).setDepth(30);
      this.tweens.add({
        targets: [this.networkSupplyLandingZone, this.networkSupplyLabel],
        alpha: { from: 0.64, to: 1 },
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.inOut',
      });
    }
    this.statusVignette = this.add.image(WIDTH / 2, HEIGHT / 2, 'status-vignette')
      .setDepth(24)
      .setTint(0xff642f)
      .setAlpha(0)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.adrenalineText = this.add.text(WIDTH - 25, 96, '', {
      ...labelStyle,
      fontSize: '10px',
      color: '#ff9b57',
      backgroundColor: '#160b08cc',
      padding: { x: 5, y: 2 },
    }).setOrigin(1, 0).setDepth(31).setVisible(false);

    this.waveText = this.add.text(WIDTH / 2, 20, this.isDuo
      ? this.isNetworkClient
        ? 'WAITING FOR HOST TO BEGIN...'
        : this.waitingForPartner
          ? 'WAITING FOR SECOND SURVIVOR...'
          : 'THREAT 01'
      : 'THREAT 01', {
      ...labelStyle,
      color: '#c86759',
    }).setOrigin(0.5, 0).setDepth(30);
    this.helpText = this.add.text(WIDTH / 2, this.touchEnabled ? MOBILE_TOUCH_HINT_Y : HEIGHT - 20,
      this.isDuo
        ? this.touchEnabled
          ? 'TAP LEFT SIDE  MOVE  •  HOLD RIGHT SIDE  AIM  •  PUSH PAST INNER RING  FIRE  •  TOP-RIGHT  PAUSE'
          : 'WASD / ARROWS  MOVE  •  MOUSE  AIM + FIRE  •  F  FLARE  •  E  SUPPLY'
        : this.touchEnabled
          ? 'TAP LEFT SIDE  MOVE  •  HOLD RIGHT SIDE  AIM  •  PUSH PAST INNER RING  FIRE  •  TOP-RIGHT  PAUSE'
          : 'WASD / ARROWS  MOVE  •  MOUSE  AIM + FIRE  •  P / ESC  PAUSE', {
      ...labelStyle,
      ...(this.touchEnabled ? { fontSize: '10px' } : {}),
      color: '#c9b8ad',
      backgroundColor: '#0b0e0ccc',
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5, 1).setDepth(30);
    this.tweens.add({ targets: this.helpText, alpha: 0, delay: 7600, duration: 1200 });

    this.crosshair = this.add.graphics().setDepth(40).setVisible(!this.touchEnabled);
    this.crosshair.lineStyle(1, 0xf3dc95, 0.9);
    this.crosshair.strokeCircle(0, 0, 7);
    this.crosshair.lineBetween(-11, 0, -5, 0).lineBetween(5, 0, 11, 0);
    this.crosshair.lineBetween(0, -11, 0, -5).lineBetween(0, 5, 0, 11);

    this.aimLaser = this.add.graphics()
      .setDepth(19)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setVisible(this.touchEnabled);

    if (import.meta.env.DEV) {
      this.debugText = this.add.text(
        WIDTH - 18,
        HEIGHT - 16,
        'DEV  F2 COLLISIONS  •  F3 BREAKER  •  F4 LURKER  •  F5 FURNACE  •  F6 SPITTER',
        {
          ...labelStyle,
          fontSize: '11px',
          color: '#5dffad',
          backgroundColor: '#07110ccc',
          padding: { x: 6, y: 3 },
        },
      ).setOrigin(1, 1).setDepth(70).setVisible(false);
    }

    const pauseShade = this.add.rectangle(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, 0x050303, 0.88).setInteractive();
    const pausePanel = this.add.rectangle(WIDTH / 2, HEIGHT / 2, 500, 390, 0x0c0d0c, 0.97)
      .setStrokeStyle(3, 0x8d2f27, 0.95);
    const pauseInner = this.add.rectangle(WIDTH / 2, HEIGHT / 2, 484, 374)
      .setStrokeStyle(1, 0x4c211d, 0.95);
    const pauseAccent = this.add.rectangle(WIDTH / 2, HEIGHT / 2 - 187, 484, 5, 0xc44636, 0.95);
    const pauseRule = this.add.rectangle(WIDTH / 2, HEIGHT / 2 - 92, 390, 2, 0x7d2b24, 0.85);
    this.pauseStatusText = this.add.text(WIDTH / 2, HEIGHT / 2 - 162, 'FIELD OPERATIONS // SUSPENDED', {
      ...labelStyle,
      fontSize: '11px',
      color: '#d04d3d',
    }).setOrigin(0.5);
    this.pauseTitleText = this.add.text(WIDTH / 2, HEIGHT / 2 - 128, 'PAUSED', {
      fontFamily: '"Changa One", sans-serif',
      fontSize: '52px',
      color: '#e8dfcf',
      stroke: '#4f1714',
      strokeThickness: 7,
    }).setOrigin(0.5);
    const pauseControls = this.add.text(WIDTH / 2, HEIGHT / 2 - 31,
      this.touchEnabled
        ? 'MOVE       TAP LEFT SIDE\nAIM        HOLD RIGHT SIDE\nFIRE       PUSH PAST INNER RING\nFLARE      FLARE BUTTON\nINTERACT   OPEN BUTTON'
        : 'MOVE       WASD / ARROWS\nAIM        MOUSE\nFIRE       LEFT MOUSE\nFLARE      F\nINTERACT   E', {
        ...labelStyle,
        fontSize: '15px',
        color: '#d4c9b8',
        lineSpacing: 7,
      }).setOrigin(0.5);
    const pauseResumeButton = this.makeOverlayButton(
      WIDTH / 2 - 106,
      HEIGHT / 2 + 93,
      196,
      this.isNetworkClient ? 'WAITING FOR HOST' : 'RESUME',
      true,
      () => this.togglePause(),
      !this.isNetworkClient,
    );
    const pauseMenuButton = this.makeOverlayButton(
      WIDTH / 2 + 106,
      HEIGHT / 2 + 93,
      196,
      'MAIN MENU',
      false,
      () => this.returnToMenu(),
    );
    const pauseShortcut = this.add.text(
      WIDTH / 2,
      HEIGHT / 2 + 160,
      this.isNetworkClient ? 'HOST CONTROLLED  //  WAIT FOR RESUME' : 'P / ESC  RESUME FIELD OPERATIONS',
      {
        ...labelStyle,
        ...(this.touchEnabled ? { fontSize: '11px' } : {}),
        color: '#81766f',
      },
    ).setOrigin(0.5);
    this.pauseMenu = this.add.container(0, 0, [
      pauseShade,
      pausePanel,
      pauseInner,
      pauseAccent,
      pauseRule,
      this.pauseStatusText,
      this.pauseTitleText,
      pauseControls,
      ...pauseResumeButton,
      ...pauseMenuButton,
      pauseShortcut,
    ]).setDepth(60).setVisible(false);

    if (this.touchEnabled) {
      window.addEventListener('last-light:mobile-control', this.handleMobileControl);
      window.addEventListener('last-light:mobile-orientation', this.handleMobileOrientation);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        window.removeEventListener('last-light:mobile-control', this.handleMobileControl);
        window.removeEventListener('last-light:mobile-orientation', this.handleMobileOrientation);
      });
      this.handleMobileOrientation(new CustomEvent('last-light:mobile-orientation', {
        detail: {
          portrait: isMobilePortraitViewport(),
        },
      }));
      window.dispatchEvent(new CustomEvent('last-light:mobile-visibility', {
        detail: { visible: !this.isPaused },
      }));
    }
  }

  private makeOverlayButton(
    x: number,
    y: number,
    width: number,
    text: string,
    primary: boolean,
    action: () => void,
    enabled = true,
  ): Phaser.GameObjects.GameObject[] {
    const restingFill = primary ? 0x9d3027 : 0x151413;
    const hoverFill = primary ? 0xc44636 : 0x2a1a18;
    const button = this.add.rectangle(x, y, width, 44, restingFill, 1)
      .setStrokeStyle(2, primary ? 0xe26954 : 0x71312a, 1)
      .setInteractive({ useHandCursor: enabled });
    const label = this.add.text(x, y, text, {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '16px',
      color: primary ? '#fff0dc' : '#d8cdc0',
    }).setOrigin(0.5);

    if (enabled) {
      button.on('pointerover', () => button.setFillStyle(hoverFill));
      button.on('pointerout', () => button.setFillStyle(restingFill));
      button.on('pointerup', action);
    } else {
      button.disableInteractive();
      button.setFillStyle(0x171615).setStrokeStyle(2, 0x423a35, 1);
      label.setColor('#81766f');
    }
    return [button, label];
  }

  private returnToMenu(): void {
    if (!this.isGameOver && !this.isDuo) {
      window.dispatchEvent(new CustomEvent('last-light:game-over', {
        detail: {
          score: this.score,
          survivalMs: this.getSurvivalMs(),
          threat: this.director?.wave ?? this.networkWave,
          runId: this.runId,
        },
      }));
    }
    window.dispatchEvent(new CustomEvent('last-light:return-menu'));
  }

  bindControls() {
    this.keys = this.input.keyboard!.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      upAlt: Phaser.Input.Keyboard.KeyCodes.UP,
      downAlt: Phaser.Input.Keyboard.KeyCodes.DOWN,
      leftAlt: Phaser.Input.Keyboard.KeyCodes.LEFT,
      rightAlt: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      pause: Phaser.Input.Keyboard.KeyCodes.P,
      pauseAlt: Phaser.Input.Keyboard.KeyCodes.ESC,
      flare: Phaser.Input.Keyboard.KeyCodes.F,
      interact: Phaser.Input.Keyboard.KeyCodes.E,
      ...(import.meta.env.DEV ? {
        debug: Phaser.Input.Keyboard.KeyCodes.F2,
        spawnBreaker: Phaser.Input.Keyboard.KeyCodes.F3,
        spawnLurker: Phaser.Input.Keyboard.KeyCodes.F4,
        spawnFurnace: Phaser.Input.Keyboard.KeyCodes.F5,
        spawnSpitter: Phaser.Input.Keyboard.KeyCodes.F6,
      } : {}),
    }) as unknown as Controls;
    if (import.meta.env.DEV) {
      this.input.keyboard!.addCapture([
        Phaser.Input.Keyboard.KeyCodes.F2,
        Phaser.Input.Keyboard.KeyCodes.F3,
        Phaser.Input.Keyboard.KeyCodes.F4,
        Phaser.Input.Keyboard.KeyCodes.F5,
        Phaser.Input.Keyboard.KeyCodes.F6,
      ]);
    }
    this.input.mouse?.disableContextMenu();
  }

  private currentAimAngle(): number {
    const pointer = this.input.activePointer;
    if (this.touchEnabled) {
      return Math.atan2(this.touchAimVector.y, this.touchAimVector.x);
    }
    return Phaser.Math.Angle.Between(this.player.x, this.player.y, pointer.worldX, pointer.worldY);
  }

  private updateMobileControlState(time: number): void {
    if (!this.touchEnabled) return;
    const actor = this.actor(this.localPlayerId);
    const canFireFlare = actor?.alive === true && (this.isNetworkClient
      ? actor.flareCharges > 0
      : this.flares.canFire(time));
    window.dispatchEvent(new CustomEvent('last-light:mobile-availability', {
      detail: {
        flare: canFireFlare,
        interact: this.supplies.canInteract(),
      },
    }));
  }

  private findAimLaserEndpoint(angle: number, length: number): TouchVector {
    const line = new Phaser.Geom.Line(
      this.player.x,
      this.player.y,
      this.player.x + Math.cos(angle) * length,
      this.player.y + Math.sin(angle) * length,
    );
    let closestPoint = new Phaser.Geom.Point(line.x2, line.y2);
    let closestDistance = length * length;

    const checkBody = (gameObject: any): void => {
      if (!gameObject?.active || !gameObject.body?.enable || gameObject.getData('bulletPassThrough')) return;
      const body = gameObject.body as Phaser.Physics.Arcade.Body;
      const shape = body.isCircle
        ? new Phaser.Geom.Circle(body.center.x, body.center.y, body.halfWidth)
        : new Phaser.Geom.Rectangle(body.x, body.y, body.width, body.height);
      const intersects = body.isCircle
        ? Phaser.Geom.Intersects.LineToCircle(line, shape as Phaser.Geom.Circle)
        : Phaser.Geom.Intersects.LineToRectangle(line, shape);
      if (!intersects) return;

      const points = body.isCircle
        ? Phaser.Geom.Intersects.GetLineToCircle(line, shape as Phaser.Geom.Circle)
        : Phaser.Geom.Intersects.GetLineToRectangle(line, shape as Phaser.Geom.Rectangle);
      if (!points.length) return;
      const point = points.reduce((nearest, candidate) => (
        Phaser.Math.Distance.Squared(this.player.x, this.player.y, candidate.x, candidate.y)
          < Phaser.Math.Distance.Squared(this.player.x, this.player.y, nearest.x, nearest.y)
          ? candidate
          : nearest
      ));
      const distance = Phaser.Math.Distance.Squared(this.player.x, this.player.y, point.x, point.y);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestPoint = point;
      }
    };

    this.zombies.getChildren().forEach(checkBody);
    this.solidProps.getChildren().forEach(checkBody);
    this.barrels.getChildren().forEach(checkBody);
    return {
      x: closestPoint.x - Math.cos(angle) * 2,
      y: closestPoint.y - Math.sin(angle) * 2,
    };
  }

  togglePause() {
    if (this.isDuo && this.isNetworkClient) return;
    this.isPaused = !this.isPaused;
    this.pauseMenu.setVisible(this.isPaused);
    this.crosshair.setVisible(!this.isPaused && !this.touchEnabled);
    if (this.isDuo) this.duoOptions?.session.sendPause(this.isPaused);
    this.aimLaser.setVisible(!this.isPaused && this.touchEnabled);
    window.dispatchEvent(new CustomEvent('last-light:mobile-visibility', {
      detail: { visible: !this.isPaused && !this.isGameOver },
    }));

    if (this.isPaused) {
      this.pausedAt = this.time.now;
      this.player.setVelocity(0);
      this.physics.world.pause();
      this.time.paused = true;
      this.anims.pauseAll();
      this.tweens.pauseAll();
      this.sound.pauseAll?.();
      this.audio.setPaused(true);
      this.monsterAudio.setPaused(true);
      return;
    }

    this.startedAt += this.time.now - this.pausedAt;
    this.pausedAt = 0;
    this.physics.world.resume();
    this.time.paused = false;
    this.anims.resumeAll();
    this.tweens.resumeAll();
    this.sound.resumeAll?.();
    this.audio.setPaused(false);
    this.monsterAudio.setPaused(false);
  }

  private getSurvivalMs(): number {
    const currentPauseMs = this.isPaused ? this.time.now - this.pausedAt : 0;
    return this.time.now - this.startedAt - currentPauseMs;
  }

  spawnDust() {
    if (this.isGameOver || Phaser.Math.Between(0, 100) < 24) return;
    const dust = this.add.image(-4, Phaser.Math.Between(30, HEIGHT - 30), 'dust')
      .setDepth(18)
      .setAlpha(Phaser.Math.FloatBetween(0.12, 0.34))
      .setScale(Phaser.Math.Between(1, 2));
    this.tweens.add({
      targets: dust,
      x: WIDTH + 8,
      y: dust.y + Phaser.Math.Between(-24, 24),
      alpha: 0,
      duration: Phaser.Math.Between(4200, 7200),
      onComplete: () => dust.destroy(),
    });
  }

  private telegraphHorde(edge: number, replicate = true): void {
    if (this.isGameOver) return;
    if (replicate) this.emitDuoEvent('horde-warning', { edge });
    const warningX = edge === 1 ? WIDTH - 20 : edge === 3 ? 20 : WIDTH / 2;
    const warningY = edge === 0 ? 20 : edge === 2 ? HEIGHT - 20 : HEIGHT / 2;
    if (!this.isNetworkClient || replicate) {
      this.monsterAudio.play('shambler', 'spawn', warningX, warningY, this.player.x, this.player.y);
    }
    for (let i = 0; i < 3; i += 1) {
      const along = Phaser.Math.Between(-95, 95);
      const eyeX = edge === 0 || edge === 2 ? Phaser.Math.Clamp(WIDTH / 2 + along, 50, WIDTH - 50) : warningX;
      const eyeY = edge === 1 || edge === 3 ? Phaser.Math.Clamp(HEIGHT / 2 + along, 50, HEIGHT - 50) : warningY;
      const eyes = this.add.container(eyeX, eyeY, [
        this.add.ellipse(-3, 0, 3, 2, 0xff4a2d, 0.9),
        this.add.ellipse(3, 0, 3, 2, 0xff4a2d, 0.9),
      ]).setDepth(16).setAlpha(0);
      this.tweens.add({
        targets: eyes,
        alpha: 0.85,
        duration: 180,
        yoyo: true,
        hold: 850 + i * 130,
        onComplete: () => eyes.destroy(),
      });
    }
  }

  private telegraphBoss(kind: BossKind, edge: number, replicate = true): void {
    if (this.isGameOver) return;
    if (replicate) this.emitDuoEvent('boss-introduction', { kind, edge });
    const encounterId = this.isNetworkClient ? undefined : this.audio.beginBossTheme(kind);
    const definition = BOSS_DEFINITIONS[kind];
    const warningX = edge === 1 ? WIDTH - 18 : edge === 3 ? 18 : WIDTH / 2;
    const warningY = edge === 0 ? 18 : edge === 2 ? HEIGHT - 18 : HEIGHT / 2;
    const color = Phaser.Display.Color.IntegerToColor(definition.color);
    const glow = this.add.image(warningX, warningY, 'glow')
      .setDepth(16)
      .setTint(definition.color)
      .setScale(0.35)
      .setAlpha(0.8)
      .setBlendMode(Phaser.BlendModes.ADD);
    const ring = this.add.circle(warningX, warningY, 24, definition.color, 0.08)
      .setStrokeStyle(3, definition.color, 0.92)
      .setDepth(17);
    this.tweens.add({
      targets: glow,
      scale: 2.5,
      alpha: 0,
      duration: 1900,
      ease: 'Quad.out',
      onComplete: () => glow.destroy(),
    });
    this.tweens.add({
      targets: ring,
      scale: 2.2,
      alpha: 0,
      duration: 1900,
      ease: 'Quad.out',
      onComplete: () => ring.destroy(),
    });
    this.telegraphHorde(edge, replicate && !this.isNetworkClient);
    if (!this.isNetworkClient || replicate) {
      this.audio.playTone(kind === 'lurker' ? 54 : 42, 1.15, 0.075, 'sawtooth');
      this.audio.playNoise(0.7, 0.045, kind === 'furnace' ? 720 : 480);
    }
    this.cameras.main.flash(90, color.red, color.green, color.blue, false);
    this.cameras.main.shake(260, 0.0045);
    if (!this.isNetworkClient) {
      this.time.delayedCall(2050, () => this.spawnBoss(kind, edge, encounterId!));
    }
  }

  private spawnDebugBoss(kind: BossKind): void {
    if (this.isGameOver) return;
    this.announce('APEX CONTACT', `${BOSS_DEFINITIONS[kind].name} IS ENTERING THE KILL ZONE`);
    this.telegraphBoss(kind, Phaser.Math.Between(0, 3));
  }

  announce(title: string, subtitle: string, replicate = true) {
    if (this.isGameOver) return;
    if (replicate) this.emitDuoEvent('announcement', { title, subtitle });
    this.announcementQueue.push([title, subtitle, !this.isNetworkClient || replicate]);
    if (!this.announcementActive) this.showNextAnnouncement();
  }

  private showNextAnnouncement(): void {
    const message = this.announcementQueue.shift();
    if (!message || this.isGameOver) {
      this.announcementActive = false;
      return;
    }
    this.announcementActive = true;
    const [title, subtitle, playSound] = message;
    if (playSound) this.audio.playAlert();
    const titleText = this.add.text(WIDTH / 2, 57, title, {
      fontFamily: '"Changa One", sans-serif',
      fontSize: '34px',
      color: '#e05d4b',
      stroke: '#130e0b',
      strokeThickness: 6,
    }).setOrigin(0.5).setDepth(45).setAlpha(0).setScale(1.2);
    const subtitleText = this.add.text(WIDTH / 2, 88, subtitle, {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '13px',
      color: '#d4b3a9',
      backgroundColor: '#160b0acc',
      padding: { x: 7, y: 3 },
    }).setOrigin(0.5).setDepth(45).setAlpha(0);
    this.tweens.add({ targets: titleText, alpha: 1, scale: 1, duration: 220, hold: 2500, yoyo: true, onComplete: () => titleText.destroy() });
    this.tweens.add({
      targets: subtitleText,
      alpha: 1,
      duration: 220,
      hold: 2500,
      yoyo: true,
      onComplete: () => {
        subtitleText.destroy();
        this.announcementActive = false;
        this.showNextAnnouncement();
      },
    });
  }

  private startOutpostPowerFailure(wave: number): boolean {
    const started = this.lighting.startPowerFailure(wave);
    if (started) {
      this.generatorWearEvent?.remove(false);
      this.generatorWearEvent = undefined;
      this.setGeneratorBeacon(0xff9f3d, 480);
      this.generatorMarker.setText('UNSTABLE').setColor('#d8a55f');
    }
    return started;
  }

  update(time) {
    const pointer = this.input.activePointer;
    const aimAngle = this.currentAimAngle();
    if (this.touchEnabled) {
      const laserLength = Math.max(WIDTH, HEIGHT);
      const laserEnd = this.findAimLaserEndpoint(aimAngle, laserLength);
      this.aimLaser.clear();
      const laserDistance = Phaser.Math.Distance.Between(this.player.x, this.player.y, laserEnd.x, laserEnd.y);
      const laserSegments = Math.max(1, Math.ceil(laserDistance / 40));
      for (let segment = 0; segment < laserSegments; segment += 1) {
        const start = segment / laserSegments;
        const end = (segment + 1) / laserSegments;
        const fade = 1 - start * 0.94;
        const startX = Phaser.Math.Interpolation.Linear([this.player.x, laserEnd.x], start);
        const startY = Phaser.Math.Interpolation.Linear([this.player.y, laserEnd.y], start);
        const endX = Phaser.Math.Interpolation.Linear([this.player.x, laserEnd.x], end);
        const endY = Phaser.Math.Interpolation.Linear([this.player.y, laserEnd.y], end);
        this.aimLaser
          .lineStyle(4, 0xff2020, 0.06 * fade)
          .lineBetween(startX, startY, endX, endY)
          .lineStyle(1, 0xff3d3d, 0.28 * fade)
          .lineBetween(startX, startY, endX, endY)
          .lineStyle(1, 0xffa0a0, 0.42 * fade)
          .lineBetween(startX, startY, endX, endY);
      }
    } else {
      this.crosshair.setPosition(Math.round(pointer.worldX), Math.round(pointer.worldY));
    }

    if (import.meta.env.DEV && Phaser.Input.Keyboard.JustDown(this.keys.debug!)) {
      const enabled = !this.physics.world.drawDebug;
      this.physics.world.drawDebug = enabled;
      this.debugText!.setVisible(enabled);
      if (!enabled) this.physics.world.debugGraphic.clear();
    }
    if (import.meta.env.DEV) {
      if (Phaser.Input.Keyboard.JustDown(this.keys.spawnBreaker!)) this.spawnDebugBoss('breaker');
      if (Phaser.Input.Keyboard.JustDown(this.keys.spawnLurker!)) this.spawnDebugBoss('lurker');
      if (Phaser.Input.Keyboard.JustDown(this.keys.spawnFurnace!)) this.spawnDebugBoss('furnace');
      if (Phaser.Input.Keyboard.JustDown(this.keys.spawnSpitter!)) this.spawnDebugBoss('spitter');
    }

    if (!this.isGameOver && (
      Phaser.Input.Keyboard.JustDown(this.keys.pause)
      || Phaser.Input.Keyboard.JustDown(this.keys.pauseAlt)
    )) {
      this.togglePause();
    }

    if (this.isPaused) return;

    if (this.networkPaused) {
      this.playerActors.forEach((actor) => actor.sprite.setVelocity(0));
      return;
    }

    if (this.isNetworkClient) {
      if (this.isGameOver) {
        this.player.setVelocity(0);
        return;
      }
      this.updateGuest(time);
      this.updateStatusEffects(time);
      return;
    }

    if (this.isGameOver) {
      this.playerActors.forEach((actor) => actor.sprite.setVelocity(0));
      return;
    }

    const localActor = this.actor(this.localPlayerId)!;
    const keyboardHorizontal = Number(this.keys.right.isDown || this.keys.rightAlt.isDown)
      - Number(this.keys.left.isDown || this.keys.leftAlt.isDown);
    const keyboardVertical = Number(this.keys.down.isDown || this.keys.downAlt.isDown)
      - Number(this.keys.up.isDown || this.keys.upAlt.isDown);
    const horizontal = this.touchMoveActive ? this.touchMove.x : keyboardHorizontal;
    const vertical = this.touchMoveActive ? this.touchMove.y : keyboardVertical;
    const aim = aimAngle;
    this.updateActorMotion(localActor, { moveX: horizontal, moveY: vertical, aim }, time);
    this.health = localActor.health;
    this.supplies.update(time);
    this.flares.update(time, aim);
    this.updateMobileControlState(time);
    this.updateStatusEffects(time);
    this.updateRemoteActor(time);
    this.playerActors.forEach((actor) => this.updateActorDisplay(actor));

    if (localActor.alive && !this.touchEnabled && pointer.isDown
      && time - this.lastShot >= this.supplies.fireInterval(time, localActor.sprite)) {
      this.lastShot = time;
      this.shootForActor(localActor, aim, time);
    }
    if (this.touchEnabled
      && this.touchAimFiring
      && time - this.lastShot >= this.supplies.fireInterval(time)) {
      this.shoot(aim, time);
    }

    this.waveText.setText(this.waitingForPartner
      ? 'WAITING FOR SECOND SURVIVOR...'
      : `THREAT ${String(this.director.wave).padStart(2, '0')}`);
    this.lighting.lowHealthShade.setAlpha(localActor.health <= 35 && localActor.alive
      ? 0.035 + Math.sin(time * 0.006) * 0.025
      : 0);
    this.tracers.clear().lineStyle(2, 0xffd66f, 0.7);

    this.trees.forEach(({ x, y, canopy }) => {
      const targetAlpha = Phaser.Math.Distance.Between(this.player.x, this.player.y, x, y) < 54 ? 0.34 : 0.96;
      canopy.setAlpha(Phaser.Math.Linear(canopy.alpha, targetAlpha, 0.12));
    });

    this.zombies.children.iterate((zombie) => {
      if (!zombie?.active) return;
      const target = this.enemyTarget(zombie, time);
      if (!target) {
        zombie.setVelocity(0);
        return;
      }
      this.withCombatTarget(target, () => {
        if (zombie.getData('bossKind')) {
          this.updateBoss(zombie, time, target);
          return;
        }
        const angle = this.enemyFacingAngle(zombie, target);
        const atContactDistance = this.enemyIsAtContactDistance(zombie, target);
        const crawler = zombie.getData('type') === 'crawler';
        const crawlPulse = crawler ? 0.68 + Math.max(0, Math.sin(zombie.getData('step') * 1.7)) * 0.32 : 1;
        const speed = zombie.getData('speed') * crawlPulse;
        if (time >= zombie.getData('staggerUntil')) {
          if (atContactDistance) zombie.setVelocity(0);
          else zombie.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
        }
        zombie.rotation = angle - SOUTH_OFFSET;
        if (crawler) {
          const bodyRotation = zombie.rotation;
          const bodyWidth = Math.abs(Math.cos(bodyRotation)) * 17 + Math.abs(Math.sin(bodyRotation)) * 10;
          const bodyHeight = Math.abs(Math.sin(bodyRotation)) * 17 + Math.abs(Math.cos(bodyRotation)) * 10;
          const bodyOffsetX = -Math.sin(bodyRotation) * 10;
          const bodyOffsetY = Math.cos(bodyRotation) * 10;
          zombie.body
            .setSize(bodyWidth, bodyHeight, false)
            .setOffset(32 + bodyOffsetX - bodyWidth / 2, 32 + bodyOffsetY - bodyHeight / 2);
        } else {
          const radius = zombie.getData('bodyRadius');
          const offset = zombie.getData('bodyOffset');
          zombie.body.setCircle(
            radius,
            32 - radius - Math.cos(angle) * offset,
            32 - radius - Math.sin(angle) * offset,
          );
        }
        zombie.setData('step', zombie.getData('step') + 0.12);
        const baseScale = zombie.getData('baseScale');
        zombie.setScale(baseScale, crawler ? baseScale : baseScale * (1 + Math.sin(zombie.getData('step')) * 0.025));
        const shadow = zombie.getData('shadow');
        shadow
          ?.setPosition(zombie.x + 2, zombie.y + (crawler ? 10 : 3))
          .setRotation(zombie.rotation);
        zombie.getData('aura')
          ?.setPosition(zombie.x, zombie.y)
          .setAlpha(0.16 + Math.max(0, Math.sin(time * 0.011 + zombie.getData('step'))) * 0.12);
        if (time >= zombie.getData('nextVoiceAt')) {
          this.monsterAudio.play(
            zombie.getData('type') as MonsterType,
            'ambient',
            zombie.x,
            zombie.y,
            this.player.x,
            this.player.y,
          );
          const voiceDelay = zombie.getData('type') === 'runner'
            ? Phaser.Math.Between(2100, 3700)
            : Phaser.Math.Between(2800, 5200);
          zombie.setData('nextVoiceAt', time + voiceDelay);
        }
      });
    });
    this.updateBossHazards(time);

    const emberLights = this.zombies.getChildren()
      .filter((zombie) => zombie.active
        && (zombie.getData('type') === 'charred' || zombie.getData('bossKind') === 'furnace'))
      .map((zombie) => ({ x: zombie.x, y: zombie.y }));
    const lightTarget = this.actor(this.localPlayerId);
    this.lighting.redraw(
      lightTarget?.sprite.x ?? this.player.x,
      lightTarget?.sprite.y ?? this.player.y,
      aim,
      this.collectShadowCasters(),
      emberLights,
      this.playerLightSources(),
    );

    this.bullets.children.iterate((bullet) => {
      if (bullet?.active) {
        bullet.getData('glow')?.setPosition(bullet.x, bullet.y);
        this.tracers.lineBetween(
          bullet.x - Math.cos(bullet.rotation) * 24,
          bullet.y - Math.sin(bullet.rotation) * 24,
          bullet.x,
          bullet.y,
        );
      }
      if (bullet?.active && (bullet.x < -20 || bullet.x > WIDTH + 20 || bullet.y < -20 || bullet.y > HEIGHT + 20)) {
        this.destroyBullet(bullet);
      }
    });
    this.sendHostSnapshot(time);
  }

  private updateBoss(boss: any, time: number, target: PlayerActor): void {
    const kind = boss.getData('bossKind') as BossKind;
    const definition = BOSS_DEFINITIONS[kind];
    const angle = this.enemyFacingAngle(boss, target);
    const distance = Phaser.Math.Distance.Between(boss.x, boss.y, this.player.x, this.player.y);
    const state = boss.getData('bossState');

    if (time < boss.getData('staggerUntil')) {
      // Preserve impact velocity briefly before the boss resumes its current attack state.
    } else if (state === 'enraged') {
      boss.setVelocity(0);
      if (time >= boss.getData('stateUntil')) {
        boss.setData({ bossState: 'pursuit', abilityAt: time + 180 });
      }
    } else if (state === 'pursuit') {
      if (kind === 'spitter') {
        if (distance > 270) {
          this.steerBossAroundObstacles(boss, angle, definition.speed);
        } else if (distance < 165) {
          this.steerBossAroundObstacles(boss, angle + Math.PI, definition.speed * 0.82);
        } else {
          boss.setVelocity(0);
        }
      } else {
        if (this.enemyIsAtContactDistance(boss, target)) boss.setVelocity(0);
        else this.steerBossAroundObstacles(boss, angle, definition.speed);
      }

      if (time >= boss.getData('abilityAt')) {
        this.tryStartBossAbility(boss, kind, angle, distance, time);
      }
    } else if (kind === 'breaker') {
      this.updateBreaker(boss, time);
    } else if (kind === 'lurker') {
      this.updateLurker(boss, time);
    } else if (kind === 'furnace') {
      this.updateFurnace(boss, angle, time);
    } else if (kind === 'spitter') {
      this.updateSpitter(boss, time);
    }

    if (!boss.active) return;
    const attackAngle = boss.getData('bossState') === 'charge' ? boss.getData('attackAngle') : angle;
    boss.rotation = attackAngle - SOUTH_OFFSET;
    boss.setData('step', boss.getData('step') + 0.075);
    if (boss.getData('bossState') !== 'airborne') {
      const pulse = 1 + Math.sin(boss.getData('step')) * (kind === 'lurker' ? 0.018 : 0.01);
      boss.setScale(pulse);
    }

    const shadow = boss.getData('shadow') as Phaser.GameObjects.Image;
    if (boss.getData('bossState') !== 'airborne') {
      shadow?.setPosition(boss.x + 3, boss.y + 6).setRotation(boss.rotation);
    }
    const aura = boss.getData('aura') as Phaser.GameObjects.Image;
    const enraged = boss.getData('phase') === 2;
    const overheatProgress = kind === 'furnace' && boss.getData('bossState') === 'overheat'
      ? Phaser.Math.Clamp(1 - (boss.getData('stateUntil') - time) / boss.getData('abilityDuration'), 0, 1)
      : 0;
    aura
      ?.setPosition(boss.x, boss.y)
      .setScale((kind === 'furnace' ? 0.92 : 0.68) + (enraged ? 0.1 : 0) + overheatProgress * 0.5)
      .setAlpha((kind === 'furnace' ? 0.3 : 0.16)
        + (enraged ? 0.1 : 0)
        + Math.max(0, Math.sin(time * 0.008)) * 0.12
        + overheatProgress * 0.3);

    const name = boss.getData('bossName') as Phaser.GameObjects.Text;
    const healthBack = boss.getData('bossHealthBack') as Phaser.GameObjects.Rectangle;
    const healthFill = boss.getData('bossHealthFill') as Phaser.GameObjects.Rectangle;
    const healthTicks = boss.getData('bossHealthTicks') as Phaser.GameObjects.Rectangle[];
    name?.setPosition(boss.x, boss.y - 58);
    healthBack?.setPosition(boss.x, boss.y - 45);
    healthFill?.setPosition(boss.x - 28, boss.y - 45);
    healthTicks?.forEach((tick, index) => tick.setPosition(boss.x - 28 + (index + 1) * 11.2, boss.y - 45));
    boss.getData('phaseLabel')?.setPosition(boss.x, boss.y - 74);

    if (time >= boss.getData('nextVoiceAt')) {
      this.monsterAudio.play(definition.voice, 'ambient', boss.x, boss.y, this.player.x, this.player.y);
      boss.setData('nextVoiceAt', time + Phaser.Math.Between(1800, 3400));
    }
  }

  private tryStartBossAbility(
    boss: any,
    kind: BossKind,
    angle: number,
    distance: number,
    time: number,
  ): void {
    const secondary = boss.getData('phase') === 2 && boss.getData('secondaryAttackNext');
    let started = false;

    if (secondary) {
      if (kind === 'breaker' && distance < 150) {
        this.beginBreakerSlam(boss, time);
        started = true;
      } else if (kind === 'lurker' && distance < 210) {
        this.beginLurkerRake(boss, angle, time);
        started = true;
      } else if (kind === 'furnace' && distance < 210) {
        this.beginFurnaceFireLanes(boss, angle, time);
        started = true;
      } else if (kind === 'spitter' && distance < 470) {
        this.beginSpitterBurst(boss, angle, time);
        started = true;
      }
    } else if (kind === 'breaker' && distance < 390) {
      this.beginBreakerCharge(boss, angle, time);
      started = true;
    } else if (kind === 'lurker' && distance < 440) {
      this.beginLurkerLeap(boss, time);
      started = true;
    } else if (kind === 'furnace' && distance < 175) {
      this.beginFurnaceOverheat(boss, time);
      started = true;
    } else if (kind === 'spitter' && distance < 470) {
      this.beginSpitterVolley(boss, angle, time);
      started = true;
    }

    if (started && boss.getData('phase') === 2) {
      boss.setData('secondaryAttackNext', !secondary);
    }
  }

  private steerBossAroundObstacles(boss: any, angle: number, speed: number): void {
    const steering = new Phaser.Math.Vector2(Math.cos(angle), Math.sin(angle));
    const obstacles = this.solidProps.getChildren().filter((obstacle: any) => !this.isOutpostProp(obstacle));
    obstacles.forEach((obstacle: any) => {
      if (!obstacle.active || !obstacle.body?.enable) return;
      const dx = boss.x - obstacle.body.center.x;
      const dy = boss.y - obstacle.body.center.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= 0 || distance >= 105) return;
      const influence = (1 - distance / 105) * 2.4;
      steering.add(new Phaser.Math.Vector2(dx / distance, dy / distance).scale(influence));
    });
    if (steering.lengthSq() < 0.05) steering.set(-Math.sin(angle), Math.cos(angle));
    steering.normalize().scale(speed);
    boss.setVelocity(steering.x, steering.y);
  }

  private bossAbilityDelay(kind: BossKind, phase: number): number {
    const ranges: Record<BossKind, [[number, number], [number, number]]> = {
      breaker: [[1730, 2270], [480, 745]],
      lurker: [[1530, 2070], [400, 640]],
      furnace: [[1400, 1870], [345, 560]],
      spitter: [[1200, 1670], [330, 600]],
    };
    const [minimum, maximum] = ranges[kind][phase === 2 ? 1 : 0];
    return Phaser.Math.Between(minimum, maximum);
  }

  private bossPhaseColor(boss: any): number {
    const definition = BOSS_DEFINITIONS[boss.getData('bossKind') as BossKind];
    return boss.getData('phase') === 2 ? definition.enragedColor : definition.color;
  }

  private maybeEnrageBoss(boss: any, health: number): void {
    const kind = boss.getData('bossKind') as BossKind | undefined;
    if (!kind || health <= 0 || boss.getData('phase') === 2 || health > boss.getData('maxHealth') * 0.5) return;

    const definition = BOSS_DEFINITIONS[kind];
    boss.setData({ phase: 2, secondaryAttackNext: true }).getData('aura')?.setTint(definition.enragedColor);
    this.announce(`${definition.name} // PHASE II`, 'ENRAGED CONTACT // DAMAGE WINDOW NARROWED');
    if (boss.getData('bossState') !== 'airborne') {
      this.clearBossTelegraphs(boss);
      boss.setVelocity(0).setData({ bossState: 'enraged', stateUntil: this.time.now + 1150 });
    }

    const name = boss.getData('bossName') as Phaser.GameObjects.Text;
    const healthBack = boss.getData('bossHealthBack') as Phaser.GameObjects.Rectangle;
    const healthFill = boss.getData('bossHealthFill') as Phaser.GameObjects.Rectangle;
    const healthTicks = boss.getData('bossHealthTicks') as Phaser.GameObjects.Rectangle[];
    name.setColor(Phaser.Display.Color.IntegerToColor(definition.enragedColor).rgba);
    healthFill.setFillStyle(definition.enragedColor);
    this.tweens.add({
      targets: [healthBack, healthFill, ...healthTicks],
      scaleY: 1.65,
      duration: 130,
      yoyo: true,
      repeat: 2,
    });

    const phaseLabel = this.add.text(boss.x, boss.y - 76, 'PHASE II // ENRAGED', {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '15px',
      color: Phaser.Display.Color.IntegerToColor(definition.enragedColor).rgba,
      backgroundColor: '#160403f2',
      stroke: '#090000',
      strokeThickness: 3,
      padding: { x: 9, y: 4 },
    }).setOrigin(0.5).setDepth(21);
    boss.setData('phaseLabel', phaseLabel);
    this.tweens.add({
      targets: phaseLabel,
      alpha: 0,
      duration: 800,
      hold: 900,
      onComplete: () => {
        phaseLabel.destroy();
        if (boss.active) boss.setData('phaseLabel', null);
      },
    });
    const banner = this.add.text(WIDTH / 2, 50, `${definition.name} // PHASE II`, {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '20px',
      color: '#fff0df',
      backgroundColor: '#380706ee',
      stroke: '#120000',
      strokeThickness: 4,
      padding: { x: 14, y: 7 },
    }).setOrigin(0.5).setDepth(32).setScale(1.35);
    this.tweens.add({
      targets: banner,
      scale: 1,
      alpha: 0,
      duration: 850,
      hold: 850,
      ease: 'Quad.out',
      onComplete: () => banner.destroy(),
    });
    const transitionGlow = this.add.image(boss.x, boss.y, 'glow')
      .setDepth(22)
      .setTint(definition.enragedColor)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.45)
      .setAlpha(0.95);
    const transitionRing = this.add.circle(boss.x, boss.y, 44, definition.enragedColor, 0.08)
      .setStrokeStyle(6, definition.enragedColor, 1)
      .setDepth(23)
      .setScale(0.4);
    this.tweens.add({
      targets: transitionGlow,
      scale: 3.2,
      alpha: 0,
      duration: 720,
      onComplete: () => transitionGlow.destroy(),
    });
    this.tweens.add({
      targets: transitionRing,
      scale: 3.8,
      alpha: 0,
      duration: 620,
      onComplete: () => transitionRing.destroy(),
    });
    this.monsterAudio.play(definition.voice, 'spawn', boss.x, boss.y, this.player.x, this.player.y);
    const phaseTone = { breaker: 42, lurker: 76, furnace: 118, spitter: 92 }[kind];
    this.audio.playTone(phaseTone, 1.15, 0.1, 'sawtooth');
    this.time.delayedCall(160, () => this.audio.playTone(phaseTone * 1.6, 0.72, 0.07, 'square'));
    this.audio.playNoise(0.72, 0.09, kind === 'furnace' ? 1500 : 1050);
    this.cameras.main.flash(220, 210, 28, 18, false);
    this.cameras.main.shake(480, 0.018);
  }

  private beginBreakerCharge(boss: any, angle: number, time: number): void {
    boss.setData('chargesRemaining', boss.getData('phase') === 2 ? 2 : 1);
    this.telegraphBreakerCharge(boss, angle, time);
  }

  private beginBreakerSlam(boss: any, time: number): void {
    const duration = 760;
    const color = this.bossPhaseColor(boss);
    const warning = this.makeBossWarningCircle(boss.x, boss.y, 112, color, duration);
    boss.setVelocity(0).setData({
      bossState: 'slamTelegraph',
      stateUntil: time + duration,
      telegraphs: [warning],
    });
    this.monsterAudio.play('breaker', 'attack', boss.x, boss.y, this.player.x, this.player.y);
    this.audio.playTone(48, 0.7, 0.07, 'sawtooth');
  }

  private telegraphBreakerCharge(boss: any, angle: number, time: number): void {
    const phaseTwo = boss.getData('phase') === 2;
    const duration = phaseTwo ? 700 : 950;
    const color = this.bossPhaseColor(boss);
    this.emitDuoEvent('boss-warning', {
      style: 'charge',
      x: boss.x,
      y: boss.y,
      angle,
      color,
      duration,
    });
    boss.setVelocity(0).setData({
      bossState: 'telegraph',
      stateUntil: time + duration,
      attackAngle: angle,
    });
    const line = this.add.graphics().setDepth(17);
    line.lineStyle(4, color, 0.3)
      .lineBetween(boss.x, boss.y, boss.x + Math.cos(angle) * 390, boss.y + Math.sin(angle) * 390);
    line.lineStyle(1, 0xffb09a, 0.9)
      .lineBetween(boss.x, boss.y, boss.x + Math.cos(angle) * 390, boss.y + Math.sin(angle) * 390);
    const ring = this.add.circle(boss.x, boss.y, 36, color, 0.08)
      .setStrokeStyle(3, color, 0.9)
      .setDepth(17);
    boss.setData('telegraphs', [line, ring]);
    this.tweens.add({ targets: ring, scale: 0.58, alpha: 1, duration, ease: 'Quad.in' });
    this.monsterAudio.play('breaker', 'attack', boss.x, boss.y, this.player.x, this.player.y);
    this.audio.playTone(58, 0.75, 0.055, 'sawtooth');
  }

  private updateBreaker(boss: any, time: number): void {
    const state = boss.getData('bossState');
    if (state === 'slamTelegraph') {
      boss.setVelocity(0);
      const warning = (boss.getData('telegraphs') as Phaser.GameObjects.Arc[])[0];
      warning?.setPosition(boss.x, boss.y);
      if (time < boss.getData('stateUntil')) return;
      this.clearBossTelegraphs(boss);
      this.makeBossShockwave(boss.x, boss.y, this.bossPhaseColor(boss));
      const outerRing = this.add.circle(boss.x, boss.y, 112, this.bossPhaseColor(boss), 0.08)
        .setStrokeStyle(7, this.bossPhaseColor(boss), 0.95)
        .setDepth(22)
        .setScale(0.25);
      this.tweens.add({
        targets: outerRing,
        scale: 1,
        alpha: 0,
        duration: 300,
        onComplete: () => outerRing.destroy(),
      });
      this.livingActors().forEach((actor) => {
        if (Phaser.Math.Distance.Between(boss.x, boss.y, actor.sprite.x, actor.sprite.y) > 112) return;
        if (this.damagePlayer(30, actor.id)) {
          this.applyPlayerKnockback(
            Phaser.Math.Angle.Between(boss.x, boss.y, actor.sprite.x, actor.sprite.y),
            310,
            320,
            actor.id,
          );
        }
      });
      this.damageBossEnvironment(boss, 125, 3, boss.rotation);
      boss.setData({ bossState: 'recovery', stateUntil: time + 600 });
      return;
    }
    if (state === 'telegraph') {
      boss.setVelocity(0);
      if (time < boss.getData('stateUntil')) return;
      this.clearBossTelegraphs(boss);
      boss.setData({ bossState: 'charge', stateUntil: time + 820 });
      this.audio.playNoise(0.42, 0.075, 620);
      this.cameras.main.shake(110, 0.005);
    }
    if (boss.getData('bossState') === 'charge') {
      const angle = boss.getData('attackAngle');
      const chargeSpeed = boss.getData('phase') === 2 ? 410 : 350;
      boss.setVelocity(Math.cos(angle) * chargeSpeed, Math.sin(angle) * chargeSpeed);
      this.damageBossEnvironment(boss, 42, 1, angle);
      if (boss.x <= 28 || boss.x >= WIDTH - 28 || boss.y <= 28 || boss.y >= HEIGHT - 28) {
        this.crashBreaker(boss, time);
        return;
      }
      if (time < boss.getData('stateUntil')) return;
      const remaining = boss.getData('chargesRemaining') - 1;
      boss.setData('chargesRemaining', remaining);
      if (remaining > 0) {
        boss.setVelocity(0).setData({ bossState: 'chainReset', stateUntil: time + 210 });
      } else {
        this.crashBreaker(boss, time);
      }
    }
    if (boss.getData('bossState') === 'chainReset' && time >= boss.getData('stateUntil')) {
      const angle = Phaser.Math.Angle.Between(boss.x, boss.y, this.player.x, this.player.y);
      this.telegraphBreakerCharge(boss, angle, time);
    }
    if (boss.getData('bossState') === 'recovery' && time >= boss.getData('stateUntil')) {
      boss.setData({
        bossState: 'pursuit',
        abilityAt: time + this.bossAbilityDelay('breaker', boss.getData('phase')),
      });
    }
  }

  private crashBreaker(boss: any, time: number): void {
    if (!boss.active) return;
    this.clearBossTelegraphs(boss);
    boss.setVelocity(0).setData({
      bossState: 'recovery',
      stateUntil: time + (boss.getData('phase') === 2 ? 700 : 2300),
      chargesRemaining: 0,
    });
    this.makeBossShockwave(boss.x, boss.y, BOSS_DEFINITIONS.breaker.color);
    this.audio.playNoise(0.45, 0.08, 520);
    this.cameras.main.shake(180, 0.009);
  }

  private beginLurkerLeap(boss: any, time: number): void {
    boss.setData('leapsRemaining', boss.getData('phase') === 2 ? 2 : 1);
    this.telegraphLurkerLeap(boss, time);
  }

  private beginLurkerRake(boss: any, angle: number, time: number): void {
    const duration = 500;
    const distance = 165;
    const spread = 0.52;
    const color = this.bossPhaseColor(boss);
    this.emitDuoEvent('boss-warning', {
      style: 'rake',
      x: boss.x,
      y: boss.y,
      angle,
      color,
      duration,
    });
    const warning = this.add.graphics().setDepth(17);
    const leftX = boss.x + Math.cos(angle - spread) * distance;
    const leftY = boss.y + Math.sin(angle - spread) * distance;
    const rightX = boss.x + Math.cos(angle + spread) * distance;
    const rightY = boss.y + Math.sin(angle + spread) * distance;
    warning.fillStyle(color, 0.1).fillTriangle(boss.x, boss.y, leftX, leftY, rightX, rightY);
    warning.lineStyle(3, color, 0.9)
      .lineBetween(boss.x, boss.y, leftX, leftY)
      .lineBetween(boss.x, boss.y, rightX, rightY);
    boss.setVelocity(0).setData({
      bossState: 'rakeTelegraph',
      stateUntil: time + duration,
      attackAngle: angle,
      telegraphs: [warning],
    });
    this.tweens.add({ targets: warning, alpha: 0.35, duration: 110, yoyo: true, repeat: 3 });
    this.monsterAudio.play('lurker', 'attack', boss.x, boss.y, this.player.x, this.player.y);
    this.audio.playTone(104, 0.52, 0.055, 'sawtooth');
  }

  private releaseLurkerRake(boss: any): void {
    const angle = boss.getData('attackAngle');
    const color = this.bossPhaseColor(boss);
    this.emitDuoEvent('boss-warning', {
      style: 'rake-release',
      x: boss.x,
      y: boss.y,
      angle,
      color,
      duration: 285,
    });
    [-0.32, 0, 0.32].forEach((offset, index) => {
      const slashAngle = angle + offset;
      const slash = this.add.rectangle(
        boss.x + Math.cos(slashAngle) * 82,
        boss.y + Math.sin(slashAngle) * 82,
        164,
        8,
        color,
        0.95,
      ).setRotation(slashAngle).setDepth(23).setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: slash,
        alpha: 0,
        scaleY: 2.4,
        duration: 240 + index * 45,
        onComplete: () => slash.destroy(),
      });
    });

    const insideCone = (x: number, y: number) => {
      const distance = Phaser.Math.Distance.Between(boss.x, boss.y, x, y);
      const targetAngle = Phaser.Math.Angle.Between(boss.x, boss.y, x, y);
      return distance <= 165 && Math.abs(Phaser.Math.Angle.Wrap(targetAngle - angle)) <= 0.52;
    };
    if (insideCone(this.player.x, this.player.y) && this.damagePlayer(34)) {
      this.applyPlayerKnockback(angle, 300, 300);
    }
    this.solidProps.getChildren().forEach((prop: any) => {
      if (prop.active && this.isOutpostProp(prop) && insideCone(prop.x, prop.y)) {
        this.damageOutpostProp(prop, 2, angle);
      }
    });
    this.barrels.getChildren().slice().forEach((barrel: any) => {
      if (barrel.active && insideCone(barrel.x, barrel.y)) this.explodeBarrel(barrel, angle);
    });
    this.audio.playNoise(0.3, 0.075, 1750);
    this.cameras.main.shake(150, 0.008);
  }

  private telegraphLurkerLeap(boss: any, time: number): void {
    const duration = boss.getData('phase') === 2 ? 570 : 1050;
    const velocity = this.player.body as Phaser.Physics.Arcade.Body;
    const targetX = Phaser.Math.Clamp(this.player.x + velocity.velocity.x * 0.42, 65, WIDTH - 65);
    const targetY = Phaser.Math.Clamp(this.player.y + velocity.velocity.y * 0.42, 65, HEIGHT - 65);
    const warning = this.makeBossWarningCircle(targetX, targetY, 62, this.bossPhaseColor(boss), duration);
    boss.setVelocity(0).setData({
      bossState: 'telegraph',
      stateUntil: time + duration,
      targetX,
      targetY,
      telegraphs: [warning],
    });
    this.monsterAudio.play('lurker', 'attack', boss.x, boss.y, this.player.x, this.player.y);
    this.audio.playTone(92, 0.8, 0.045, 'sawtooth');
  }

  private updateLurker(boss: any, time: number): void {
    const state = boss.getData('bossState');
    if (state === 'rakeTelegraph') {
      boss.setVelocity(0);
      if (time < boss.getData('stateUntil')) return;
      this.clearBossTelegraphs(boss);
      this.releaseLurkerRake(boss);
      boss.setData({ bossState: 'recovery', stateUntil: time + 600 });
      return;
    }
    if (state === 'telegraph') {
      boss.setVelocity(0);
      if (time < boss.getData('stateUntil')) return;
      this.launchLurker(boss, time);
    }
    if (boss.getData('bossState') === 'chainReset' && time >= boss.getData('stateUntil')) {
      this.telegraphLurkerLeap(boss, time);
    }
    if (boss.getData('bossState') === 'recovery' && time >= boss.getData('stateUntil')) {
      boss.setData({
        bossState: 'pursuit',
        abilityAt: time + this.bossAbilityDelay('lurker', boss.getData('phase')),
      });
    }
  }

  private launchLurker(boss: any, time: number): void {
    const targetX = boss.getData('targetX');
    const targetY = boss.getData('targetY');
    const body = boss.body as Phaser.Physics.Arcade.Body;
    const shadow = boss.getData('shadow') as Phaser.GameObjects.Image;
    const duration = boss.getData('phase') === 2 ? 360 : 620;
    boss.setData({ bossState: 'airborne', stateUntil: time + duration }).setVelocity(0);
    body.enable = false;
    this.audio.playNoise(0.18, 0.04, 1300);
    this.tweens.add({
      targets: boss,
      x: targetX,
      y: targetY,
      duration,
      ease: 'Quad.inOut',
      onUpdate: (tween) => {
        const lift = Math.sin(tween.progress * Math.PI);
        boss.setScale(1 + lift * 0.32);
        shadow
          .setPosition(boss.x + 3, boss.y + 7)
          .setScale(1 - lift * 0.52)
          .setAlpha(0.46 - lift * 0.3);
      },
      onComplete: () => {
        if (!boss.active) return;
        body.enable = true;
        body.reset(boss.x, boss.y);
        shadow.setScale(1).setAlpha(0.46);
        this.clearBossTelegraphs(boss);
        this.makeBossShockwave(boss.x, boss.y, BOSS_DEFINITIONS.lurker.color);
        if (Phaser.Math.Distance.Between(boss.x, boss.y, this.player.x, this.player.y) <= 62
          && this.damagePlayer(boss.getData('phase') === 2 ? 38 : 32)) {
          this.applyPlayerKnockback(
            Phaser.Math.Angle.Between(boss.x, boss.y, this.player.x, this.player.y),
            boss.getData('phase') === 2 ? 330 : 270,
            boss.getData('phase') === 2 ? 320 : 280,
          );
        }
        this.damageBossEnvironment(boss, 70, 2, boss.rotation);
        const remaining = boss.getData('leapsRemaining') - 1;
        boss.setData('leapsRemaining', remaining).setVelocity(0);
        if (remaining > 0) {
          boss.setData({ bossState: 'chainReset', stateUntil: this.time.now + 180 });
        } else {
          boss.setData({
            bossState: 'recovery',
            stateUntil: this.time.now + (boss.getData('phase') === 2 ? 640 : 1250),
          });
        }
      },
    });
  }

  private beginFurnaceOverheat(boss: any, time: number): void {
    const abilityPhase = boss.getData('phase');
    const duration = abilityPhase === 2 ? 1390 : 2400;
    const color = this.bossPhaseColor(boss);
    const dangerRadius = abilityPhase === 2 ? 150 : 128;
    const countdownRadius = abilityPhase === 2 ? 72 : 92;
    this.emitDuoEvent('boss-warning', {
      style: 'overheat',
      x: boss.x,
      y: boss.y,
      color,
      duration,
      dangerRadius,
      countdownRadius,
    });
    const dangerArea = this.add.circle(boss.x, boss.y, dangerRadius, color, 0.025)
      .setStrokeStyle(2, color, 0.5)
      .setDepth(17);
    const countdown = this.add.circle(boss.x, boss.y, countdownRadius, color, 0.06)
      .setStrokeStyle(3, 0xffc05b, 0.9)
      .setDepth(17);
    boss.setData({
      bossState: 'overheat',
      stateUntil: time + duration,
      abilityPhase,
      abilityDuration: duration,
      telegraphs: [dangerArea, countdown],
    });
    this.monsterAudio.play('furnace', 'attack', boss.x, boss.y, this.player.x, this.player.y);
    this.audio.playTone(116, 2.25, 0.055, 'sawtooth');
  }

  private beginFurnaceFireLanes(boss: any, angle: number, time: number): void {
    const duration = 820;
    const color = this.bossPhaseColor(boss);
    this.emitDuoEvent('boss-warning', {
      style: 'lane',
      x: boss.x,
      y: boss.y,
      angle,
      color,
      duration,
    });
    const makeLane = (rotation: number) => this.add.rectangle(boss.x, boss.y, 380, 38, color, 0.09)
      .setStrokeStyle(2, color, 0.85)
      .setRotation(rotation)
      .setDepth(17);
    const lanes = [makeLane(angle), makeLane(angle + Math.PI / 2)];
    boss.setVelocity(0).setData({
      bossState: 'fireLaneTelegraph',
      stateUntil: time + duration,
      attackAngle: angle,
      telegraphs: lanes,
    });
    this.tweens.add({ targets: lanes, alpha: 0.38, duration: 170, yoyo: true, repeat: 3 });
    this.monsterAudio.play('furnace', 'attack', boss.x, boss.y, this.player.x, this.player.y);
    this.audio.playTone(148, 0.78, 0.065, 'sawtooth');
  }

  private releaseFurnaceFireLanes(boss: any): void {
    const angle = boss.getData('attackAngle');
    this.emitDuoEvent('boss-warning', {
      style: 'fire-release',
      x: boss.x,
      y: boss.y,
      angle,
      duration: 1040,
      color: this.bossPhaseColor(boss),
    });
    [angle, angle + Math.PI / 2].forEach((rotation) => {
      for (let distance = -160; distance <= 160; distance += 40) {
        const fire = this.add.sprite(
          boss.x + Math.cos(rotation) * distance,
          boss.y + Math.sin(rotation) * distance,
          'ground-fire',
        ).setDepth(3).setScale(0.9).setRotation(Phaser.Math.FloatBetween(0, Math.PI * 2));
        fire.play('ground-fire');
        this.tweens.add({
          targets: fire,
          alpha: 0,
          scale: 1.15,
          delay: 620,
          duration: 420,
          onComplete: () => fire.destroy(),
        });
      }
      this.makeSparks(boss.x + Math.cos(rotation) * 85, boss.y + Math.sin(rotation) * 85, rotation, 9);
    });
    const dx = this.player.x - boss.x;
    const dy = this.player.y - boss.y;
    const along = dx * Math.cos(angle) + dy * Math.sin(angle);
    const across = -dx * Math.sin(angle) + dy * Math.cos(angle);
    const insideLane = (Math.abs(along) <= 190 && Math.abs(across) <= 22)
      || (Math.abs(across) <= 190 && Math.abs(along) <= 22);
    if (insideLane) this.damagePlayer(36);
    this.solidProps.getChildren().forEach((prop: any) => {
      if (!prop.active || !this.isOutpostProp(prop)) return;
      const propX = prop.x - boss.x;
      const propY = prop.y - boss.y;
      const propAlong = propX * Math.cos(angle) + propY * Math.sin(angle);
      const propAcross = -propX * Math.sin(angle) + propY * Math.cos(angle);
      if ((Math.abs(propAlong) <= 190 && Math.abs(propAcross) <= 28)
        || (Math.abs(propAcross) <= 190 && Math.abs(propAlong) <= 28)) {
        this.damageOutpostProp(prop, 2, angle);
      }
    });
    this.barrels.getChildren().slice().forEach((barrel: any) => {
      const barrelX = barrel.x - boss.x;
      const barrelY = barrel.y - boss.y;
      const barrelAlong = barrelX * Math.cos(angle) + barrelY * Math.sin(angle);
      const barrelAcross = -barrelX * Math.sin(angle) + barrelY * Math.cos(angle);
      if (barrel.active && ((Math.abs(barrelAlong) <= 190 && Math.abs(barrelAcross) <= 28)
        || (Math.abs(barrelAcross) <= 190 && Math.abs(barrelAlong) <= 28))) {
        this.explodeBarrel(barrel, angle);
      }
    });
    this.lighting.addExplosionLight(boss.x, boss.y, 180);
    this.audio.playNoise(0.58, 0.085, 1800);
    this.cameras.main.shake(240, 0.011);
  }

  private updateFurnace(boss: any, angle: number, time: number): void {
    const state = boss.getData('bossState');
    if (state === 'fireLaneTelegraph') {
      boss.setVelocity(0);
      const lanes = boss.getData('telegraphs') as Phaser.GameObjects.Rectangle[];
      lanes.forEach((lane, index) => lane
        ?.setPosition(boss.x, boss.y)
        .setRotation(boss.getData('attackAngle') + index * Math.PI / 2));
      if (time < boss.getData('stateUntil')) return;
      this.clearBossTelegraphs(boss);
      this.releaseFurnaceFireLanes(boss);
      boss.setData({ bossState: 'recovery', stateUntil: time + 940 });
      return;
    }
    if (state === 'overheat') {
      const remaining = Math.max(0, boss.getData('stateUntil') - time);
      const progress = 1 - remaining / boss.getData('abilityDuration');
      boss.setVelocity(Math.cos(angle) * 20, Math.sin(angle) * 20);
      const [dangerArea, countdown] = boss.getData('telegraphs') as Phaser.GameObjects.Arc[];
      dangerArea?.setPosition(boss.x, boss.y).setAlpha(0.4 + Math.sin(time * 0.018) * 0.18);
      countdown?.setPosition(boss.x, boss.y).setScale(1 - progress * 0.72).setAlpha(0.65 + progress * 0.35);
      if (remaining > 0) return;

      const abilityPhase = boss.getData('abilityPhase');
      this.clearBossTelegraphs(boss);
      if (abilityPhase === 2) {
        this.furnacePulse(boss, 72, 24);
        const secondWarning = this.makeBossWarningCircle(
          boss.x,
          boss.y,
          150,
          this.bossPhaseColor(boss),
          650,
        );
        boss.setVelocity(0).setData({
          bossState: 'meltdownSecond',
          stateUntil: time + 650,
          telegraphs: [secondWarning],
        });
      } else {
        this.furnacePulse(boss, 128, 38);
        boss.setVelocity(0).setData({ bossState: 'recovery', stateUntil: time + 2500 });
      }
      return;
    }

    if (state === 'meltdownSecond') {
      boss.setVelocity(0);
      const warning = (boss.getData('telegraphs') as Phaser.GameObjects.Arc[])[0];
      warning?.setPosition(boss.x, boss.y);
      if (time < boss.getData('stateUntil')) return;
      this.clearBossTelegraphs(boss);
      this.furnacePulse(boss, 150, 44);
      boss.setData({ bossState: 'recovery', stateUntil: time + 1275 });
      return;
    }

    if (state === 'recovery' && time >= boss.getData('stateUntil')) {
      boss.setData({
        bossState: 'pursuit',
        abilityAt: time + this.bossAbilityDelay('furnace', boss.getData('phase')),
      });
    }
  }

  private furnacePulse(boss: any, radius: number, damage: number): void {
    this.makeBlast(boss.x, boss.y, boss.rotation, radius, 3, boss);
    this.damageBossEnvironment(boss, radius, 3, boss.rotation);
    this.damageLivingInRadius(boss.x, boss.y, radius, damage);
  }

  private beginSpitterBurst(boss: any, angle: number, time: number): void {
    const duration = 820;
    const radius = 126;
    const normalizedAngle = Phaser.Math.Angle.Normalize(angle);
    const gapIndex = Math.round(normalizedAngle / (Math.PI * 2) * 8) % 8;
    const oppositeGap = (gapIndex + 4) % 8;
    const targets = Array.from({ length: 8 }, (_, index) => index)
      .filter((index) => index !== gapIndex && index !== oppositeGap)
      .map((index) => {
        const targetAngle = index * Math.PI / 4;
        return {
          x: Phaser.Math.Clamp(boss.x + Math.cos(targetAngle) * radius, 48, WIDTH - 48),
          y: Phaser.Math.Clamp(boss.y + Math.sin(targetAngle) * radius, 48, HEIGHT - 48),
        };
      });
    const warnings = targets.map((target) => this.makeBossWarningCircle(
      target.x,
      target.y,
      44,
      this.bossPhaseColor(boss),
      duration,
    ));
    boss.setVelocity(0).setData({
      bossState: 'burstTelegraph',
      stateUntil: time + duration,
      spitTargets: targets,
      telegraphs: warnings,
    });
    this.monsterAudio.play('spitter', 'attack', boss.x, boss.y, this.player.x, this.player.y);
    this.audio.playTone(164, 0.72, 0.055, 'sawtooth');
  }

  private beginSpitterVolley(boss: any, angle: number, time: number): void {
    const phaseTwo = boss.getData('phase') === 2;
    const duration = phaseTwo ? 780 : 1100;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const baseX = Phaser.Math.Clamp(this.player.x + body.velocity.x * 0.48, 55, WIDTH - 55);
    const baseY = Phaser.Math.Clamp(this.player.y + body.velocity.y * 0.48, 55, HEIGHT - 55);
    const sideX = Math.cos(angle + Math.PI / 2) * 52;
    const sideY = Math.sin(angle + Math.PI / 2) * 52;
    const targets = [
      { x: baseX, y: baseY },
      { x: Phaser.Math.Clamp(baseX + sideX, 48, WIDTH - 48), y: Phaser.Math.Clamp(baseY + sideY, 48, HEIGHT - 48) },
      { x: Phaser.Math.Clamp(baseX - sideX, 48, WIDTH - 48), y: Phaser.Math.Clamp(baseY - sideY, 48, HEIGHT - 48) },
    ];
    if (phaseTwo) {
      const forwardX = Math.cos(angle) * 72;
      const forwardY = Math.sin(angle) * 72;
      targets.push(
        {
          x: Phaser.Math.Clamp(baseX + forwardX, 48, WIDTH - 48),
          y: Phaser.Math.Clamp(baseY + forwardY, 48, HEIGHT - 48),
        },
        {
          x: Phaser.Math.Clamp(baseX - forwardX, 48, WIDTH - 48),
          y: Phaser.Math.Clamp(baseY - forwardY, 48, HEIGHT - 48),
        },
      );
    }
    const warnings = targets.map((target) => this.makeBossWarningCircle(
      target.x,
      target.y,
      48,
      this.bossPhaseColor(boss),
      duration,
    ));
    boss.setVelocity(0).setData({
      bossState: 'telegraph',
      stateUntil: time + duration,
      spitTargets: targets,
      telegraphs: warnings,
    });
    this.monsterAudio.play('spitter', 'attack', boss.x, boss.y, this.player.x, this.player.y);
    this.audio.playTone(138, 0.95, 0.04, 'sawtooth');
  }

  private updateSpitter(boss: any, time: number): void {
    if (boss.getData('bossState') === 'telegraph' || boss.getData('bossState') === 'burstTelegraph') {
      boss.setVelocity(0);
      if (time < boss.getData('stateUntil')) return;
      this.launchSpitterVolley(boss);
      boss.setData({
        bossState: 'recovery',
        stateUntil: time + (boss.getData('phase') === 2 ? 700 : 1000),
      });
    }
    if (boss.getData('bossState') === 'recovery' && time >= boss.getData('stateUntil')) {
      boss.setData({
        bossState: 'pursuit',
        abilityAt: time + this.bossAbilityDelay('spitter', boss.getData('phase')),
      });
    }
  }

  private launchSpitterVolley(boss: any): void {
    const startX = boss.x;
    const startY = boss.y;
    const targets = boss.getData('spitTargets') as { x: number; y: number }[];
    const warnings = boss.getData('telegraphs') as Phaser.GameObjects.Arc[];
    const phaseTwo = boss.getData('phase') === 2;
    boss.setData('telegraphs', []);
    targets.forEach((target, index) => {
      this.time.delayedCall(index * (phaseTwo ? 80 : 120), () => {
        if (this.isGameOver || !boss.active) {
          warnings[index]?.destroy();
          return;
        }
        this.emitDuoEvent('boss-warning', {
          style: 'spitter-projectile',
          startX,
          startY,
          targetX: target.x,
          targetY: target.y,
          duration: 460,
        });
        const projectileGlow = this.add.image(0, 0, 'glow')
          .setScale(0.34)
          .setTint(BOSS_DEFINITIONS.spitter.color)
          .setAlpha(0.85)
          .setBlendMode(Phaser.BlendModes.ADD);
        const projectileFire = this.add.sprite(0, 0, 'ground-fire')
          .setScale(0.52)
          .setTint(0xe8da72)
          .setRotation(Phaser.Math.FloatBetween(0, Math.PI * 2));
        projectileFire.play('ground-fire');
        const projectile = this.add.container(startX, startY, [projectileGlow, projectileFire])
          .setDepth(22)
          .setScale(0.55);
        let lastTrailAt = 0;
        this.tweens.add({
          targets: projectile,
          x: target.x,
          y: target.y,
          scale: 1,
          duration: 460,
          ease: 'Quad.in',
          onUpdate: () => {
            if (this.time.now - lastTrailAt < 65) return;
            lastTrailAt = this.time.now;
            const trail = this.add.image(projectile.x, projectile.y, 'glow')
              .setDepth(21)
              .setScale(0.14)
              .setTint(BOSS_DEFINITIONS.spitter.color)
              .setAlpha(0.55)
              .setBlendMode(Phaser.BlendModes.ADD);
            this.tweens.add({
              targets: trail,
              scale: 0.32,
              alpha: 0,
              duration: 240,
              onComplete: () => trail.destroy(),
            });
          },
          onComplete: () => {
            projectile.destroy(true);
            warnings[index]?.destroy();
            this.createSpitterPool(target.x, target.y);
          },
        });
      });
    });
    this.audio.playNoise(0.32, 0.045, 1700);
  }

  private makeBossWarningCircle(
    x: number,
    y: number,
    radius: number,
    color: number,
    duration: number,
    replicate = true,
  ): Phaser.GameObjects.Arc {
    if (replicate) this.emitDuoEvent('boss-warning', { style: 'circle', x, y, radius, color, duration });
    const warning = this.add.circle(x, y, radius, color, 0.07)
      .setStrokeStyle(3, color, 0.92)
      .setDepth(17)
      .setScale(1.25);
    this.tweens.add({ targets: warning, scale: 1, alpha: 1, duration, ease: 'Quad.in' });
    return warning;
  }

  private clearBossTelegraphs(boss: any): void {
    const telegraphs = (boss.getData('telegraphs') ?? []) as Phaser.GameObjects.GameObject[];
    telegraphs.forEach((telegraph) => {
      this.tweens.killTweensOf(telegraph);
      telegraph.destroy();
    });
    boss.setData('telegraphs', []);
  }

  private makeBossShockwave(x: number, y: number, color: number): void {
    this.queueNetworkEffect({ kind: 'boss-shockwave', x, y, angle: 0, color });
    const ring = this.add.circle(x, y, 42, color, 0.05)
      .setStrokeStyle(4, color, 0.95)
      .setDepth(22)
      .setScale(0.35);
    const glow = this.add.image(x, y, 'glow')
      .setDepth(21)
      .setTint(color)
      .setAlpha(0.7)
      .setScale(0.45)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: ring, scale: 2.1, alpha: 0, duration: 360, onComplete: () => ring.destroy() });
    this.tweens.add({ targets: glow, scale: 1.7, alpha: 0, duration: 300, onComplete: () => glow.destroy() });
    if (!this.isNetworkClient) this.audio.playNoise(0.35, 0.07, 850, { x, y });
    this.cameras.main.shake(150, 0.007);
  }

  private createSpitterPool(x: number, y: number): void {
    const color = BOSS_DEFINITIONS.spitter.color;
    const pool = this.add.sprite(x, y, 'ground-fire')
      .setDepth(2)
      .setScale(0.55)
      .setTint(0xe8da72)
      .setAlpha(0.95)
      .setRotation(Phaser.Math.FloatBetween(0, Math.PI * 2));
    pool.play('ground-fire');
    const glow = this.add.image(x, y, 'glow')
      .setDepth(15)
      .setScale(0.7)
      .setTint(color)
      .setAlpha(0.28)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: pool, scale: 1.35, duration: 260, ease: 'Back.out' });
    this.tweens.add({ targets: glow, alpha: { from: 0.18, to: 0.38 }, duration: 420, yoyo: true, repeat: -1 });
    this.damageOutpostInRadius(x, y, 52, 2, 0);
    this.barrels.getChildren().slice().forEach((barrel: any) => {
      if (barrel.active && Phaser.Math.Distance.Between(x, y, barrel.x, barrel.y) <= 52) {
        this.explodeBarrel(barrel, 0);
      }
    });
    this.bossHazards.push({
      pool,
      glow,
      expiresAt: this.time.now + 5200,
      nextDamageAt: this.time.now + 350,
      radiusX: 44,
      radiusY: 32,
    });
  }

  private updateBossHazards(time: number): void {
    this.bossHazards = this.bossHazards.filter((hazard) => {
      if (time >= hazard.expiresAt) {
        this.tweens.killTweensOf(hazard.glow);
        hazard.pool.destroy();
        hazard.glow.destroy();
        return false;
      }
      if (time >= hazard.nextDamageAt) {
        const hit = this.livingActors().filter((actor) => {
          const normalizedX = (actor.sprite.x - hazard.pool.x) / hazard.radiusX;
          const normalizedY = (actor.sprite.y - hazard.pool.y) / hazard.radiusY;
          return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
        });
        if (hit.length) {
          hazard.nextDamageAt = time + 900;
          hit.forEach((actor) => this.damagePlayer(12, actor.id));
        }
      }
      return true;
    });
  }

  private collectShadowCasters(): ShadowCaster[] {
    const casters: ShadowCaster[] = [];
    const addBody = (gameObject: Phaser.GameObjects.GameObject & {
      active: boolean;
      body?: Phaser.Physics.Arcade.Body | Phaser.Physics.Arcade.StaticBody | null;
    }) => {
      const body = gameObject.body;
      if (!gameObject.active || !body?.enable) return;
      casters.push({
        x: body.center.x,
        y: body.center.y,
        radius: Math.max(6, body.halfWidth, body.halfHeight),
      });
    };

    this.playerActors.forEach((actor) => addBody(actor.sprite));
    this.zombies.getChildren()
      .filter((zombie) => zombie.active)
      .sort((a, b) => Phaser.Math.Distance.Squared(this.player.x, this.player.y, a.x, a.y)
        - Phaser.Math.Distance.Squared(this.player.x, this.player.y, b.x, b.y))
      .slice(0, 36)
      .forEach(addBody);
    this.solidProps.getChildren().forEach(addBody);
    this.barrels.getChildren().forEach(addBody);
    return casters;
  }

  private playerLightSources(): PlayerLight[] {
    return [...this.playerActors.values()].map((actor) => ({
      x: actor.sprite.x,
      y: actor.sprite.y,
      aimAngle: actor.aim,
      active: actor.alive && actor.health > 0,
    }));
  }

  shoot(angle, time) {
    const actor = this.actor(this.localPlayerId);
    if (!actor) return;
    this.lastShot = time;
    this.shootForActor(actor, angle, time);
  }

  private shootForActor(
    actor: PlayerActor,
    angle: number,
    time: number,
    visualOnly = false,
    shotSequence?: number,
  ): void {
    const soundPosition = { x: actor.sprite.x, y: actor.sprite.y };
    const soundMetadata = { ownerId: actor.id, shotSequence };
    this.audio.playNoise(0.055, 0.075, 2100, soundPosition, soundMetadata);
    this.audio.playTone(115, 0.065, 0.045, 'square', soundPosition, soundMetadata);
    // The source art aims due south, with the muzzle on its lower centerline.
    const muzzleDistance = 29;
    const muzzleX = actor.sprite.x + Math.cos(angle) * muzzleDistance;
    const muzzleY = actor.sprite.y + Math.sin(angle) * muzzleDistance;
    const pointBlankZombie = visualOnly ? undefined : this.findZombieBetweenActor(actor, muzzleX, muzzleY);
    const bullet = this.bullets.get(muzzleX, muzzleY, 'bullet');
    if (!bullet) return;
    bullet.enableBody(true, muzzleX, muzzleY, true, true);
    bullet.setDepth(8).setRotation(angle).setData({
      networkId: visualOnly ? `predicted-bullet-${this.predictedNetworkId++}` : `bullet-${this.networkId++}`,
      ownerId: actor.id,
      shotSequence,
      predicted: visualOnly,
      createdAt: time,
    });
    const bulletBodyWidth = Math.abs(Math.cos(angle)) * 8 + Math.abs(Math.sin(angle)) * 5;
    const bulletBodyHeight = Math.abs(Math.sin(angle)) * 8 + Math.abs(Math.cos(angle)) * 5;
    bullet.body.setSize(bulletBodyWidth, bulletBodyHeight, true).setAllowGravity(false);
    const bulletGlow = this.add.image(muzzleX, muzzleY, 'glow')
      .setDepth(17)
      .setScale(0.18)
      .setTint(0xffc34d)
      .setAlpha(0.32)
      .setBlendMode(Phaser.BlendModes.ADD);
    bullet.setData('glow', bulletGlow);
    if (pointBlankZombie) {
      this.hitZombie(bullet, pointBlankZombie);
    } else {
      bullet.setVelocity(Math.cos(angle) * BULLET_SPEED, Math.sin(angle) * BULLET_SPEED);
    }

    const flash = this.add.image(muzzleX, muzzleY, 'flash')
      .setScale(1.8)
      .setRotation(angle)
      .setDepth(22)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: flash, alpha: 0, scale: 0.2, duration: 75, onComplete: () => flash.destroy() });

    const side = angle + Math.PI / 2;
    const casing = this.add.image(
      actor.sprite.x + Math.cos(side) * 9,
      actor.sprite.y + Math.sin(side) * 9,
      'casing',
    ).setDepth(7).setRotation(Phaser.Math.FloatBetween(0, Math.PI));
    this.tweens.add({
      targets: casing,
      x: casing.x + Math.cos(side) * Phaser.Math.Between(12, 20),
      y: casing.y + Math.sin(side) * Phaser.Math.Between(12, 20) + 5,
      angle: casing.angle + 180,
      alpha: 0,
      duration: 420,
      ease: 'Quad.out',
      onComplete: () => casing.destroy(),
    });

    // Recoil used to mutate the sprite position directly. That bypassed Arcade's
    // collision sweep, so repeated shots could teleport the player through a prop.
    // Apply the same small kick through a collision-aware movement instead.
    this.movePlayerSafely(
      actor,
      -Math.cos(angle) * PLAYER_SHOT_RECOIL_DISTANCE,
      -Math.sin(angle) * PLAYER_SHOT_RECOIL_DISTANCE,
    );
  }

  private findZombieBetweenActor(actor: PlayerActor, x: number, y: number) {
    const line = new Phaser.Geom.Line(actor.sprite.x, actor.sprite.y, x, y);
    let closestZombie = null;
    let closestDistance = Infinity;

    this.zombies.children.iterate((zombie) => {
      if (!zombie?.active) return;
      const body = zombie.body as Phaser.Physics.Arcade.Body;
      if (!body?.enable) return;

      let intersections: Phaser.Geom.Point[];
      let startsInside: boolean;
      if (body.isCircle) {
        const circle = new Phaser.Geom.Circle(body.center.x, body.center.y, body.halfWidth);
        if (!Phaser.Geom.Intersects.LineToCircle(line, circle)) return;
        startsInside = Phaser.Geom.Circle.Contains(circle, actor.sprite.x, actor.sprite.y);
        intersections = Phaser.Geom.Intersects.GetLineToCircle(line, circle);
      } else {
        const rectangle = new Phaser.Geom.Rectangle(body.x, body.y, body.width, body.height);
        if (!Phaser.Geom.Intersects.LineToRectangle(line, rectangle)) return;
        startsInside = Phaser.Geom.Rectangle.Contains(rectangle, actor.sprite.x, actor.sprite.y);
        intersections = Phaser.Geom.Intersects.GetLineToRectangle(line, rectangle);
      }

      const distance = startsInside
        ? 0
        : Math.min(...intersections.map((point) => Phaser.Math.Distance.Squared(
          actor.sprite.x,
          actor.sprite.y,
          point.x,
          point.y,
        )));
      if (distance < closestDistance) {
        closestZombie = zombie;
        closestDistance = distance;
      }
    });

    return closestZombie;
  }

  private destroyBullet(bullet): void {
    bullet.getData('glow')?.destroy();
    bullet.setData('glow', null);
    bullet.destroy();
  }

  makeSparks(x, y, angle, amount = 5) {
    this.queueNetworkEffect({ kind: 'sparks', x, y, angle, amount });
    for (let i = 0; i < amount; i += 1) {
      const sparkAngle = angle + Math.PI + Phaser.Math.FloatBetween(-0.8, 0.8);
      const spark = this.add.image(x, y, 'dust')
        .setDepth(22)
        .setTint(0xffd171)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(Phaser.Math.Between(1, 2));
      const distance = Phaser.Math.Between(8, 24);
      this.tweens.add({
        targets: spark,
        x: x + Math.cos(sparkAngle) * distance,
        y: y + Math.sin(sparkAngle) * distance,
        alpha: 0,
        duration: Phaser.Math.Between(90, 180),
        onComplete: () => spark.destroy(),
      });
    }
  }

  playImpactEffect(kind: 'bullet-impact' | 'blood-hit', x: number, y: number, angle: number) {
    this.queueNetworkEffect({ kind, x, y, angle });
    const effect = this.add.sprite(x, y, kind)
      .setDepth(23)
      .setRotation(angle)
      .setScale(kind === 'blood-hit' ? 1.15 : 1);
    effect.play(kind);
    effect.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => effect.destroy());
  }

  private movePlayerSafely(
    actor: PlayerActor,
    deltaX: number,
    deltaY: number,
  ): { x: number; y: number } {
    const body = actor.sprite.body as Phaser.Physics.Arcade.Body | null;
    if (!body?.enable || (deltaX === 0 && deltaY === 0)) return { x: 0, y: 0 };

    const startX = actor.sprite.x;
    const startY = actor.sprite.y;
    let x = startX;
    let y = startY;

    // Move one axis at a time. When a step would enter an obstacle, binary
    // search the last clear position so the player lands exactly on the
    // collision boundary instead of stopping a fraction of a pixel inside it.
    // That exact boundary is what lets the next horizontal/vertical input slide
    // cleanly along a wall.
    const moveAxis = (axis: 'x' | 'y', distance: number): void => {
      let remaining = Math.abs(distance);
      const direction = Math.sign(distance);
      while (remaining > 0.0001) {
        const step = Math.min(remaining, 1);
        const candidateX = axis === 'x' ? x + direction * step : x;
        const candidateY = axis === 'y' ? y + direction * step : y;
        if (this.playerCanOccupy(actor, candidateX, candidateY)) {
          x = candidateX;
          y = candidateY;
          remaining -= step;
          continue;
        }

        let clearDistance = 0;
        let blockedDistance = step;
        for (let iteration = 0; iteration < 8; iteration += 1) {
          const midpoint = (clearDistance + blockedDistance) / 2;
          const midpointX = axis === 'x' ? x + direction * midpoint : x;
          const midpointY = axis === 'y' ? y + direction * midpoint : y;
          if (this.playerCanOccupy(actor, midpointX, midpointY)) clearDistance = midpoint;
          else blockedDistance = midpoint;
        }
        if (clearDistance > 0) {
          if (axis === 'x') x += direction * clearDistance;
          else y += direction * clearDistance;
        }
        break;
      }
    };

    moveAxis('x', deltaX);
    moveAxis('y', deltaY);

    if (x === startX && y === startY) return { x: 0, y: 0 };
    actor.sprite.setPosition(x, y);
    // Keep the dynamic body in sync immediately; otherwise the physics step
    // would briefly use the pre-recoil body position.
    body.updateFromGameObject();
    return { x: x - startX, y: y - startY };
  }

  private playerCanOccupy(actor: PlayerActor, spriteX: number, spriteY: number): boolean {
    const body = actor.sprite.body as Phaser.Physics.Arcade.Body | null;
    if (!body) return false;

    const radius = Math.max(body.halfWidth, body.halfHeight);
    const centerX = spriteX + body.center.x - actor.sprite.x;
    const centerY = spriteY + body.center.y - actor.sprite.y;
    const bounds = this.physics.world.bounds;
    if (
      centerX - radius < bounds.x
      || centerX + radius > bounds.right
      || centerY - radius < bounds.y
      || centerY + radius > bounds.bottom
    ) {
      return false;
    }

    const overlapsObstacle = (prop: any): boolean => {
      if (!prop?.active || !prop.body?.enable) return false;
      const obstacle = prop.body as Phaser.Physics.Arcade.StaticBody;
      if (obstacle.isCircle) {
        const combinedRadius = radius + obstacle.halfWidth;
        return Phaser.Math.Distance.Squared(centerX, centerY, obstacle.center.x, obstacle.center.y)
          < combinedRadius * combinedRadius;
      }

      const closestX = Phaser.Math.Clamp(centerX, obstacle.x, obstacle.right);
      const closestY = Phaser.Math.Clamp(centerY, obstacle.y, obstacle.bottom);
      const distanceX = centerX - closestX;
      const distanceY = centerY - closestY;
      return distanceX * distanceX + distanceY * distanceY < radius * radius;
    };

    return !this.solidProps.getChildren().some(overlapsObstacle)
      && !this.barrels.getChildren().some(overlapsObstacle);
  }

  private isOutpostProp(prop: any): boolean {
    const kind = prop.getData('kind');
    return kind === 'generator' || kind === 'floodlight' || kind === 'sandbag';
  }

  private damageOutpostProp(prop: any, damage: number, impactAngle: number): void {
    if (!prop.active || !this.isOutpostProp(prop)) return;
    const health = prop.getData('health');
    if (!health) return;

    const remainingHealth = health - damage;
    prop.setData('health', remainingHealth).setTintFill(0xe6d4ad);
    this.time.delayedCall(55, () => prop.active && prop.clearTint());
    if (remainingHealth > 0) return;

    const kind = prop.getData('kind');
    const lightIndex = prop.getData('lightIndex');
    const { x, y } = prop;
    prop.getData('shadow')?.destroy();
    prop.setData('shadow', null);
    prop.disableBody(true, false).setTint(0x463a31).setAlpha(0.68);
    this.makeSparks(x, y, impactAngle, kind === 'sandbag' ? 7 : 10);

    if (kind === 'generator') {
      this.setGeneratorBeacon(null);
      const marker = prop.getData('marker') as Phaser.GameObjects.Text | undefined;
      if (marker) {
        this.tweens.killTweensOf(marker);
        marker.setText('OUTPOST GENERATOR  •  OFFLINE').setColor('#ed5945').setAlpha(1);
        this.tweens.add({ targets: marker, alpha: 0, delay: 2200, duration: 1300 });
      }
      this.announce('GENERATOR DESTROYED', 'THE OUTPOST HAS GONE DARK');
      this.lighting.destroyGenerator();
      this.makeBlast(x, y, impactAngle, 100, 2);
    } else if (kind === 'floodlight') {
      this.lighting.disableLight(lightIndex);
    }
  }

  private damageOutpostInRadius(
    x: number,
    y: number,
    radius: number,
    damage: number,
    impactAngle: number,
  ): void {
    this.solidProps.getChildren().forEach((prop: any) => {
      if (!prop.active || !this.isOutpostProp(prop)) return;
      if (Phaser.Math.Distance.Between(x, y, prop.x, prop.y) <= radius) {
        this.damageOutpostProp(prop, damage, impactAngle);
      }
    });
  }

  private damageBossEnvironment(boss: any, radius: number, damage: number, impactAngle: number): void {
    if (this.time.now - (boss.getData('lastEnvironmentDamageAt') ?? 0) < 180) return;
    boss.setData('lastEnvironmentDamageAt', this.time.now);
    this.damageOutpostInRadius(boss.x, boss.y, radius, damage, impactAngle);
    this.barrels.getChildren().slice().forEach((barrel: any) => {
      if (barrel.active && Phaser.Math.Distance.Between(boss.x, boss.y, barrel.x, barrel.y) <= radius) {
        this.explodeBarrel(barrel, impactAngle);
      }
    });
  }

  hitProp(bullet, prop) {
    if (!bullet.active || !prop.active) return;
    if (prop.getData('bulletPassThrough')) return;
    const impactAngle = bullet.rotation;
    const impactX = bullet.x;
    const impactY = bullet.y;
    this.destroyBullet(bullet);
    this.playImpactEffect('bullet-impact', impactX, impactY, impactAngle);
    this.makeSparks(impactX, impactY, impactAngle, 4);
    this.audio.playNoise(0.035, 0.026, 1800, { x: impactX, y: impactY });

    this.damageOutpostProp(prop, 1, impactAngle);
  }

  hitBarrel(bullet, barrel) {
    if (!bullet.active || !barrel.active || barrel.getData('exploded')) return;
    const impactAngle = bullet.rotation;
    this.playImpactEffect('bullet-impact', bullet.x, bullet.y, impactAngle);
    this.makeSparks(bullet.x, bullet.y, impactAngle, 6);
    this.destroyBullet(bullet);
    const health = barrel.getData('health') - 1;
    barrel.setData('health', health).setTintFill(0xffc27b);
    if (health <= 0) {
      this.explodeBarrel(barrel, impactAngle);
    } else {
      this.time.delayedCall(70, () => barrel.active && barrel.clearTint());
    }
  }

  explodeBarrel(barrel, impactAngle = 0) {
    if (!barrel.active || barrel.getData('exploded')) return;
    barrel.setData('exploded', true);
    const { x, y } = barrel;
    const slotIndex = barrel.getData('slotIndex');
    if (typeof slotIndex === 'number') this.barrelSlots[slotIndex].occupied = false;
    barrel.getData('shadow')?.destroy();
    barrel.disableBody(true, true);
    this.makeBlast(x, y, impactAngle, 125, 3);

    this.barrels.getChildren().slice().forEach((other) => {
      if (!other.active || other.getData('exploded') || Phaser.Math.Distance.Between(x, y, other.x, other.y) > 145) return;
      this.time.delayedCall(110, () => this.explodeBarrel(other, Phaser.Math.Angle.Between(x, y, other.x, other.y)));
    });
    this.livingActors().forEach((actor) => {
      if (Phaser.Math.Distance.Between(x, y, actor.sprite.x, actor.sprite.y) < 108) {
        this.damagePlayer(34, actor.id);
      }
    });
  }

  private shouldCollideZombieWithProp(zombie: any): boolean {
    return true;
  }

  private shouldCollideZombieWithBarrel(zombie: any): boolean {
    return true;
  }

  private handleZombiePropCollision(zombie: any, prop: any): void {
    const bossKind = zombie.getData('bossKind') as BossKind | undefined;
    if (!bossKind) return;

    const chargingBreaker = bossKind === 'breaker' && zombie.getData('bossState') === 'charge';
    if (!this.isOutpostProp(prop)) {
      if (chargingBreaker) this.crashBreaker(zombie, this.time.now);
      return;
    }
    if (this.time.now - (prop.getData('lastBossCollisionAt') ?? 0) < 380) return;

    prop.setData('lastBossCollisionAt', this.time.now);
    const impactAngle = Phaser.Math.Angle.Between(zombie.x, zombie.y, prop.x, prop.y);
    this.damageOutpostProp(prop, chargingBreaker ? 4 : 1, impactAngle);
    this.audio.playNoise(0.12, 0.035, 760);
    this.cameras.main.shake(65, 0.0025);
    if (chargingBreaker && prop.active) this.crashBreaker(zombie, this.time.now);
  }

  private handleZombieBarrelCollision(zombie: any, barrel: any): void {
    if (!zombie.getData('bossKind') || !barrel.active || barrel.getData('exploded')) return;
    this.explodeBarrel(barrel, Phaser.Math.Angle.Between(zombie.x, zombie.y, barrel.x, barrel.y));
  }

  private edgeSpawnPosition(edge: number, pad: number): { x: number; y: number } {
    if (edge === 0) return { x: Phaser.Math.Between(0, WIDTH), y: -pad };
    if (edge === 1) return { x: WIDTH + pad, y: Phaser.Math.Between(0, HEIGHT) };
    if (edge === 2) return { x: Phaser.Math.Between(0, WIDTH), y: HEIGHT + pad };
    return { x: -pad, y: Phaser.Math.Between(0, HEIGHT) };
  }

  private spawnBoss(kind: BossKind, edge: number, encounterId: number): void {
    if (this.isGameOver) return;
    const definition = BOSS_DEFINITIONS[kind];
    const { x, y } = this.edgeSpawnPosition(edge, 58);
    const shadow = this.add.image(x + 3, y + 6, 'soft-shadow')
      .setDepth(1)
      .setDisplaySize(definition.shadowWidth, definition.shadowHeight)
      .setAlpha(0);
    const aura = this.add.image(x, y, 'glow')
      .setDepth(16)
      .setScale(kind === 'furnace' ? 0.98 : 0.72)
      .setTint(definition.color)
      .setAlpha(kind === 'furnace' ? 0.42 : 0.24)
      .setBlendMode(Phaser.BlendModes.ADD);
    const boss = this.zombies.create(x, y, definition.texture)
      .setDepth(4)
      .setAlpha(0);
    boss.body.setCircle(definition.radius, 48 - definition.radius, 48 - definition.radius);

    const name = this.add.text(x, y - 58, definition.name, {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '11px',
      color: Phaser.Display.Color.IntegerToColor(definition.color).rgba,
      backgroundColor: '#090706e6',
      padding: { x: 5, y: 2 },
    }).setOrigin(0.5).setDepth(19).setAlpha(0);
    const healthBack = this.add.rectangle(x, y - 45, 60, 6, 0x090706, 0.9)
      .setStrokeStyle(1, 0x3e1714, 0.95)
      .setDepth(19)
      .setAlpha(0);
    const healthFill = this.add.rectangle(x - 28, y - 45, 56, 3, definition.color, 0.95)
      .setOrigin(0, 0.5)
      .setDepth(20)
      .setAlpha(0);
    const healthTicks = [1, 2, 3, 4].map((segment) => this.add.rectangle(
      x - 28 + segment * 11.2,
      y - 45,
      1,
      5,
      0x090706,
      0.9,
    ).setDepth(21).setAlpha(0));

    boss.setData({
      networkId: `zombie-${this.networkId++}`,
      type: kind,
      bossKind: kind,
      bossEncounterId: encounterId,
      textureKey: definition.texture,
      health: definition.health,
      maxHealth: definition.health,
      speed: definition.speed,
      baseScale: 1,
      tint: 0xffffff,
      bodyRadius: definition.radius,
      bodyOffset: 0,
      shadow,
      aura,
      bossName: name,
      bossHealthBack: healthBack,
      bossHealthFill: healthFill,
      bossHealthTicks: healthTicks,
      bossState: 'pursuit',
      phase: 1,
      stateUntil: 0,
      abilityAt: this.time.now + this.bossAbilityDelay(kind, 1),
      step: Phaser.Math.FloatBetween(0, Math.PI * 2),
      staggerUntil: 0,
      nextVoiceAt: this.time.now + Phaser.Math.Between(900, 1900),
      nextPainVoiceAt: 0,
      telegraphs: [],
    });

    this.tweens.add({ targets: [boss, name, healthBack, healthFill, ...healthTicks], alpha: 1, duration: 480 });
    this.tweens.add({ targets: shadow, alpha: 0.46, duration: 480 });
    this.monsterAudio.play(definition.voice, 'spawn', x, y, this.player.x, this.player.y);
    this.audio.playTone(kind === 'furnace' ? 74 : 46, 0.8, 0.065, 'sawtooth');
  }

  spawnZombie(edge = Phaser.Math.Between(0, 3)) {
    if (this.isGameOver || this.zombies.countActive() >= MAX_ACTIVE_ZOMBIES) return;
    const { x, y } = this.edgeSpawnPosition(edge, 38);

    const roll = Phaser.Math.Between(0, 99);
    let type = {
      name: 'shambler', texture: 'zombie', health: 1, speed: Phaser.Math.Between(49, 66),
      scale: 1, tint: 0xffffff, bodyRadius: 12, bodyOffset: 8, shadowWidth: 38, shadowHeight: 16,
    };
    if (this.director.wave >= 2 && roll < 22) {
      type = {
        name: 'runner', texture: 'zombie-runner', health: 1, speed: Phaser.Math.Between(96, 116),
        scale: 1, tint: 0xffffff, bodyRadius: 11, bodyOffset: 8, shadowWidth: 34, shadowHeight: 14,
      };
    }
    if (this.director.wave >= 2 && roll >= 22 && roll < 36) {
      type = {
        name: 'crawler', texture: 'zombie-crawler', health: 1, speed: Phaser.Math.Between(38, 46),
        scale: 1, tint: 0xffffff, bodyRadius: 10, bodyOffset: 4, shadowWidth: 32, shadowHeight: 12,
      };
    }
    if (this.director.wave >= 3 && roll >= 80) {
      type = {
        name: 'brute', texture: 'zombie-brute', health: 3, speed: Phaser.Math.Between(39, 48),
        scale: 1, tint: 0xffffff, bodyRadius: 17, bodyOffset: 6, shadowWidth: 46, shadowHeight: 20,
      };
    }
    if (this.director.wave >= 4 && roll >= 45 && roll < 59) {
      type = {
        name: 'charred', texture: 'zombie-charred', health: 2, speed: Phaser.Math.Between(66, 78),
        scale: 1, tint: 0xffffff, bodyRadius: 13, bodyOffset: 7, shadowWidth: 40, shadowHeight: 17,
      };
    }

    const shadow = this.add.image(x + 2, y + (type.name === 'crawler' ? 10 : 3), 'soft-shadow')
      .setDepth(1)
      .setDisplaySize(type.shadowWidth * type.scale, type.shadowHeight * type.scale)
      .setAlpha(0);
    const aura = type.name === 'charred'
      ? this.add.image(x, y, 'glow')
        .setDepth(16)
        .setScale(0.5)
        .setTint(0xff6a24)
        .setAlpha(0.2)
        .setBlendMode(Phaser.BlendModes.ADD)
      : null;
    const zombie = this.zombies.create(x, y, type.texture).setDepth(3).setScale(type.scale).setTint(type.tint);
    if (type.name === 'crawler') {
      zombie.body.setSize(17, 10, false).setOffset(23.5, 37);
    } else {
      zombie.body.setCircle(type.bodyRadius, 32 - type.bodyRadius, 32 - type.bodyRadius);
    }
    zombie.setData({
      networkId: `zombie-${this.networkId++}`,
      type: type.name,
      textureKey: type.texture,
      health: type.health,
      maxHealth: type.health,
      speed: type.speed + (type.name === 'crawler'
        ? Math.min(8, this.director.wave)
        : Math.min(25, this.director.wave * 2)),
      baseScale: type.scale,
      tint: type.tint,
      bodyRadius: type.bodyRadius,
      bodyOffset: type.bodyOffset,
      shadow,
      aura,
      step: Phaser.Math.FloatBetween(0, Math.PI * 2),
      staggerUntil: 0,
      nextVoiceAt: this.time.now + Phaser.Math.Between(900, 3600),
      nextPainVoiceAt: 0,
    });

    zombie.setAlpha(0);
    this.tweens.add({ targets: zombie, alpha: 1, duration: 260 });
    this.tweens.add({ targets: shadow, alpha: 0.34, duration: 260 });
    if (type.name !== 'shambler' || Phaser.Math.Between(0, 2) === 0) {
      this.monsterAudio.play(type.name as MonsterType, 'spawn', x, y, this.player.x, this.player.y);
    }
  }

  hitZombie(bullet, zombie) {
    if (!bullet.active || !zombie.active) return;
    const impactAngle = bullet.rotation;
    const bossKind = zombie.getData('bossKind') as BossKind | undefined;
    this.destroyBullet(bullet);
    const breakerArmored = bossKind === 'breaker' && zombie.getData('bossState') !== 'recovery';
    const damage = breakerArmored ? (zombie.getData('phase') === 2 ? 0.85 : 0.5) : 1;
    const health = zombie.getData('health') - damage;
    zombie.setData('health', health);
    if (bossKind) {
      const healthFill = zombie.getData('bossHealthFill') as Phaser.GameObjects.Rectangle;
      healthFill.setScale(Phaser.Math.Clamp(health / Math.max(1, zombie.getData('maxHealth')), 0, 1), 1);
      this.maybeEnrageBoss(zombie, health);
    }

    this.playImpactEffect('blood-hit', zombie.x, zombie.y, impactAngle);
    this.makeBlood(zombie.x, zombie.y, impactAngle, health <= 0 ? (bossKind ? 13 : 7) : (bossKind ? 5 : 3));
    if (breakerArmored) this.makeSparks(zombie.x, zombie.y, impactAngle, 3);
    this.audio.playNoise(
      health <= 0 ? 0.07 : 0.035,
      health <= 0 ? 0.045 : 0.025,
      620,
      { x: zombie.x, y: zombie.y },
    );
    this.cameras.main.shake(45, health <= 0 ? (bossKind ? 0.004 : 0.0018) : 0.0008);

    if (health > 0) {
      if (this.time.now >= zombie.getData('nextPainVoiceAt')) {
        this.monsterAudio.play(
          bossKind ? BOSS_DEFINITIONS[bossKind].voice : zombie.getData('type') as MonsterType,
          'hurt',
          zombie.x,
          zombie.y,
          this.player.x,
          this.player.y,
        );
        zombie.setData('nextPainVoiceAt', this.time.now + 520);
      }
      zombie.setTintFill(0xf0d6ae);
      if (!bossKind) {
        zombie.setVelocity(Math.cos(impactAngle) * 130, Math.sin(impactAngle) * 130);
        zombie.setData('staggerUntil', this.time.now + 85);
      }
      this.time.delayedCall(55, () => zombie.active && zombie.setTint(zombie.getData('tint')));
      return;
    }

    this.killZombie(zombie, impactAngle);
  }

  killZombie(zombie, impactAngle) {
    if (!zombie.active) return;
    const { x, y, rotation } = zombie;
    const type = zombie.getData('type');
    const bossKind = zombie.getData('bossKind') as BossKind | undefined;
    const baseScale = zombie.getData('baseScale');
    const voice = bossKind ? BOSS_DEFINITIONS[bossKind].voice : type as MonsterType;
    this.monsterAudio.play(voice, 'death', x, y, this.player.x, this.player.y);
    this.score += 1;
    this.scoreText.setText(String(this.score).padStart(5, '0'));
    this.tweens.add({ targets: this.scoreText, scale: 1.16, duration: 55, yoyo: true });

    const corpse = this.add.image(x, y, zombie.getData('textureKey'))
      .setDepth(-1)
      .setRotation(rotation + Phaser.Math.FloatBetween(-0.22, 0.22))
      .setScale(baseScale, baseScale * 0.82)
      .setTint(0x51352f)
      .setAlpha(0.55);
    this.corpses.push(corpse);
    if (this.corpses.length > 22) this.corpses.shift()!.destroy();
    this.tweens.add({ targets: corpse, alpha: 0.18, delay: 11500, duration: 4500 });

    zombie.getData('shadow')?.destroy();
    zombie.getData('aura')?.destroy();
    if (bossKind) {
      this.audio.endBossTheme(zombie.getData('bossEncounterId'));
      this.clearBossTelegraphs(zombie);
      zombie.getData('bossName')?.destroy();
      zombie.getData('bossHealthBack')?.destroy();
      zombie.getData('bossHealthFill')?.destroy();
      zombie.getData('bossHealthTicks')?.forEach((tick: Phaser.GameObjects.Rectangle) => tick.destroy());
      const phaseLabel = zombie.getData('phaseLabel');
      if (phaseLabel) {
        this.tweens.killTweensOf(phaseLabel);
        phaseLabel.destroy();
      }
      this.tweens.killTweensOf(zombie);
    }
    zombie.destroy();

    if (type === 'charred') this.makeBlast(x, y, impactAngle);
    if (bossKind) {
      this.audio.playTone(bossKind === 'furnace' ? 84 : 44, 0.9, 0.085, 'sawtooth');
      this.makeBossShockwave(x, y, BOSS_DEFINITIONS[bossKind].color);
      this.announce(`${BOSS_DEFINITIONS[bossKind].name} DOWN`, 'APEX CONTACT ELIMINATED');
      if (bossKind === 'furnace') {
        this.makeBlast(x, y, impactAngle, 145, 4);
        this.damageLivingInRadius(x, y, 128, 44);
      }
    }
  }

  makeBlast(x, y, impactAngle, radius = 76, damage = 2, source?: any, applyDamage = true) {
    this.queueNetworkEffect({ kind: 'blast', x, y, angle: impactAngle, radius });
    if (!this.isNetworkClient || applyDamage) {
      this.audio.playNoise(0.32, 0.13, 850, { x, y });
      this.audio.playTone(72, 0.34, 0.09, 'sawtooth', { x, y });
    }
    const blastScale = radius / 76;
    this.lighting.addExplosionLight(x, y, radius);
    const glow = this.add.image(x, y, 'glow')
      .setDepth(22)
      .setScale(0.7 * blastScale)
      .setTint(0xff7426)
      .setAlpha(1)
      .setBlendMode(Phaser.BlendModes.ADD);
    const hotGlow = this.add.image(x, y, 'glow')
      .setDepth(22)
      .setScale(0.3 * blastScale)
      .setTint(0xffd15c)
      .setAlpha(1)
      .setBlendMode(Phaser.BlendModes.ADD);
    const explosion = this.add.sprite(x, y, 'explosion')
      .setDepth(23)
      .setScale(Phaser.Math.Clamp(blastScale * 1.45, 1.45, 2.55))
      .setRotation(Phaser.Math.RND.pick([0, Math.PI / 2, Math.PI, Math.PI * 1.5]));
    this.tweens.add({ targets: glow, scale: 3.1 * blastScale, alpha: 0, duration: 390, onComplete: () => glow.destroy() });
    this.tweens.add({ targets: hotGlow, scale: 1.8 * blastScale, alpha: 0, duration: 210, onComplete: () => hotGlow.destroy() });
    explosion.play('barrel-explosion');
    explosion.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => explosion.destroy());
    this.cameras.main.shake(140, 0.006 * blastScale);

    if (this.isNetworkClient || !applyDamage) return;
    this.zombies.getChildren().slice().forEach((other) => {
      if (!other.active || other === source || Phaser.Math.Distance.Between(x, y, other.x, other.y) > radius) return;
      const angle = Phaser.Math.Angle.Between(x, y, other.x, other.y);
      const health = other.getData('health') - damage;
      other.setData('health', health);
      const bossKind = other.getData('bossKind') as BossKind | undefined;
      if (bossKind) {
        const healthFill = other.getData('bossHealthFill') as Phaser.GameObjects.Rectangle;
        healthFill.setScale(Phaser.Math.Clamp(health / Math.max(1, other.getData('maxHealth')), 0, 1), 1);
        this.maybeEnrageBoss(other, health);
      }
      this.makeBlood(other.x, other.y, angle, 4);
      if (health <= 0) {
        this.killZombie(other, angle);
      } else {
        other.setVelocity(Math.cos(angle) * 220, Math.sin(angle) * 220);
        other.setData('staggerUntil', this.time.now + 160);
      }
    });
  }

  makeBlood(x, y, angle, amount) {
    this.queueNetworkEffect({ kind: 'blood', x, y, angle, amount });
    const decal = this.add.image(x, y, 'blood')
      .setDepth(-2)
      .setScale(Phaser.Math.FloatBetween(1.1, 2.2))
      .setRotation(Phaser.Math.FloatBetween(0, Math.PI * 2))
      .setAlpha(0.58);
    this.bloodDecals.push(decal);
    if (this.bloodDecals.length > 45) this.bloodDecals.shift()!.destroy();

    for (let i = 0; i < amount; i += 1) {
      const sprayAngle = angle + Phaser.Math.FloatBetween(-0.65, 0.65);
      const drop = this.add.image(x, y, 'blood').setDepth(7).setScale(Phaser.Math.FloatBetween(0.25, 0.65));
      const distance = Phaser.Math.Between(10, 34);
      this.tweens.add({
        targets: drop,
        x: x + Math.cos(sprayAngle) * distance,
        y: y + Math.sin(sprayAngle) * distance,
        alpha: 0,
        duration: Phaser.Math.Between(180, 330),
        onComplete: () => drop.destroy(),
      });
    }
  }

  private applyPlayerKnockback(
    angle: number,
    force: number,
    duration: number,
    playerId: DuoPlayerId = this.combatTargetId ?? this.localPlayerId,
  ): void {
    const actor = this.actor(playerId);
    if (!actor || !actor.alive) return;
    actor.knockbackVelocity.set(Math.cos(angle) * force, Math.sin(angle) * force);
    actor.knockbackDuration = duration;
    actor.knockbackUntil = this.time.now + duration;
    if (playerId === this.localPlayerId) {
      this.playerKnockbackVelocity.copy(actor.knockbackVelocity);
      this.playerKnockbackDuration = duration;
      this.playerKnockbackUntil = actor.knockbackUntil;
    }
  }

  private damageLivingInRadius(x: number, y: number, radius: number, amount: number): void {
    this.livingActors().forEach((actor) => {
      if (Phaser.Math.Distance.Between(x, y, actor.sprite.x, actor.sprite.y) <= radius) {
        this.damagePlayer(amount, actor.id);
      }
    });
  }

  private knockbackZombiesInRadius(
    x: number,
    y: number,
    radius: number,
    force: number,
    duration: number,
  ): void {
    if (this.isNetworkClient) return;
    this.zombies.getChildren().slice().forEach((zombie) => {
      if (!zombie.active) return;
      const distance = Phaser.Math.Distance.Between(x, y, zombie.x, zombie.y);
      if (distance > radius) return;
      const angle = distance < 1
        ? Phaser.Math.FloatBetween(0, Math.PI * 2)
        : Phaser.Math.Angle.Between(x, y, zombie.x, zombie.y);
      const appliedForce = zombie.getData('bossKind') ? Math.min(force, 180) : force;
      zombie.setVelocity(Math.cos(angle) * appliedForce, Math.sin(angle) * appliedForce);
      zombie.setData('staggerUntil', this.time.now + duration);
    });
  }

  private playLocalDamageFeedback(actor: PlayerActor): void {
    this.audio.playToneLocally(68, 0.2, 0.07, 'sawtooth');
    actor.sprite.setTintFill(0xffe6d3);
    this.time.delayedCall(90, () => actor.alive && actor.sprite.clearTint());
    this.cameras.main.shake(160, 0.009);
    this.cameras.main.flash(80, 120, 18, 12, false);
  }

  damagePlayer(amount: number, playerId: DuoPlayerId = this.combatTargetId ?? this.localPlayerId): boolean {
    const actor = this.actor(playerId);
    if (!actor || !actor.alive || this.isGameOver) return false;
    const lastHurt = this.lastHurtByPlayer.get(playerId) ?? -1000;
    if (this.time.now - lastHurt < 470 || this.time.now < actor.invulnerableUntil) return false;
    this.lastHurtByPlayer.set(playerId, this.time.now);
    this.lastHurt = this.time.now;
    actor.health = Math.max(0, actor.health - amount);
    if (playerId === this.localPlayerId) this.health = actor.health;
    this.emitDuoEvent('player-hit', { playerId });
    actor.healthBar?.setScale(Phaser.Math.Clamp(actor.health / 100, 0, 1), 1);
    actor.healthBar?.setFillStyle(actor.health <= 35 ? 0xd4513f : actor.color);
    if (playerId === this.localPlayerId) this.playLocalDamageFeedback(actor);
    if (actor.health <= 0) {
      actor.alive = false;
      if (actor.sprite.body) actor.sprite.body.enable = false;
      actor.sprite.setVelocity(0).setTint(0x6f5550);
      actor.invulnerableUntil = 0;
      this.announce(`${actor.callsign} DOWN`, this.isDuo ? 'WAIT FOR A MEDKIT REVIVAL' : 'THE OUTPOST HAS LOST ITS LAST SURVIVOR');
      if (!this.livingActors().length) this.gameOver();
    }
    return true;
  }

  healPlayer(amount: number) {
    const targets = this.isDuo ? [...this.playerActors.values()] : [this.actor(this.localPlayerId)!];
    const previousHealth = this.health;
    let healed = false;
    targets.forEach((actor) => {
      if (!actor) return;
      const revived = !actor.alive || actor.health <= 0;
      if (!actor.alive || actor.health < 100) healed = true;
      actor.health = Math.min(100, actor.health + amount);
      actor.alive = true;
      actor.sprite.setAlpha(1).clearTint();
      if (actor.sprite.body) actor.sprite.body.enable = true;
      actor.invulnerableUntil = this.time.now + 650;
      if (revived) {
        // A revival gives nearby zombies the same breathing room as a barrel
        // impact, without damaging them. The host owns zombie simulation in
        // duos, so the resulting movement is replicated in the next snapshot.
        this.knockbackZombiesInRadius(actor.sprite.x, actor.sprite.y, 58, 270, 220);
        this.announce(`${actor.callsign} REVIVED`, 'MEDKIT RECOVERY // SURVIVOR BACK IN ACTION');
      }
    });
    const local = this.actor(this.localPlayerId)!;
    this.health = local.health;
    targets.forEach((actor) => {
      actor.healthBar
        ?.setScale(Phaser.Math.Clamp(actor.health / 100, 0, 1), 1)
        .setFillStyle(actor.health <= 35 ? 0xd4513f : actor.color, actor.alive ? 0.9 : 0.35);
    });
    if (healed || this.health > previousHealth) {
      const healingVignette = this.add.image(WIDTH / 2, HEIGHT / 2, 'status-vignette')
        .setDepth(24)
        .setTint(0xa9ef9a)
        .setAlpha(0)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: healingVignette,
        alpha: 0.18,
        duration: 140,
        yoyo: true,
        hold: 100,
        onComplete: () => healingVignette.destroy(),
      });
      this.cameras.main.flash(110, 126, 220, 142, false);
    }
  }

  private updateStatusEffects(time: number): void {
    const local = this.actor(this.localPlayerId);
    const remaining = this.supplies
      ? this.supplies.adrenalineRemaining(time, local?.sprite)
      : Math.max(0, (local?.adrenalineUntil ?? 0) - time);
    const active = remaining > 0;
    if (local) {
      if (active) local.sprite.setTint(0xffd18a);
      else if (local.sprite.tintTopLeft === 0xffd18a) local.sprite.clearTint();
    }
    if (active && !this.wasAdrenalineActive) {
      this.cameras.main.flash(120, 255, 111, 48, false);
      this.tweens.add({ targets: this.statusVignette, alpha: 0.2, duration: 160, yoyo: true });
    }
    this.wasAdrenalineActive = active;
    this.statusVignette.setAlpha(active ? 0.075 + Math.sin(time * 0.009) * 0.018 : 0);
    this.adrenalineText
      .setVisible(active)
      .setText(active ? `ADRENALINE  ${(remaining / 1000).toFixed(1)}s` : '');
  }

  hurtPlayer(playerSprite, zombie) {
    const playerId = (playerSprite.getData('playerId') as DuoPlayerId | undefined) ?? this.localPlayerId;
    const playerActor = this.actor(playerId) ?? this.actor(this.localPlayerId)!;
    const bossKind = zombie.getData('bossKind') as BossKind | undefined;
    const charging = bossKind === 'breaker' && zombie.getData('bossState') === 'charge';
    const damage = charging ? 38 : bossKind ? 22 : 18;
    if (!this.damagePlayer(damage, playerId)) return;
    if (charging) this.applyPlayerKnockback(zombie.getData('attackAngle'), 390, 360, playerId);
    this.monsterAudio.play(
      bossKind ? BOSS_DEFINITIONS[bossKind].voice : zombie.getData('type') as MonsterType,
      'attack',
      zombie.x,
      zombie.y,
      playerActor.sprite.x,
      playerActor.sprite.y,
    );
    const angle = this.enemyFacingAngle(zombie, playerActor);
    if (charging) {
      zombie.setVelocity(0).setData({
        bossState: 'recovery',
        stateUntil: this.time.now + 2000,
        chargesRemaining: 0,
      });
      this.makeBossShockwave(this.player.x, this.player.y, BOSS_DEFINITIONS.breaker.color);
    } else {
      zombie.setVelocity(-Math.cos(angle) * (bossKind ? 80 : 180), -Math.sin(angle) * (bossKind ? 80 : 180));
    }
  }

  gameOver(message?: string) {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.crosshair.setVisible(false);
    this.aimLaser.setVisible(false);
    if (this.touchEnabled) {
      window.dispatchEvent(new CustomEvent('last-light:mobile-visibility', {
        detail: { visible: false },
      }));
    }
    const survivalMs = this.getSurvivalMs();
    const disconnection = message?.startsWith('CONNECTION LOST') ?? false;
    window.dispatchEvent(new CustomEvent('last-light:game-over', {
      detail: {
        score: this.score,
        survivalMs,
        threat: this.director?.wave ?? this.networkWave,
        runId: this.runId,
        mode: this.isDuo ? 'duos' : 'solo',
        players: [...this.playerActors.values()].map((actor) => actor.callsign),
        host: !this.isDuo || this.duoOptions?.role === 'host',
        disconnection,
      },
    }));
    this.announcementQueue = [];
    this.director?.stop();
    if (this.isDuo && this.duoOptions?.role === 'host') {
      this.duoOptions.session.sendGameOver(message ?? 'OPERATION ENDED // BOTH SURVIVORS DOWN');
    }
    this.audio.beginDefeatTheme();
    this.playerActors.forEach((actor) => actor.sprite.setTint(0x8f4d44).setVelocity(0));
    this.cameras.main.shake(380, 0.015);
    this.cameras.main.zoomTo(1.045, 450, 'Sine.easeOut');

    const shade = this.add.rectangle(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, 0x050202, 0.88).setInteractive();
    const panel = this.add.rectangle(WIDTH / 2, HEIGHT / 2, 510, 324, 0x0c0b0b, 0.97)
      .setStrokeStyle(3, 0x962f27, 1);
    const inner = this.add.rectangle(WIDTH / 2, HEIGHT / 2, 494, 308)
      .setStrokeStyle(1, 0x4c211d, 1);
    const accent = this.add.rectangle(WIDTH / 2, HEIGHT / 2 - 154, 494, 5, 0xc44636, 1);
    const status = this.add.text(
      WIDTH / 2,
      HEIGHT / 2 - 126,
      message ? (disconnection ? 'PRIVATE LINK LOST // OPERATION ENDED' : 'OUTPOST LOST // SIGNAL TERMINATED') : 'OUTPOST LOST // SIGNAL TERMINATED',
      {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '11px',
      color: disconnection ? '#d04d3d' : '#d04d3d',
      },
    ).setOrigin(0.5);
    const title = this.add.text(WIDTH / 2, HEIGHT / 2 - 82, disconnection ? 'LINK LOST' : 'OVERRUN', {
      fontFamily: '"Changa One", sans-serif',
      fontSize: '62px',
      color: '#d85242',
      stroke: '#3b100e',
      strokeThickness: 8,
    }).setOrigin(0.5).setScale(1.5);
    const survivalSeconds = Math.floor(survivalMs / 1000);
    const survivalTime = `${String(Math.floor(survivalSeconds / 60)).padStart(2, '0')}:${String(survivalSeconds % 60).padStart(2, '0')}`;
    const result = this.add.text(
      WIDTH / 2,
      HEIGHT / 2 - 20,
      disconnection ? 'DISCONNECTION KILLED THE SURVIVORS' : `${this.score} HOSTILES  •  SURVIVED ${survivalTime}`,
      {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '17px',
      color: '#d8cdc0',
      },
    ).setOrigin(0.5);
    this.leaderboardResultText = this.add.text(
      WIDTH / 2,
      HEIGHT / 2 + 12,
      'CHECKING GLOBAL ARCHIVE...',
      {
        fontFamily: '"Share Tech Mono", monospace',
        fontSize: '12px',
        color: '#a99c91',
      },
    ).setOrigin(0.5);
    const rule = this.add.rectangle(WIDTH / 2, HEIGHT / 2 + 34, 390, 2, 0x7d2b24, 0.85);
    const canRedeploy = !disconnection && (!this.isDuo || this.duoOptions?.role === 'host');
    const redeployLabel = disconnection
      ? 'UNAVAILABLE'
      : this.isDuo && this.duoOptions?.role === 'guest'
        ? 'WAITING FOR HOST'
        : 'REDEPLOY';
    const redeployButton = this.makeOverlayButton(
      WIDTH / 2 - 106,
      HEIGHT / 2 + 77,
      196,
      redeployLabel,
      true,
      () => {
        if (this.isDuo) this.duoOptions?.session.sendRedeploy();
        this.audio.fadeOutMusic(() => this.scene.restart());
      },
      canRedeploy,
    );
    const menuButton = this.makeOverlayButton(
      WIDTH / 2 + 106,
      HEIGHT / 2 + 77,
      196,
      'MAIN MENU',
      false,
      () => this.audio.fadeOutMusic(() => this.returnToMenu()),
    );
    const footer = this.add.text(WIDTH / 2, HEIGHT / 2 + 133, 'THE LAST LIGHT // FIELD COMMAND', {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '11px',
      color: '#81766f',
    }).setOrigin(0.5);
    const overlay = this.add.container(0, 0, [
      shade,
      panel,
      inner,
      accent,
      status,
      title,
      result,
      this.leaderboardResultText,
      rule,
      ...redeployButton,
      ...menuButton,
      footer,
    ]).setDepth(50).setAlpha(0);
    this.tweens.add({ targets: overlay, alpha: 1, duration: 400 });
    this.tweens.add({ targets: title, scale: 1, duration: 430, ease: 'Back.out' });
  }
}

function interpolateDuoSnapshots(left: DuoSnapshot, right: DuoSnapshot, alpha: number): DuoSnapshot {
  return {
    ...right,
    elapsedMs: Math.round(lerp(left.elapsedMs, right.elapsedMs, alpha)),
    players: mergeSnapshotEntities(left.players, right.players, (previous, current) => ({
      ...current,
      x: lerp(previous.x, current.x, alpha),
      y: lerp(previous.y, current.y, alpha),
      rotation: lerpAngle(previous.rotation, current.rotation, alpha),
      health: lerp(previous.health, current.health, alpha),
    })),
    zombies: mergeSnapshotEntities(left.zombies, right.zombies, (previous, current) => ({
      ...current,
      x: lerp(previous.x, current.x, alpha),
      y: lerp(previous.y, current.y, alpha),
      rotation: lerpAngle(previous.rotation, current.rotation, alpha),
      health: lerp(previous.health, current.health, alpha),
      scale: lerp(previous.scale, current.scale, alpha),
      alpha: lerp(previous.alpha, current.alpha, alpha),
    })),
    bullets: mergeSnapshotEntities(left.bullets, right.bullets, (previous, current) => ({
      ...current,
      x: lerp(previous.x, current.x, alpha),
      y: lerp(previous.y, current.y, alpha),
      rotation: lerpAngle(previous.rotation, current.rotation, alpha),
    })),
    props: mergeSnapshotEntities(left.props, right.props, (previous, current) => ({
      ...current,
      x: lerp(previous.x, current.x, alpha),
      y: lerp(previous.y, current.y, alpha),
      rotation: lerpAngle(previous.rotation, current.rotation, alpha),
      health: lerp(previous.health, current.health, alpha),
    })),
    flare: left.flare && right.flare
      ? {
        x: lerp(left.flare.x, right.flare.x, alpha),
        y: lerp(left.flare.y, right.flare.y, alpha),
        intensity: lerp(left.flare.intensity, right.flare.intensity, alpha),
      }
      : right.flare ?? left.flare,
  };
}

function mergeSnapshotEntities<T extends { id: string }>(
  left: T[],
  right: T[],
  interpolate: (previous: T, current: T) => T,
): T[] {
  const previousById = new Map(left.map((entity) => [entity.id, entity]));
  const currentById = new Map(right.map((entity) => [entity.id, entity]));
  const ids = new Set([...previousById.keys(), ...currentById.keys()]);
  return [...ids].map((id) => {
    const previous = previousById.get(id);
    const current = currentById.get(id);
    if (previous && current) return interpolate(previous, current);
    return current ?? previous!;
  });
}

function lerp(left: number, right: number, alpha: number): number {
  return left + (right - left) * alpha;
}

function lerpAngle(left: number, right: number, alpha: number): number {
  let difference = right - left;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return left + difference * alpha;
}

function neutralDuoInput(): DuoInput {
  return {
    sequence: 0,
    moveX: 0,
    moveY: 0,
    aim: -Math.PI / 2,
    firing: false,
    flare: false,
    interact: false,
  };
}

function sanitizeDuoInput(input: DuoInput): DuoInput {
  return {
    sequence: Number.isInteger(input?.sequence) ? Math.max(0, input.sequence) : 0,
    moveX: Number.isFinite(input?.moveX) ? Phaser.Math.Clamp(input.moveX, -1, 1) : 0,
    moveY: Number.isFinite(input?.moveY) ? Phaser.Math.Clamp(input.moveY, -1, 1) : 0,
    aim: Number.isFinite(input?.aim) ? input.aim : -Math.PI / 2,
    firing: input?.firing === true,
    flare: input?.flare === true,
    interact: input?.interact === true,
  };
}
