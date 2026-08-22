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
import { AudioSystem } from '../systems/AudioSystem';
import { FlareSystem } from '../systems/FlareSystem';
import { LightingSystem, type ShadowCaster } from '../systems/LightingSystem';
import { MonsterAudioSystem, type MonsterType } from '../systems/MonsterAudioSystem';
import { SupplySystem } from '../systems/SupplySystem';
import { WaveDirector, type BossKind } from '../systems/WaveDirector';

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
  debug?: Phaser.Input.Keyboard.Key;
  spawnBreaker?: Phaser.Input.Keyboard.Key;
  spawnLurker?: Phaser.Input.Keyboard.Key;
  spawnFurnace?: Phaser.Input.Keyboard.Key;
  spawnSpitter?: Phaser.Input.Keyboard.Key;
}

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

const MAX_ACTIVE_ZOMBIES = 90;
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
  private runId = '';
  private lastShot = 0;
  private lastHurt = -1000;
  private playerKnockbackUntil = 0;
  private playerKnockbackDuration = 0;
  private playerKnockbackVelocity = new Phaser.Math.Vector2();
  private isGameOver = false;
  private isPaused = false;
  private bloodDecals: Phaser.GameObjects.Image[] = [];
  private corpses: Phaser.GameObjects.Image[] = [];
  private trees: TreeLayers[] = [];
  private floodlightPositions: { x: number; y: number }[] = [];
  private announcementQueue: [string, string][] = [];
  private announcementActive = false;
  private generatorWearEvent?: Phaser.Time.TimerEvent;
  private barrelDropEvent?: Phaser.Time.TimerEvent;
  private barrelSlots: BarrelSlot[] = [];
  private bossHazards: BossHazard[] = [];

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
  private pauseMenu!: Phaser.GameObjects.Container;
  private generatorBeacon!: Phaser.GameObjects.Image;
  private generatorBeaconLight!: Phaser.GameObjects.Arc;
  private generatorMarker!: Phaser.GameObjects.Text;
  private statusVignette!: Phaser.GameObjects.Image;
  private adrenalineText!: Phaser.GameObjects.Text;
  private leaderboardResultText?: Phaser.GameObjects.Text;
  private wasAdrenalineActive = false;

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
    this.runId = crypto.randomUUID();
    this.lastShot = 0;
    this.lastHurt = -1000;
    this.playerKnockbackUntil = 0;
    this.playerKnockbackDuration = 0;
    this.playerKnockbackVelocity.set(0, 0);
    this.isGameOver = false;
    this.isPaused = false;
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
    window.addEventListener('last-light:leaderboard-result', this.handleLeaderboardResult);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener('last-light:leaderboard-result', this.handleLeaderboardResult);
      this.leaderboardResultText = undefined;
    });
    window.dispatchEvent(new CustomEvent('last-light:run-start'));
    this.audio = new AudioSystem(this);
    this.monsterAudio = new MonsterAudioSystem(this);

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
    this.flares = new FlareSystem(this, this.player, this.lighting, this.audio, {
      isGeneratorOnline: () => !this.lighting.generatorDestroyed,
      isGeneratorUnstable: () => this.lighting.isGeneratorUnstable(),
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
    });
    this.supplies = new SupplySystem(this, this.player, {
      getHealth: () => this.health,
      heal: (amount) => this.healPlayer(amount),
      canAddFlare: () => this.flares.canAddCharge(),
      getFlareCharges: () => this.flares.chargeCount(),
      addFlare: () => this.flares.addCharge(),
      needsRepair: () => this.outpostNeedsRepair(),
      getBaseIntegrity: () => this.outpostIntegrity(),
      repairOutpost: () => this.repairOutpost(),
      announce: (title, subtitle) => this.announce(title, subtitle),
      isGameOver: () => this.isGameOver,
    });
    this.bindControls();
    this.audio.startMusic();
    this.director = new WaveDirector(this, {
      spawnZombie: (edge) => this.spawnZombie(edge),
      spawnBoss: (kind, edge) => this.telegraphBoss(kind, edge),
      telegraphHorde: (edge) => this.telegraphHorde(edge),
      announce: (title, subtitle) => this.announce(title, subtitle),
      startPowerFailure: (wave) => this.startOutpostPowerFailure(wave),
      isGameOver: () => this.isGameOver,
    });
    this.director.start();

    this.physics.add.overlap(this.bullets, this.zombies, this.hitZombie, undefined, this);
    this.physics.add.overlap(this.bullets, this.barrels, this.hitBarrel, undefined, this);
    this.physics.add.overlap(this.bullets, this.solidProps, this.hitProp, undefined, this);
    this.physics.add.overlap(this.player, this.zombies, this.hurtPlayer, undefined, this);
    this.physics.add.collider(this.player, this.solidProps);
    this.physics.add.collider(this.player, this.barrels);
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

    this.time.delayedCall(700, () => this.announce('HOLD THE OUTPOST', 'WASD TO MOVE • MOUSE TO AIM AND FIRE'));
    this.cameras.main.fadeIn(350, 4, 7, 6);
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

    this.playerShadow = this.add.image(WIDTH / 2 + 2, HEIGHT / 2 + 3, 'soft-shadow')
      .setDisplaySize(36, 18)
      .setAlpha(0.72)
      .setDepth(1);
    this.playerGlow = this.add.image(WIDTH / 2, HEIGHT / 2, 'glow')
      .setScale(0.85)
      .setAlpha(0.38)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(16);

    this.player = this.physics.add.sprite(WIDTH / 2, HEIGHT / 2, 'soldier').setDepth(4);
    this.player.setCollideWorldBounds(true);
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setCircle(12, 20, 9);
    body.setMaxVelocity(PLAYER_SPEED);

    this.tracers = this.add.graphics().setDepth(18).setBlendMode(Phaser.BlendModes.ADD);
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
      prop.setData({ health, maxHealth: health, shadow: addShadow(x, y, key, rotation) });
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
    this.scheduleBarrelDrop(Phaser.Math.Between(30000, 45000));
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
    barrel.setData({ health: 2, shadow, exploded: false, slotIndex });
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

    const playerDistance = Phaser.Math.Distance.Between(x, y, this.player.x, this.player.y);
    if (playerDistance <= radius) {
      const angle = playerDistance < 1
        ? Phaser.Math.FloatBetween(0, Math.PI * 2)
        : Phaser.Math.Angle.Between(x, y, this.player.x, this.player.y);
      this.applyPlayerKnockback(angle, 250, 220);
    }

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
        healthFill.width = 56 * Math.max(0, health / zombie.getData('maxHealth'));
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

    this.healthBack = this.add.rectangle(this.player.x, this.player.y - 36, 38, 6, 0x0a0b0a, 0.58)
      .setStrokeStyle(1, 0x4d3029, 0.65)
      .setDepth(20);
    this.healthBar = this.add.rectangle(this.player.x, this.player.y - 36, 34, 2, 0xd4d37b, 0.76)
      .setDepth(21);
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

    this.waveText = this.add.text(WIDTH / 2, 20, 'THREAT 01', {
      ...labelStyle,
      color: '#c86759',
    }).setOrigin(0.5, 0).setDepth(30);
    this.helpText = this.add.text(WIDTH / 2, HEIGHT - 20, 'WASD / ARROWS  MOVE  •  MOUSE  AIM + FIRE  •  P / ESC  PAUSE', {
      ...labelStyle,
      color: '#c9b8ad',
      backgroundColor: '#0b0e0ccc',
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5, 1).setDepth(30);
    this.tweens.add({ targets: this.helpText, alpha: 0, delay: 7600, duration: 1200 });

    this.crosshair = this.add.graphics().setDepth(40);
    this.crosshair.lineStyle(1, 0xf3dc95, 0.9);
    this.crosshair.strokeCircle(0, 0, 7);
    this.crosshair.lineBetween(-11, 0, -5, 0).lineBetween(5, 0, 11, 0);
    this.crosshair.lineBetween(0, -11, 0, -5).lineBetween(0, 5, 0, 11);

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
    const pauseStatus = this.add.text(WIDTH / 2, HEIGHT / 2 - 162, 'FIELD OPERATIONS // SUSPENDED', {
      ...labelStyle,
      fontSize: '11px',
      color: '#d04d3d',
    }).setOrigin(0.5);
    const pauseTitle = this.add.text(WIDTH / 2, HEIGHT / 2 - 128, 'PAUSED', {
      fontFamily: '"Changa One", sans-serif',
      fontSize: '52px',
      color: '#e8dfcf',
      stroke: '#4f1714',
      strokeThickness: 7,
    }).setOrigin(0.5);
    const pauseControls = this.add.text(WIDTH / 2, HEIGHT / 2 - 31,
      'MOVE       WASD / ARROWS\nAIM        MOUSE\nFIRE       LEFT MOUSE\nFLARE      F\nINTERACT   E', {
        ...labelStyle,
        fontSize: '15px',
        color: '#d4c9b8',
        lineSpacing: 7,
      }).setOrigin(0.5);
    const pauseResumeButton = this.makeOverlayButton(
      WIDTH / 2 - 106,
      HEIGHT / 2 + 93,
      196,
      'RESUME',
      true,
      () => this.togglePause(),
    );
    const pauseMenuButton = this.makeOverlayButton(
      WIDTH / 2 + 106,
      HEIGHT / 2 + 93,
      196,
      'MAIN MENU',
      false,
      () => this.returnToMenu(),
    );
    const pauseShortcut = this.add.text(WIDTH / 2, HEIGHT / 2 + 160, 'P / ESC  RESUME FIELD OPERATIONS', {
      ...labelStyle,
      fontSize: '11px',
      color: '#81766f',
    }).setOrigin(0.5);
    this.pauseMenu = this.add.container(0, 0, [
      pauseShade,
      pausePanel,
      pauseInner,
      pauseAccent,
      pauseRule,
      pauseStatus,
      pauseTitle,
      pauseControls,
      ...pauseResumeButton,
      ...pauseMenuButton,
      pauseShortcut,
    ]).setDepth(60).setVisible(false);
  }

  private makeOverlayButton(
    x: number,
    y: number,
    width: number,
    text: string,
    primary: boolean,
    action: () => void,
  ): Phaser.GameObjects.GameObject[] {
    const restingFill = primary ? 0x9d3027 : 0x151413;
    const hoverFill = primary ? 0xc44636 : 0x2a1a18;
    const button = this.add.rectangle(x, y, width, 44, restingFill, 1)
      .setStrokeStyle(2, primary ? 0xe26954 : 0x71312a, 1)
      .setInteractive({ useHandCursor: true });
    const label = this.add.text(x, y, text, {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '16px',
      color: primary ? '#fff0dc' : '#d8cdc0',
    }).setOrigin(0.5);

    button.on('pointerover', () => button.setFillStyle(hoverFill));
    button.on('pointerout', () => button.setFillStyle(restingFill));
    button.on('pointerup', action);
    return [button, label];
  }

  private returnToMenu(): void {
    if (!this.isGameOver) {
      window.dispatchEvent(new CustomEvent('last-light:game-over', {
        detail: {
          score: this.score,
          survivalMs: this.time.now - this.startedAt,
          threat: this.director.wave,
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
    this.input.mouse!.disableContextMenu();
    this.input.on('pointerdown', () => {
      if (this.sound.locked) this.sound.unlock?.();
    });
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    this.pauseMenu.setVisible(this.isPaused);
    this.crosshair.setVisible(!this.isPaused);

    if (this.isPaused) {
      this.player.setVelocity(0);
      this.physics.world.pause();
      this.time.paused = true;
      this.anims.pauseAll();
      this.tweens.pauseAll();
      this.sound.pauseAll?.();
      this.monsterAudio.setPaused(true);
      return;
    }

    this.physics.world.resume();
    this.time.paused = false;
    this.anims.resumeAll();
    this.tweens.resumeAll();
    this.sound.resumeAll?.();
    this.monsterAudio.setPaused(false);
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

  private telegraphHorde(edge: number): void {
    if (this.isGameOver) return;
    const warningX = edge === 1 ? WIDTH - 20 : edge === 3 ? 20 : WIDTH / 2;
    const warningY = edge === 0 ? 20 : edge === 2 ? HEIGHT - 20 : HEIGHT / 2;
    this.monsterAudio.play('shambler', 'spawn', warningX, warningY, this.player.x, this.player.y);
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

  private telegraphBoss(kind: BossKind, edge: number): void {
    if (this.isGameOver) return;
    const encounterId = this.audio.beginBossTheme(kind);
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
    this.telegraphHorde(edge);
    this.audio.playTone(kind === 'lurker' ? 54 : 42, 1.15, 0.075, 'sawtooth');
    this.audio.playNoise(0.7, 0.045, kind === 'furnace' ? 720 : 480);
    this.cameras.main.flash(90, color.red, color.green, color.blue, false);
    this.cameras.main.shake(260, 0.0045);
    this.time.delayedCall(2050, () => this.spawnBoss(kind, edge, encounterId));
  }

  private spawnDebugBoss(kind: BossKind): void {
    if (this.isGameOver) return;
    this.announce('APEX CONTACT', `${BOSS_DEFINITIONS[kind].name} IS ENTERING THE KILL ZONE`);
    this.telegraphBoss(kind, Phaser.Math.Between(0, 3));
  }

  announce(title: string, subtitle: string) {
    if (this.isGameOver) return;
    this.announcementQueue.push([title, subtitle]);
    if (!this.announcementActive) this.showNextAnnouncement();
  }

  private showNextAnnouncement(): void {
    const message = this.announcementQueue.shift();
    if (!message || this.isGameOver) {
      this.announcementActive = false;
      return;
    }
    this.announcementActive = true;
    const [title, subtitle] = message;
    this.audio.playAlert();
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
    this.crosshair.setPosition(Math.round(pointer.worldX), Math.round(pointer.worldY));

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

    if (this.isGameOver) {
      this.player.setVelocity(0);
      return;
    }

    const horizontal = Number(this.keys.right.isDown || this.keys.rightAlt.isDown)
      - Number(this.keys.left.isDown || this.keys.leftAlt.isDown);
    const vertical = Number(this.keys.down.isDown || this.keys.downAlt.isDown)
      - Number(this.keys.up.isDown || this.keys.upAlt.isDown);
    const moveSpeed = PLAYER_SPEED * this.supplies.movementMultiplier(time);
    const movement = new Phaser.Math.Vector2(horizontal, vertical)
      .normalize()
      .scale(moveSpeed);
    const playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    if (time < this.playerKnockbackUntil) {
      const remaining = (this.playerKnockbackUntil - time) / this.playerKnockbackDuration;
      const force = 0.35 + remaining * 0.65;
      playerBody.setMaxVelocity(this.playerKnockbackVelocity.length());
      this.player.setVelocity(
        this.playerKnockbackVelocity.x * force,
        this.playerKnockbackVelocity.y * force,
      );
    } else {
      playerBody.setMaxVelocity(moveSpeed);
      this.player.setVelocity(movement.x, movement.y);
    }
    this.supplies.update(time);

    const aim = Phaser.Math.Angle.Between(this.player.x, this.player.y, pointer.worldX, pointer.worldY);
    this.player.rotation = aim - SOUTH_OFFSET;
    (this.player.body as Phaser.Physics.Arcade.Body).setCircle(
      12,
      20 - Math.cos(aim) * 11,
      20 - Math.sin(aim) * 11,
    );
    this.playerShadow
      .setPosition(this.player.x + 2, this.player.y + 3)
      .setRotation(this.player.rotation);
    this.playerGlow.setPosition(this.player.x, this.player.y);
    const healthBarX = this.player.x - Math.cos(aim) * 36;
    const healthBarY = this.player.y - Math.sin(aim) * 36;
    this.healthBack.setPosition(healthBarX, healthBarY).setRotation(this.player.rotation);
    const healthFillOffset = (this.healthBar.width - 34) / 2;
    this.healthBar
      .setPosition(
        healthBarX + Math.cos(this.player.rotation) * healthFillOffset,
        healthBarY + Math.sin(this.player.rotation) * healthFillOffset,
      )
      .setRotation(this.player.rotation);
    this.flares.update(time, aim);
    this.updateStatusEffects(time);

    if (pointer.isDown && time - this.lastShot >= this.supplies.fireInterval(time)) this.shoot(aim, time);

    this.waveText.setText(`THREAT ${String(this.director.wave).padStart(2, '0')}`);
    this.lighting.lowHealthShade.setAlpha(this.health <= 35 ? 0.035 + Math.sin(time * 0.006) * 0.025 : 0);
    this.tracers.clear().lineStyle(2, 0xffd66f, 0.7);

    this.trees.forEach(({ x, y, canopy }) => {
      const targetAlpha = Phaser.Math.Distance.Between(this.player.x, this.player.y, x, y) < 54 ? 0.34 : 0.96;
      canopy.setAlpha(Phaser.Math.Linear(canopy.alpha, targetAlpha, 0.12));
    });

    this.zombies.children.iterate((zombie) => {
      if (!zombie?.active) return;
      if (zombie.getData('bossKind')) {
        this.updateBoss(zombie, time);
        return;
      }
      const angle = Phaser.Math.Angle.Between(zombie.x, zombie.y, this.player.x, this.player.y);
      const crawler = zombie.getData('type') === 'crawler';
      const crawlPulse = crawler ? 0.68 + Math.max(0, Math.sin(zombie.getData('step') * 1.7)) * 0.32 : 1;
      const speed = zombie.getData('speed') * crawlPulse;
      if (time >= zombie.getData('staggerUntil')) {
        zombie.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
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
    this.updateBossHazards(time);

    const emberLights = this.zombies.getChildren()
      .filter((zombie) => zombie.active
        && (zombie.getData('type') === 'charred' || zombie.getData('bossKind') === 'furnace'))
      .map((zombie) => ({ x: zombie.x, y: zombie.y }));
    this.lighting.redraw(this.player.x, this.player.y, aim, this.collectShadowCasters(), emberLights);

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
  }

  private updateBoss(boss: any, time: number): void {
    const kind = boss.getData('bossKind') as BossKind;
    const definition = BOSS_DEFINITIONS[kind];
    const angle = Phaser.Math.Angle.Between(boss.x, boss.y, this.player.x, this.player.y);
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
        this.steerBossAroundObstacles(boss, angle, definition.speed);
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
      if (Phaser.Math.Distance.Between(boss.x, boss.y, this.player.x, this.player.y) <= 112
        && this.damagePlayer(30)) {
        this.applyPlayerKnockback(
          Phaser.Math.Angle.Between(boss.x, boss.y, this.player.x, this.player.y),
          310,
          320,
        );
      }
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
    if (Phaser.Math.Distance.Between(boss.x, boss.y, this.player.x, this.player.y) <= radius) {
      this.damagePlayer(damage);
    }
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
  ): Phaser.GameObjects.Arc {
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
    this.audio.playNoise(0.35, 0.07, 850);
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
      const normalizedX = (this.player.x - hazard.pool.x) / hazard.radiusX;
      const normalizedY = (this.player.y - hazard.pool.y) / hazard.radiusY;
      if (time >= hazard.nextDamageAt && normalizedX * normalizedX + normalizedY * normalizedY <= 1) {
        hazard.nextDamageAt = time + 900;
        this.damagePlayer(12);
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

    addBody(this.player);
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

  shoot(angle, time) {
    this.lastShot = time;
    this.audio.playNoise(0.055, 0.075, 2100);
    this.audio.playTone(115, 0.065, 0.045);
    // The source art aims due south, with the muzzle on its lower centerline.
    const muzzleDistance = 29;
    const muzzleX = this.player.x + Math.cos(angle) * muzzleDistance;
    const muzzleY = this.player.y + Math.sin(angle) * muzzleDistance;
    const pointBlankZombie = this.findZombieBetweenPlayerAnd(muzzleX, muzzleY);
    const bullet = this.bullets.get(muzzleX, muzzleY, 'bullet');
    if (!bullet) return;
    bullet.enableBody(true, muzzleX, muzzleY, true, true);
    bullet.setDepth(8).setRotation(angle);
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
    const glow = this.add.image(muzzleX, muzzleY, 'glow')
      .setScale(1.05)
      .setDepth(21)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: [flash, glow], alpha: 0, scale: 0.2, duration: 75, onComplete: () => { flash.destroy(); glow.destroy(); } });

    const side = angle + Math.PI / 2;
    const casing = this.add.image(
      this.player.x + Math.cos(side) * 9,
      this.player.y + Math.sin(side) * 9,
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

    this.player.x -= Math.cos(angle) * 1.4;
    this.player.y -= Math.sin(angle) * 1.4;
  }

  private findZombieBetweenPlayerAnd(x: number, y: number) {
    const line = new Phaser.Geom.Line(this.player.x, this.player.y, x, y);
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
        startsInside = Phaser.Geom.Circle.Contains(circle, this.player.x, this.player.y);
        intersections = Phaser.Geom.Intersects.GetLineToCircle(line, circle);
      } else {
        const rectangle = new Phaser.Geom.Rectangle(body.x, body.y, body.width, body.height);
        if (!Phaser.Geom.Intersects.LineToRectangle(line, rectangle)) return;
        startsInside = Phaser.Geom.Rectangle.Contains(rectangle, this.player.x, this.player.y);
        intersections = Phaser.Geom.Intersects.GetLineToRectangle(line, rectangle);
      }

      const distance = startsInside
        ? 0
        : Math.min(...intersections.map((point) => Phaser.Math.Distance.Squared(
          this.player.x,
          this.player.y,
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
    const effect = this.add.sprite(x, y, kind)
      .setDepth(23)
      .setRotation(angle)
      .setScale(kind === 'blood-hit' ? 1.15 : 1);
    effect.play(kind);
    effect.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => effect.destroy());
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
    this.audio.playNoise(0.035, 0.026, 1800);

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
    if (Phaser.Math.Distance.Between(x, y, this.player.x, this.player.y) < 108) this.damagePlayer(34);
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
      type: type.name,
      textureKey: type.texture,
      health: type.health,
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
      healthFill.width = 56 * Math.max(0, health / zombie.getData('maxHealth'));
      this.maybeEnrageBoss(zombie, health);
    }

    this.playImpactEffect('blood-hit', zombie.x, zombie.y, impactAngle);
    this.makeBlood(zombie.x, zombie.y, impactAngle, health <= 0 ? (bossKind ? 13 : 7) : (bossKind ? 5 : 3));
    if (breakerArmored) this.makeSparks(zombie.x, zombie.y, impactAngle, 3);
    this.audio.playNoise(health <= 0 ? 0.07 : 0.035, health <= 0 ? 0.045 : 0.025, 620);
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
        if (Phaser.Math.Distance.Between(x, y, this.player.x, this.player.y) <= 128) this.damagePlayer(44);
      }
    }
  }

  makeBlast(x, y, impactAngle, radius = 76, damage = 2, source?: any) {
    this.audio.playNoise(0.32, 0.13, 850);
    this.audio.playTone(72, 0.34, 0.09, 'sawtooth');
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

    this.zombies.getChildren().slice().forEach((other) => {
      if (!other.active || other === source || Phaser.Math.Distance.Between(x, y, other.x, other.y) > radius) return;
      const angle = Phaser.Math.Angle.Between(x, y, other.x, other.y);
      const health = other.getData('health') - damage;
      other.setData('health', health);
      const bossKind = other.getData('bossKind') as BossKind | undefined;
      if (bossKind) {
        const healthFill = other.getData('bossHealthFill') as Phaser.GameObjects.Rectangle;
        healthFill.width = 56 * Math.max(0, health / other.getData('maxHealth'));
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

  private applyPlayerKnockback(angle: number, force: number, duration: number): void {
    this.playerKnockbackVelocity.set(Math.cos(angle) * force, Math.sin(angle) * force);
    this.playerKnockbackDuration = duration;
    this.playerKnockbackUntil = this.time.now + duration;
  }

  damagePlayer(amount) {
    if (this.time.now - this.lastHurt < 470 || this.isGameOver) return false;
    this.lastHurt = this.time.now;
    this.health = Math.max(0, this.health - amount);
    this.audio.playTone(68, 0.2, 0.07, 'sawtooth');
    this.healthBar.width = 34 * (this.health / 100);
    this.healthBar.setFillStyle(this.health <= 35 ? 0xd4513f : 0xd4d37b);
    this.player.setTintFill(0xffe6d3);
    this.time.delayedCall(90, () => this.player.clearTint());
    this.cameras.main.shake(160, 0.009);
    this.cameras.main.flash(80, 120, 18, 12, false);
    if (this.health <= 0) this.gameOver();
    return true;
  }

  healPlayer(amount: number) {
    const previousHealth = this.health;
    this.health = Math.min(100, this.health + amount);
    this.healthBar.setFillStyle(this.health <= 35 ? 0xd4513f : 0xd4d37b);
    this.tweens.add({
      targets: this.healthBar,
      width: 34 * (this.health / 100),
      duration: 380,
      ease: 'Quad.out',
    });
    if (this.health > previousHealth) {
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
    const remaining = this.supplies.adrenalineRemaining(time);
    const active = remaining > 0;
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

  hurtPlayer(_player, zombie) {
    const bossKind = zombie.getData('bossKind') as BossKind | undefined;
    const charging = bossKind === 'breaker' && zombie.getData('bossState') === 'charge';
    const damage = charging ? 38 : bossKind ? 22 : 18;
    if (!this.damagePlayer(damage)) return;
    if (charging) this.applyPlayerKnockback(zombie.getData('attackAngle'), 390, 360);
    this.monsterAudio.play(
      bossKind ? BOSS_DEFINITIONS[bossKind].voice : zombie.getData('type') as MonsterType,
      'attack',
      zombie.x,
      zombie.y,
      this.player.x,
      this.player.y,
    );
    const angle = Phaser.Math.Angle.Between(zombie.x, zombie.y, this.player.x, this.player.y);
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

  gameOver() {
    this.isGameOver = true;
    const survivalMs = this.time.now - this.startedAt;
    window.dispatchEvent(new CustomEvent('last-light:game-over', {
      detail: { score: this.score, survivalMs, threat: this.director.wave, runId: this.runId },
    }));
    this.announcementQueue = [];
    this.director.stop();
    this.audio.beginDefeatTheme();
    this.player.setTint(0x8f4d44);
    this.cameras.main.shake(380, 0.015);
    this.cameras.main.zoomTo(1.045, 450, 'Sine.easeOut');

    const shade = this.add.rectangle(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, 0x050202, 0.88).setInteractive();
    const panel = this.add.rectangle(WIDTH / 2, HEIGHT / 2, 510, 324, 0x0c0b0b, 0.97)
      .setStrokeStyle(3, 0x962f27, 1);
    const inner = this.add.rectangle(WIDTH / 2, HEIGHT / 2, 494, 308)
      .setStrokeStyle(1, 0x4c211d, 1);
    const accent = this.add.rectangle(WIDTH / 2, HEIGHT / 2 - 154, 494, 5, 0xc44636, 1);
    const status = this.add.text(WIDTH / 2, HEIGHT / 2 - 126, 'OUTPOST LOST // SIGNAL TERMINATED', {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '11px',
      color: '#d04d3d',
    }).setOrigin(0.5);
    const title = this.add.text(WIDTH / 2, HEIGHT / 2 - 82, 'OVERRUN', {
      fontFamily: '"Changa One", sans-serif',
      fontSize: '62px',
      color: '#d85242',
      stroke: '#3b100e',
      strokeThickness: 8,
    }).setOrigin(0.5).setScale(1.5);
    const survivalSeconds = Math.floor(survivalMs / 1000);
    const survivalTime = `${String(Math.floor(survivalSeconds / 60)).padStart(2, '0')}:${String(survivalSeconds % 60).padStart(2, '0')}`;
    const result = this.add.text(WIDTH / 2, HEIGHT / 2 - 20, `${this.score} HOSTILES  •  SURVIVED ${survivalTime}`, {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '17px',
      color: '#d8cdc0',
    }).setOrigin(0.5);
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
    const redeployButton = this.makeOverlayButton(
      WIDTH / 2 - 106,
      HEIGHT / 2 + 77,
      196,
      'REDEPLOY',
      true,
      () => this.audio.fadeOutMusic(() => this.scene.restart()),
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
