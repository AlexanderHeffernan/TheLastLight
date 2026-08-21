import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH, GENERATOR_POSITION } from '../config/constants';
import type { AudioSystem } from './AudioSystem';
import type { LightingSystem } from './LightingSystem';

interface FlareHooks {
  isGeneratorOnline: () => boolean;
  isGeneratorUnstable: () => boolean;
  isPlayerAlive: () => boolean;
  isGameOver: () => boolean;
  announce: (title: string, subtitle: string) => void;
  setGeneratorStatus: (status: string) => void;
  emitNetworkEvent?: (
    type: 'flare-cartridge' | 'flare-collected' | 'flare-launch' | 'flare-ignite',
    payload: Record<string, unknown>,
  ) => void;
}

export class FlareSystem {
  private readonly capacity = 3;
  private readonly rechargeDuration = 45000;
  private readonly firstChargeDuration = 38000;
  private readonly key: Phaser.Input.Keyboard.Key;
  private readonly touchEnabled = typeof window !== 'undefined'
    && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  private readonly inventoryText: Phaser.GameObjects.Text;
  private readonly chargeText: Phaser.GameObjects.Text;
  private charges = 0;
  private rechargeElapsed = 0;
  private unlocked = false;
  private lastUpdate = 0;
  private activeUntil = 0;
  private launching = false;
  private pendingCartridge?: Phaser.Physics.Arcade.Image;
  private pendingOverlaps: Phaser.Physics.Arcade.Collider[] = [];
  private readonly players: Phaser.Physics.Arcade.Sprite[];
  private lastInventoryLabel = '';
  private lastDetailLabel = '';
  private lastGeneratorLabel = '';

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly player: Phaser.Physics.Arcade.Sprite,
    private readonly lighting: LightingSystem,
    private readonly audio: AudioSystem,
    private readonly hooks: FlareHooks,
  ) {
    this.players = [player];
    this.key = scene.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F);
    const textStyle = {
      fontFamily: '"Share Tech Mono", monospace',
      color: '#e2c690',
      backgroundColor: '#090c0acc',
      padding: { x: 5, y: 2 },
    };
    this.inventoryText = scene.add.text(GAME_WIDTH - 25, 16, '', {
      ...textStyle,
      fontSize: '14px',
      color: '#ff7663',
      padding: { x: 7, y: 4 },
    }).setOrigin(1, 0).setDepth(30).setVisible(!this.touchEnabled);
    this.chargeText = scene.add.text(GAME_WIDTH - 25, 43, '', {
      ...textStyle,
      fontSize: '11px',
      color: '#e6d7c4',
      lineSpacing: 2,
      padding: { x: 7, y: 4 },
    }).setOrigin(1, 0).setDepth(30).setVisible(!this.touchEnabled);
    this.refreshHud();
  }

  update(time: number, aimAngle: number): void {
    const elapsed = this.lastUpdate === 0 ? 0 : Math.min(100, time - this.lastUpdate);
    this.lastUpdate = time;

    if (!this.pendingCartridge && this.hooks.isGeneratorOnline()) {
      this.rechargeElapsed += elapsed;
      const duration = this.unlocked ? this.rechargeDuration : this.firstChargeDuration;
      if (this.rechargeElapsed >= duration) {
        this.rechargeElapsed = 0;
        this.spawnFabricatedCartridge();
      }
    }

    if (Phaser.Input.Keyboard.JustDown(this.key) && this.hooks.isPlayerAlive()) this.fire(aimAngle, time);
    this.refreshHud();
  }

  canAddCharge(): boolean {
    return this.charges < this.capacity;
  }

  chargeCount(): number {
    return this.charges;
  }

  canFire(time: number): boolean {
    return !this.hooks.isGameOver()
      && this.charges > 0
      && !this.launching
      && time >= this.activeUntil;
  }

  chargeProgress(time: number): number {
    if (this.charges > 0 && !this.launching && time >= this.activeUntil) return 1;
    if (this.pendingCartridge) return 1;
    if (this.launching || time < this.activeUntil || !this.hooks.isGeneratorOnline()) return 0;
    const duration = this.unlocked ? this.rechargeDuration : this.firstChargeDuration;
    return Phaser.Math.Clamp(this.rechargeElapsed / duration, 0, 1);
  }

  addCharge(): boolean {
    if (!this.canAddCharge()) return false;
    this.charges += 1;
    this.unlocked = true;
    this.refreshHud();
    return true;
  }

  launch(angle: number, time: number, origin?: { x: number; y: number }): void {
    this.fire(angle, time, origin);
  }

  addPlayer(player: Phaser.Physics.Arcade.Sprite): void {
    this.players.push(player);
    if (this.pendingCartridge) this.addCartridgeOverlap(player, this.pendingCartridge);
  }

  private addCartridgeOverlap(
    player: Phaser.Physics.Arcade.Sprite,
    pickup: Phaser.Physics.Arcade.Image,
  ): void {
    this.pendingOverlaps.push(this.scene.physics.add.overlap(player, pickup, () => this.collectCartridge()));
  }

  private spawnFabricatedCartridge(): void {
    const startX = GENERATOR_POSITION.x + 20;
    const startY = GENERATOR_POSITION.y + 2;
    const targetX = GENERATOR_POSITION.x + 52;
    const targetY = GENERATOR_POSITION.y + 7;
    this.hooks.emitNetworkEvent?.('flare-cartridge', {
      startX,
      startY,
      targetX,
      targetY,
      duration: 620,
    });
    const shadow = this.scene.add.ellipse(startX, startY + 7, 20, 9, 0x000000, 0.3)
      .setDepth(2)
      .setScale(0.45);
    const glow = this.scene.add.image(startX, startY, 'glow')
      .setDepth(16)
      .setScale(0.38)
      .setAlpha(0.35)
      .setTint(0xff3d24)
      .setBlendMode(Phaser.BlendModes.ADD);
    const coreGlow = this.scene.add.image(startX, startY, 'glow')
      .setDepth(16)
      .setScale(0.16)
      .setAlpha(0.7)
      .setTint(0xff8b54)
      .setBlendMode(Phaser.BlendModes.ADD);
    const pickup = this.scene.physics.add.image(startX, startY, 'flare-cartridge')
      .setDepth(3)
      .setScale(0.55)
      .setAlpha(0.3)
      .setRotation(-0.55)
      .setData({ ready: false, shadow, glow, coreGlow });
    const body = pickup.body as Phaser.Physics.Arcade.Body;
    body.setCircle(11, 21, 21).setAllowGravity(false);
    this.pendingCartridge = pickup;
    this.players.forEach((player) => this.addCartridgeOverlap(player, pickup));
    this.audio.playTone(260, 0.14, 0.035, 'square');
    this.audio.playNoise(0.12, 0.025, 1600);

    this.scene.tweens.add({
      targets: pickup,
      x: targetX,
      y: targetY,
      scale: 1,
      alpha: 1,
      rotation: 0.18,
      duration: 620,
      ease: 'Back.out',
      onUpdate: () => {
        shadow.setPosition(pickup.x + 1, pickup.y + 7).setScale(0.45 + pickup.scale * 0.55);
        glow.setPosition(pickup.x, pickup.y).setScale(0.3 + pickup.scale * 0.5);
        coreGlow.setPosition(pickup.x, pickup.y).setScale(0.12 + pickup.scale * 0.2);
      },
      onComplete: () => {
        if (!pickup.active) return;
        pickup.setData('ready', true);
        this.scene.tweens.add({
          targets: pickup,
          y: targetY - 4,
          duration: 720,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.inOut',
          onUpdate: () => {
            shadow.setY(pickup.y + 7);
            glow.setY(pickup.y);
            coreGlow.setY(pickup.y);
          },
        });
        this.scene.tweens.add({
          targets: glow,
          alpha: { from: 0.58, to: 0.95 },
          scale: { from: 0.72, to: 0.94 },
          duration: 760,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.inOut',
        });
        this.scene.tweens.add({
          targets: coreGlow,
          alpha: { from: 0.76, to: 1 },
          scale: { from: 0.26, to: 0.38 },
          duration: 520,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.inOut',
        });
      },
    });
    this.hooks.announce('FLARE CARTRIDGE READY', 'GENERATOR OUTPUT • COLLECT IT ON THE RIGHT');
  }

  private collectCartridge(): void {
    const pickup = this.pendingCartridge;
    if (!pickup?.active || !pickup.getData('ready') || this.hooks.isGameOver() || !this.canAddCharge()) return;

    const shadow = pickup.getData('shadow');
    const glow = pickup.getData('glow');
    const coreGlow = pickup.getData('coreGlow');
    [pickup, glow, coreGlow].forEach((target) => this.scene.tweens.killTweensOf(target));
    shadow?.destroy();
    glow?.destroy();
    coreGlow?.destroy();
    this.pendingOverlaps.forEach((overlap) => overlap.destroy());
    this.pendingOverlaps = [];
    pickup.destroy();
    this.pendingCartridge = undefined;
    this.hooks.emitNetworkEvent?.('flare-collected', {});
    this.charges += 1;
    this.unlocked = true;
    this.audio.playTone(520, 0.13, 0.035, 'triangle');
    this.hooks.announce('FLARE COLLECTED', `${this.charges} / ${this.capacity} READY • PRESS F TO LAUNCH`);
    this.refreshHud();
  }

  fire(angle: number, time: number, origin: { x: number; y: number } = this.player): void {
    if (!this.hooks.isPlayerAlive()
      || this.hooks.isGameOver()
      || this.charges <= 0
      || this.launching
      || time < this.activeUntil) return;
    this.charges -= 1;
    this.launching = true;
    this.audio.playTone(186, 0.42, 0.055, 'sawtooth');
    this.audio.playNoise(0.38, 0.045, 1300);

    const startX = origin.x + Math.cos(angle) * 28;
    const startY = origin.y + Math.sin(angle) * 28;
    const targetX = Phaser.Math.Clamp(origin.x + Math.cos(angle) * 175, 110, GAME_WIDTH - 110);
    const targetY = Phaser.Math.Clamp(origin.y + Math.sin(angle) * 145, 145, GAME_HEIGHT - 70);
    const airborneY = targetY - 92;
    this.hooks.emitNetworkEvent?.('flare-launch', {
      startX,
      startY,
      targetX,
      targetY,
      airborneY,
      duration: 650,
    });
    const projectile = this.scene.add.image(startX, startY, 'flare-cartridge')
      .setDepth(23)
      .setRotation(angle)
      .setScale(1.15);
    const glow = this.scene.add.image(startX, startY, 'glow')
      .setDepth(22)
      .setScale(0.24)
      .setTint(0xff321c)
      .setAlpha(0.75)
      .setBlendMode(Phaser.BlendModes.ADD);
    const trail = this.scene.add.graphics().setDepth(21).setBlendMode(Phaser.BlendModes.ADD);

    this.scene.tweens.add({
      targets: projectile,
      x: targetX,
      y: airborneY,
      scale: 0.28,
      duration: 650,
      ease: 'Quad.out',
      onUpdate: () => {
        glow.setPosition(projectile.x, projectile.y).setScale(0.2 + projectile.scale * 0.16);
        trail.clear().lineStyle(2, 0xff5933, 0.7).lineBetween(startX, startY, projectile.x, projectile.y);
      },
      onComplete: () => {
        projectile.destroy();
        glow.destroy();
        trail.destroy();
        this.ignite(targetX, targetY);
      },
    });
  }

  private ignite(x: number, y: number): void {
    const duration = 14000;
    const airborneY = y - 92;
    this.hooks.emitNetworkEvent?.('flare-ignite', { x, y: airborneY, duration });
    this.launching = false;
    this.activeUntil = this.scene.time.now + duration;
    this.lighting.igniteAerialFlare(x, airborneY, duration);
    this.audio.playNoise(0.7, 0.055, 2200);
    this.audio.playTone(420, 0.5, 0.035, 'triangle');
    this.scene.cameras.main.flash(120, 255, 48, 24, false);
  }

  private refreshHud(): void {
    const visible = this.unlocked || !!this.pendingCartridge;
    this.inventoryText.setVisible(!this.touchEnabled && visible);
    this.chargeText.setVisible(!this.touchEnabled && visible);
    const inventoryLabel = `FLARE GUN  •  ${this.charges} / ${this.capacity}`;
    if (inventoryLabel !== this.lastInventoryLabel) {
      this.lastInventoryLabel = inventoryLabel;
      this.inventoryText.setText(inventoryLabel);
    }
    const generatorOnline = this.hooks.isGeneratorOnline();
    const generatorUnstable = this.hooks.isGeneratorUnstable();
    const generatorLabel = generatorUnstable ? 'GENERATOR UNSTABLE' : 'GENERATOR';
    const duration = this.unlocked ? this.rechargeDuration : this.firstChargeDuration;
    const seconds = Math.max(0, Math.ceil((duration - this.rechargeElapsed) / 1000));
    const productionStatus = !generatorOnline
      ? 'GENERATOR OFFLINE'
      : this.pendingCartridge
        ? this.charges >= this.capacity
          ? 'CARTRIDGE WAITING • INVENTORY FULL'
          : 'COLLECT CARTRIDGE AT GENERATOR'
        : `${generatorLabel} MAKING FLARE • ${seconds}s`;

    const detailLabel = `[F]  LAUNCH AERIAL FLARE\n${productionStatus}`;
    const detailKey = `${generatorOnline}:${detailLabel}`;
    if (detailKey !== this.lastDetailLabel) {
      this.lastDetailLabel = detailKey;
      this.chargeText
        .setText(detailLabel)
        .setColor(generatorOnline ? '#e6d7c4' : '#ef6755');
    }

    if (generatorOnline) {
      const markerStatus = this.pendingCartridge
        ? 'CARTRIDGE READY'
        : `FLARE IN ${seconds}s`;
      const markerKey = `${generatorUnstable}:${markerStatus}`;
      if (markerKey !== this.lastGeneratorLabel) {
        this.lastGeneratorLabel = markerKey;
        this.hooks.setGeneratorStatus(markerStatus);
      }
    } else {
      if (this.lastGeneratorLabel !== productionStatus) {
        this.lastGeneratorLabel = productionStatus;
        this.hooks.setGeneratorStatus(productionStatus);
      }
    }
  }
}
