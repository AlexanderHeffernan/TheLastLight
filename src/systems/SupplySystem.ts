import Phaser from 'phaser';

interface SupplyHooks {
  getHealth: () => number;
  heal: (amount: number) => void;
  needsRepair: () => boolean;
  getBaseIntegrity: () => number;
  repairOutpost: () => void;
  announce: (title: string, subtitle: string) => void;
  isGameOver: () => boolean;
  emitNetworkEvent?: (
    type: 'supply-drop' | 'supply-ready' | 'supply-opened',
    payload: Record<string, unknown>,
  ) => void;
}

type DropState = 'waiting' | 'descending' | 'ready' | 'opened';
type PickupKind = 'medkit' | 'adrenaline' | 'repair';

export class SupplySystem {
  private readonly pickups: Phaser.Physics.Arcade.Group;
  private readonly interactKey: Phaser.Input.Keyboard.Key;
  private readonly landingZone: Phaser.GameObjects.Graphics;
  private readonly landingLabel: Phaser.GameObjects.Text;
  private readonly prompt: Phaser.GameObjects.Text;
  private state: DropState = 'waiting';
  private readonly adrenalineUntil = new Map<Phaser.Physics.Arcade.Sprite, number>();
  private readonly players: Phaser.Physics.Arcade.Sprite[];
  private cache?: Phaser.GameObjects.Image;
  private cacheShadow?: Phaser.GameObjects.Ellipse;
  private cacheBeaconGlow?: Phaser.GameObjects.Image;
  private cacheBeaconLight?: Phaser.GameObjects.Arc;
  private cacheCollider?: Phaser.Physics.Arcade.Collider;
  private activePickup?: any;
  private readonly dropX = 585;
  private readonly dropY = 270;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly player: Phaser.Physics.Arcade.Sprite,
    private readonly hooks: SupplyHooks,
  ) {
    this.players = [player];
    this.interactKey = scene.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.pickups = scene.physics.add.group();
    scene.physics.add.overlap(player, this.pickups, (collector, pickup) => {
      this.collect(pickup as any, collector as Phaser.Physics.Arcade.Sprite);
    });

    this.landingZone = scene.add.graphics({ x: this.dropX, y: this.dropY })
      .setDepth(2)
      .setAlpha(0.72)
      .setVisible(false);
    this.landingZone.lineStyle(2, 0xd9e7a0, 0.95).strokeCircle(0, 0, 30);
    this.landingZone.lineStyle(1, 0x82b96f, 0.72).strokeCircle(0, 0, 36);
    this.landingZone.lineBetween(-39, 0, -28, 0).lineBetween(28, 0, 39, 0);
    this.landingZone.lineBetween(0, -39, 0, -28).lineBetween(0, 28, 0, 39);
    this.landingLabel = scene.add.text(this.dropX, this.dropY + 40, 'SUPPLY READY', {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '11px',
      color: '#e4efbd',
      backgroundColor: '#081008e8',
      padding: { x: 6, y: 3 },
    }).setOrigin(0.5).setDepth(18).setAlpha(0.92).setVisible(false);
    this.prompt = scene.add.text(this.dropX, this.dropY - 48, 'E  OPEN SUPPLY DROP', {
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '13px',
      color: '#f1f4d2',
      backgroundColor: '#071007ee',
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5).setDepth(40).setVisible(false);

    scene.tweens.add({
      targets: [this.landingZone, this.landingLabel],
      alpha: { from: 0.64, to: 1 },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.inOut',
    });
    scene.time.delayedCall(66000, () => this.beginDrop());
  }

  addPlayer(player: Phaser.Physics.Arcade.Sprite): void {
    this.players.push(player);
    this.scene.physics.add.overlap(
      player,
      this.pickups,
      (collector, pickup) => this.collect(pickup as any, collector as Phaser.Physics.Arcade.Sprite),
    );
  }

  interact(player = this.player): void {
    const canOpen = this.canInteract(player);
    if (canOpen) this.openDrop();
  }

  canInteract(player = this.player): boolean {
    return !this.hooks.isGameOver()
      && this.state === 'ready'
      && !!this.cache
      && Phaser.Math.Distance.Between(player.x, player.y, this.cache.x, this.cache.y) <= 58;
  }

  networkState(): {
    state: DropState;
    cache?: { x: number; y: number; textureKey: string };
    pickup?: { kind: string; x: number; y: number };
  } {
    return {
      state: this.state,
      cache: this.cache
        ? { x: this.cache.x, y: this.cache.y, textureKey: this.cache.texture.key }
        : undefined,
      pickup: this.activePickup?.active
        ? {
          kind: String(this.activePickup.getData('kind') ?? 'medkit'),
          x: this.activePickup.x,
          y: this.activePickup.y,
        }
        : undefined,
    };
  }

  update(time: number): void {
    if (this.hooks.isGameOver()) {
      this.prompt.setVisible(false);
      return;
    }

    const canOpen = this.canInteract();
    this.prompt.setVisible(canOpen);
    if (canOpen && Phaser.Input.Keyboard.JustDown(this.interactKey)) this.interact();

    this.players.forEach((player) => {
      if (time < (this.adrenalineUntil.get(player) ?? 0)) player.setTint(0xffd18a);
      else if (player.tintTopLeft === 0xffd18a) player.clearTint();
    });
  }

  movementMultiplier(time: number, player = this.player): number {
    return time < (this.adrenalineUntil.get(player) ?? 0) ? 1.22 : 1;
  }

  fireInterval(time: number, player = this.player): number {
    return time < (this.adrenalineUntil.get(player) ?? 0) ? 78 : 105;
  }

  adrenalineRemaining(time: number, player = this.player): number {
    return Math.max(0, (this.adrenalineUntil.get(player) ?? 0) - time);
  }

  private beginDrop(): void {
    if (this.hooks.isGameOver()) return;
    this.state = 'descending';
    this.hooks.emitNetworkEvent?.('supply-drop', {
      x: this.dropX,
      y: this.dropY,
      duration: 1050,
    });
    this.hooks.announce('SUPPLY DROP INBOUND', 'LOCATE THE DROP • PRESS E TO OPEN');

    const incomingShadow = this.scene.add.ellipse(this.dropX, this.dropY + 7, 38, 18, 0x000000, 0.36)
      .setDepth(1)
      .setScale(0.25);
    const incomingCache = this.scene.add.image(this.dropX - 54, this.dropY - 85, 'supply-cache-closed')
      .setDepth(2)
      .setScale(1.45)
      .setAlpha(0);

    this.scene.tweens.add({
      targets: incomingCache,
      x: this.dropX,
      y: this.dropY,
      scale: 1,
      alpha: 1,
      duration: 1050,
      ease: 'Quad.in',
      onComplete: () => {
        if (this.hooks.isGameOver()) {
          incomingCache.destroy();
          incomingShadow.destroy();
          return;
        }
        this.clearDrop();
        this.cache = incomingCache;
        this.cacheShadow = incomingShadow;
        this.state = 'ready';
        this.hooks.emitNetworkEvent?.('supply-ready', {
          x: this.dropX,
          y: this.dropY,
          textureKey: this.cache.texture.key,
        });
        this.landingLabel.setText('SUPPLY READY');
        this.landingZone.setVisible(true);
        this.landingLabel.setVisible(true);
        this.scene.physics.add.existing(this.cache!, true);
        const body = (this.cache as any).body as Phaser.Physics.Arcade.StaticBody;
        body.setSize(38, 24).setOffset(13, 20);
        this.cacheCollider = this.scene.physics.add.collider(this.player, this.cache!);
        this.showCacheBeacon();
        this.scene.cameras.main.shake(90, 0.0025);
      },
    });
    this.scene.tweens.add({ targets: incomingShadow, scale: 1, duration: 1050, ease: 'Quad.in' });
  }

  private openDrop(): void {
    if (this.state !== 'ready' || !this.cache) return;
    this.state = 'opened';
    this.prompt.setVisible(false);
    this.hideCacheBeacon();
    this.cacheCollider?.destroy();
    this.cacheCollider = undefined;
    ((this.cache as any).body as Phaser.Physics.Arcade.StaticBody).enable = false;
    this.cache.setTexture('supply-cache-open');
    this.scene.tweens.add({ targets: this.cache, scaleY: 1.08, duration: 80, yoyo: true });
    const kind = this.choosePickupKind();
    this.hooks.emitNetworkEvent?.('supply-opened', {
      kind,
      x: this.cache.x,
      y: this.cache.y - 8,
    });
    this.landingLabel.setText(kind === 'medkit'
      ? 'MEDKIT READY'
      : kind === 'repair'
        ? 'REPAIR KIT READY'
        : 'ADRENALINE READY');
    this.spawnPickup(kind, this.cache.x, this.cache.y - 8);
    this.scene.time.delayedCall(28000, () => this.beginDrop());
  }

  private choosePickupKind(): PickupKind {
    const health = this.hooks.getHealth();
    const healthUrgency = Phaser.Math.Clamp((40 - health) / 40, 0, 1);
    const baseUrgency = Phaser.Math.Clamp((0.4 - this.hooks.getBaseIntegrity()) / 0.4, 0, 1);
    const emergency = healthUrgency > 0 || baseUrgency > 0;
    const choices: { kind: PickupKind; weight: number }[] = [];

    if (health < 100) choices.push({ kind: 'medkit', weight: 20 + healthUrgency * 100 });
    if (this.hooks.needsRepair()) choices.push({ kind: 'repair', weight: 20 + baseUrgency * 100 });
    choices.push({ kind: 'adrenaline', weight: 25 + (emergency ? 0 : 35) });

    let roll = Phaser.Math.FloatBetween(0, choices.reduce((total, choice) => total + choice.weight, 0));
    for (const choice of choices) {
      roll -= choice.weight;
      if (roll <= 0) return choice.kind;
    }
    return 'adrenaline';
  }

  private showCacheBeacon(): void {
    const x = this.dropX + 18;
    const y = this.dropY - 7;
    this.cacheBeaconGlow = this.scene.add.image(x, y, 'glow')
      .setDepth(16)
      .setScale(0.28)
      .setAlpha(0.16)
      .setTint(0x77ff76)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.cacheBeaconLight = this.scene.add.circle(x, y, 2, 0xb6ff96, 0.95).setDepth(17);
    this.scene.tweens.add({
      targets: this.cacheBeaconGlow,
      alpha: { from: 0.1, to: 0.42 },
      duration: 240,
      hold: 180,
      yoyo: true,
      repeat: -1,
      repeatDelay: 520,
    });
    this.scene.tweens.add({
      targets: this.cacheBeaconLight,
      alpha: { from: 0.4, to: 1 },
      duration: 180,
      hold: 180,
      yoyo: true,
      repeat: -1,
      repeatDelay: 640,
    });
  }

  private hideCacheBeacon(): void {
    [this.cacheBeaconGlow, this.cacheBeaconLight].forEach((beacon) => {
      if (!beacon) return;
      this.scene.tweens.killTweensOf(beacon);
      beacon.destroy();
    });
    this.cacheBeaconGlow = undefined;
    this.cacheBeaconLight = undefined;
  }

  private spawnPickup(kind: PickupKind, x: number, y: number): void {
    const restorative = kind === 'medkit' || kind === 'repair';
    const shadow = this.scene.add.ellipse(x + 1, y + 6, 20, 9, 0x000000, 0.28).setDepth(2);
    const glow = this.scene.add.image(x, y, 'glow')
      .setDepth(16)
      .setScale(0.82)
      .setAlpha(0.78)
      .setTint(restorative ? 0x84e996 : 0xffb14c)
      .setBlendMode(Phaser.BlendModes.ADD);
    const coreGlow = this.scene.add.image(x, y, 'glow')
      .setDepth(16)
      .setScale(0.3)
      .setAlpha(1)
      .setTint(restorative ? 0xb6ffae : 0xffd06a)
      .setBlendMode(Phaser.BlendModes.ADD);
    const texture = kind === 'repair' ? 'repair-kit' : kind;
    const pickup = this.pickups.create(x, y, texture)
      .setDepth(3)
      .setData({ kind, shadow, glow, coreGlow });
    this.activePickup = pickup;
    const body = pickup.body as Phaser.Physics.Arcade.Body;
    body.setCircle(11, 21, 21);
    body.setAllowGravity(false);
    this.scene.tweens.add({
      targets: pickup,
      y: y - 4,
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
  }

  private collect(pickup: any, player: Phaser.Physics.Arcade.Sprite): void {
    if (!pickup.active || this.hooks.isGameOver()) return;
    const kind = pickup.getData('kind');
    if (kind === 'medkit' && this.hooks.getHealth() >= 100) return;

    this.destroyPickup(pickup);

    if (kind === 'medkit') {
      this.hooks.heal(100);
      this.hooks.announce('VITALS RESTORED', 'FIELD MEDKIT APPLIED');
    } else if (kind === 'repair') {
      this.hooks.repairOutpost();
      this.hooks.announce('OUTPOST RESTORED', 'GENERATOR, LIGHTS, AND BARRICADES OPERATIONAL');
    } else {
      this.players.forEach((target) => this.adrenalineUntil.set(target, this.scene.time.now + 10000));
      this.hooks.announce('ADRENALINE ACTIVE', 'MOVEMENT AND FIRE RATE INCREASED');
    }
    this.clearDrop();
  }

  private destroyPickup(pickup: any): void {
    if (!pickup?.active) return;
    pickup.getData('shadow')?.destroy();
    const glow = pickup.getData('glow');
    const coreGlow = pickup.getData('coreGlow');
    this.scene.tweens.killTweensOf(glow);
    this.scene.tweens.killTweensOf(coreGlow);
    this.scene.tweens.killTweensOf(pickup);
    glow?.destroy();
    coreGlow?.destroy();
    pickup.destroy();
    if (this.activePickup === pickup) this.activePickup = undefined;
  }

  private clearDrop(): void {
    this.landingZone.setVisible(false);
    this.landingLabel.setVisible(false);
    this.prompt.setVisible(false);
    this.hideCacheBeacon();
    this.destroyPickup(this.activePickup);
    const targets = [this.cache, this.cacheShadow].filter(Boolean);
    this.scene.tweens.add({
      targets,
      alpha: 0,
      duration: 650,
      onComplete: () => targets.forEach((target) => target?.destroy()),
    });
    this.cache = undefined;
    this.cacheShadow = undefined;
    this.state = 'waiting';
  }
}
