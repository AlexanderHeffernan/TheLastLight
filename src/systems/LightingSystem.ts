import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from '../config/constants';

interface LightPosition {
  x: number;
  y: number;
}

export interface ShadowCaster extends LightPosition {
  radius: number;
}

export interface PlayerLight extends LightPosition {
  aimAngle: number;
  active?: boolean;
}

interface ExplosionLight extends LightPosition {
  scale: number;
  intensity: number;
}

interface AerialFlare extends LightPosition {
  intensity: number;
}

export class LightingSystem {
  readonly lowHealthShade: Phaser.GameObjects.Rectangle;
  readonly disabledLights = new Set<number>();
  generatorDestroyed = false;

  private darknessAmount = 0.84;
  private outpostPower = 1;
  private powerFailureStarted = false;
  private readonly darkness: Phaser.GameObjects.RenderTexture;
  private readonly radialMask: Phaser.GameObjects.Image;
  private readonly directionalMask: Phaser.GameObjects.Image;
  private readonly playerBeams: Phaser.GameObjects.Image[];
  private readonly beams: Phaser.GameObjects.Image[];
  private readonly glows: Phaser.GameObjects.Image[];
  private readonly shadows: Phaser.GameObjects.RenderTexture;
  private readonly projectedShadowMask: Phaser.GameObjects.Image;
  private readonly flareColor: Phaser.GameObjects.Image;
  private readonly flareBloom: Phaser.GameObjects.Image;
  private readonly emitters: LightPosition[];
  private readonly explosionLights: ExplosionLight[] = [];
  private aerialFlare?: AerialFlare;
  private lastShadowRedraw = -Infinity;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly positions: LightPosition[],
    onDust: () => void,
  ) {
    this.emitters = positions.map(({ x, y }) => {
      const angle = Phaser.Math.Angle.Between(x, y, GAME_WIDTH / 2, GAME_HEIGHT / 2);
      return {
        x: x + Math.cos(angle) * 20,
        y: y + Math.sin(angle) * 20,
      };
    });
    this.darkness = scene.add.renderTexture(0, 0, GAME_WIDTH, GAME_HEIGHT).setOrigin(0).setDepth(14);
    this.radialMask = scene.make.image({ x: 0, y: 0, key: 'light-mask', add: false });
    this.directionalMask = scene.make.image({ x: 0, y: 0, key: 'beam-mask', add: false })
      .setOrigin(40 / 512, 0.5);
    this.playerBeams = [0, 1].map(() => scene.add.image(0, 0, 'beam-mask')
      .setOrigin(40 / 512, 0.5)
      .setDepth(16)
      .setTint(0xffd08a)
      .setAlpha(0.045)
      .setBlendMode(Phaser.BlendModes.ADD));
    this.shadows = scene.add.renderTexture(0, 0, GAME_WIDTH, GAME_HEIGHT).setOrigin(0).setDepth(17);
    this.projectedShadowMask = scene.make.image({ x: 0, y: 0, key: 'projected-shadow', add: false })
      .setOrigin(0, 0.5)
      .setTint(0x000000);
    this.flareColor = scene.add.image(0, 0, 'flare-color-mask')
      .setDepth(15)
      .setDisplaySize(1300, 1300)
      .setAlpha(0)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.flareBloom = scene.add.image(0, 0, 'flare-color-mask')
      .setDepth(16)
      .setDisplaySize(1160, 1160)
      .setAlpha(0)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.lowHealthShade = scene.add.rectangle(
      GAME_WIDTH / 2,
      GAME_HEIGHT / 2,
      GAME_WIDTH,
      GAME_HEIGHT,
      0x6e0905,
      1,
    ).setDepth(25).setAlpha(0);

    this.beams = this.emitters.map(({ x, y }) => {
      const angle = Phaser.Math.Angle.Between(x, y, GAME_WIDTH / 2, GAME_HEIGHT / 2);
      return scene.add.image(x, y, 'beam-mask')
        .setOrigin(40 / 512, 0.5)
        .setRotation(angle)
        .setScale(0.9)
        .setDepth(16)
        .setTint(0xffc56f)
        .setAlpha(0.04)
        .setBlendMode(Phaser.BlendModes.ADD);
    });

    this.glows = this.emitters.map(({ x, y }) => scene.add.image(x, y, 'glow').setScale(1.15));
    this.glows.forEach((light, index) => {
      light.setDepth(16).setAlpha(0.2).setBlendMode(Phaser.BlendModes.ADD);
      this.pulseGlow(light, index);
    });

    scene.time.addEvent({ delay: 170, callback: onDust, loop: true });
  }

  redraw(
    playerX: number,
    playerY: number,
    aimAngle: number,
    casters: ShadowCaster[] = [],
    emberLights: LightPosition[] = [],
    playerLights: PlayerLight[] = [{ x: playerX, y: playerY, aimAngle, active: true }],
  ): void {
    this.darkness.clear();
    const flareIntensity = this.aerialFlare?.intensity ?? 0;
    const flareFlicker = Math.sin(this.scene.time.now * 0.017);
    this.darkness.fill(0x010302, this.darknessAmount);
    if (this.aerialFlare) {
      this.flareColor
        .setPosition(this.aerialFlare.x, this.aerialFlare.y)
        .setAlpha(flareIntensity * (0.24 + flareFlicker * 0.025));
      this.flareBloom
        .setPosition(this.aerialFlare.x, this.aerialFlare.y)
        .setAlpha(flareIntensity * (0.18 + flareFlicker * 0.025));
    } else {
      this.flareColor.setAlpha(0);
      this.flareBloom.setAlpha(0);
    }

    this.playerBeams.forEach((beam, index) => {
      const light = playerLights[index];
      if (!light || light.active === false) {
        beam.setVisible(false);
        return;
      }
      beam.setVisible(true).setPosition(light.x, light.y).setRotation(light.aimAngle);
    });
    playerLights.forEach((light) => {
      if (light.active !== false) this.eraseDirectionalLight(light.x, light.y, light.aimAngle, 1, 0.88);
    });

    if (!this.generatorDestroyed && this.outpostPower > 0.01) {
      this.emitters.forEach((light, index) => {
        if (this.disabledLights.has(index)) return;
        const angle = Phaser.Math.Angle.Between(light.x, light.y, GAME_WIDTH / 2, GAME_HEIGHT / 2);
        this.eraseDirectionalLight(light.x, light.y, angle, 0.9, 0.92 * this.outpostPower);
      });
    }

    this.radialMask.setPosition(playerX, playerY).setScale(0.4).setAlpha(0.52);
    this.darkness.erase(this.radialMask);

    if (!this.generatorDestroyed && this.outpostPower > 0.01) {
      this.emitters.forEach((light, index) => {
        if (this.disabledLights.has(index)) return;
        this.radialMask
          .setPosition(light.x, light.y)
          .setScale(0.34)
          .setAlpha(0.38 * this.outpostPower);
        this.darkness.erase(this.radialMask);
      });
    }

    this.explosionLights.forEach((light) => {
      this.radialMask.setPosition(light.x, light.y).setScale(light.scale).setAlpha(light.intensity);
      this.darkness.erase(this.radialMask);
    });
    emberLights.forEach((light, index) => {
      const flicker = 0.17 + Math.sin(this.scene.time.now * 0.013 + index * 2.1) * 0.035;
      this.radialMask.setPosition(light.x, light.y).setScale(0.24).setAlpha(flicker);
      this.darkness.erase(this.radialMask);
    });
    if (this.aerialFlare) {
      this.radialMask
        .setPosition(this.aerialFlare.x, this.aerialFlare.y)
        .setScale(5.1)
        .setAlpha(this.aerialFlare.intensity * 0.98);
      this.darkness.erase(this.radialMask);
    }

    if (this.scene.time.now - this.lastShadowRedraw >= 33) {
      this.lastShadowRedraw = this.scene.time.now;
      this.shadows.clear();
      this.shadows.beginDraw();
      playerLights.forEach((light) => {
        if (light.active !== false) {
          this.drawProjectedShadows(light.x, light.y, light.aimAngle, 470, 0.44, 0.82, casters);
        }
      });
      if (!this.generatorDestroyed && this.outpostPower > 0.01) {
        this.emitters.forEach((light, index) => {
          if (this.disabledLights.has(index)) return;
          const angle = Phaser.Math.Angle.Between(light.x, light.y, GAME_WIDTH / 2, GAME_HEIGHT / 2);
          this.drawProjectedShadows(
            light.x,
            light.y,
            angle,
            430,
            0.44,
            this.outpostPower * 0.7,
            casters,
          );
        });
      }
      this.explosionLights.forEach((light) => {
        this.drawProjectedShadows(
          light.x,
          light.y,
          0,
          Math.max(80, light.scale * 128),
          Math.PI,
          light.intensity * 0.8,
          casters,
        );
      });
      if (this.aerialFlare && this.aerialFlare.intensity > 0.05) {
        this.drawProjectedShadows(
          this.aerialFlare.x,
          this.aerialFlare.y,
          0,
          1150,
          Math.PI,
          this.aerialFlare.intensity * 0.75,
          casters,
        );
      }
      this.shadows.endDraw();
    }
  }

  addExplosionLight(x: number, y: number, radius: number): void {
    const light: ExplosionLight = { x, y, scale: 0.25, intensity: 1 };
    this.explosionLights.push(light);
    this.scene.tweens.add({
      targets: light,
      scale: Math.max(1.2, radius / 70),
      intensity: 0,
      duration: 480,
      ease: 'Quad.out',
      onComplete: () => this.explosionLights.splice(this.explosionLights.indexOf(light), 1),
    });
  }

  igniteAerialFlare(x: number, y: number, duration: number): void {
    const flare: AerialFlare = { x, y, intensity: 0 };
    this.aerialFlare = flare;
    this.scene.tweens.add({
      targets: flare,
      intensity: 0.92,
      duration: 650,
      hold: duration - 1300,
      yoyo: true,
      ease: 'Sine.out',
      onComplete: () => {
        if (this.aerialFlare === flare) this.aerialFlare = undefined;
        this.flareColor.setAlpha(0);
        this.flareBloom.setAlpha(0);
      },
    });
    this.scene.tweens.add({
      targets: flare,
      x: x + 28,
      y: y - 18,
      duration,
      ease: 'Sine.inOut',
    });
  }

  networkFlareState(): { x: number; y: number; intensity: number } | undefined {
    return this.aerialFlare ? { ...this.aerialFlare } : undefined;
  }

  syncAerialFlare(flare?: { x: number; y: number; intensity: number }): void {
    if (!flare) {
      this.aerialFlare = undefined;
      this.flareColor.setAlpha(0);
      this.flareBloom.setAlpha(0);
      return;
    }
    this.aerialFlare = {
      x: flare.x,
      y: flare.y,
      intensity: Phaser.Math.Clamp(flare.intensity, 0, 1),
    };
  }

  startPowerFailure(wave: number): boolean {
    const activeLightCount = this.positions.length - this.disabledLights.size;
    if (this.generatorDestroyed || this.powerFailureStarted || activeLightCount === 0) return false;
    this.powerFailureStarted = true;
    this.scene.tweens.add({
      targets: this,
      darknessAmount: Math.min(0.92, 0.82 + wave * 0.018),
      outpostPower: 0.16,
      duration: 1400,
    });
    this.scene.tweens.add({
      targets: this.beams.filter((_, index) => !this.disabledLights.has(index)),
      alpha: 0.012,
      duration: 900,
    });
    this.glows.forEach((light, index) => {
      if (this.disabledLights.has(index)) return;
      this.scene.time.delayedCall(index * 260, () => {
        if (this.generatorDestroyed || this.disabledLights.has(index)) return;
        this.scene.tweens.killTweensOf(light);
        this.scene.tweens.add({
          targets: light,
          alpha: 0,
          duration: 55,
          yoyo: true,
          repeat: 5,
          onComplete: () => {
            if (!this.generatorDestroyed && !this.disabledLights.has(index)) {
              light.setAlpha(index === 0 && wave === 4 ? 0.12 : 0.035);
            }
          },
        });
      });
    });
    return true;
  }

  destroyGenerator(): void {
    this.generatorDestroyed = true;
    this.scene.tweens.killTweensOf(this);
    this.glows.forEach((light) => this.scene.tweens.killTweensOf(light));
    this.scene.tweens.add({ targets: this, darknessAmount: 0.94, outpostPower: 0, duration: 500 });
    this.scene.tweens.add({ targets: [...this.glows, ...this.beams], alpha: 0, duration: 280 });
  }

  needsRepair(): boolean {
    return this.generatorDestroyed || this.powerFailureStarted || this.disabledLights.size > 0;
  }

  isGeneratorUnstable(): boolean {
    return this.powerFailureStarted;
  }

  restoreOutpost(): void {
    this.generatorDestroyed = false;
    this.powerFailureStarted = false;
    this.disabledLights.clear();
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.add({
      targets: this,
      darknessAmount: 0.84,
      outpostPower: 1,
      duration: 950,
      ease: 'Quad.out',
    });
    this.beams.forEach((beam) => {
      this.scene.tweens.killTweensOf(beam);
      beam.setVisible(true);
      this.scene.tweens.add({ targets: beam, alpha: 0.04, duration: 700 });
    });
    this.glows.forEach((light, index) => {
      this.scene.tweens.killTweensOf(light);
      light.setVisible(true);
      this.pulseGlow(light, index);
    });
  }

  disableLight(index: number): void {
    if (this.disabledLights.has(index)) return;
    this.disabledLights.add(index);
    this.scene.tweens.killTweensOf(this.glows[index]);
    this.scene.tweens.add({ targets: [this.glows[index], this.beams[index]], alpha: 0, duration: 120 });
  }

  enableLight(index: number): void {
    if (!this.disabledLights.delete(index)) return;
    const glow = this.glows[index];
    const beam = this.beams[index];
    this.scene.tweens.killTweensOf([glow, beam]);
    beam.setVisible(true);
    this.scene.tweens.add({ targets: beam, alpha: 0.04, duration: 180 });
    glow.setVisible(true);
    this.pulseGlow(glow, index);
  }

  private pulseGlow(light: Phaser.GameObjects.Image, index: number): void {
    this.scene.tweens.add({
      targets: light,
      alpha: { from: 0.16, to: 0.23 },
      duration: 950 + index * 170,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.inOut',
    });
  }

  private eraseDirectionalLight(
    x: number,
    y: number,
    angle: number,
    scale: number,
    alpha: number,
  ): void {
    this.directionalMask.setPosition(x, y).setRotation(angle).setScale(scale).setAlpha(alpha);
    this.darkness.erase(this.directionalMask);
  }

  private drawProjectedShadows(
    lightX: number,
    lightY: number,
    lightAngle: number,
    range: number,
    spread: number,
    strength: number,
    casters: ShadowCaster[],
  ): void {
    casters.forEach((caster) => {
      const distance = Phaser.Math.Distance.Between(lightX, lightY, caster.x, caster.y);
      if (distance <= caster.radius + 8 || distance >= range) return;

      const angle = Phaser.Math.Angle.Between(lightX, lightY, caster.x, caster.y);
      const angleFromBeam = Math.abs(Phaser.Math.Angle.Wrap(angle - lightAngle));
      const angularRadius = Math.atan2(caster.radius, distance);
      if (angleFromBeam > spread + angularRadius) return;

      const directionX = Math.cos(angle);
      const directionY = Math.sin(angle);
      const length = Phaser.Math.Clamp(72 + caster.radius * 2.2 + (range - distance) * 0.2, 72, 190);
      const distanceFade = 1 - distance / range;
      const edgeFade = spread >= Math.PI
        ? 1
        : 1 - Phaser.Math.Clamp((angleFromBeam - spread * 0.65) / (spread * 0.35), 0, 1);
      const alpha = strength * (0.1 + distanceFade * 0.1) * edgeFade;

      this.projectedShadowMask
        .setPosition(
          caster.x + directionX * caster.radius * 0.45,
          caster.y + directionY * caster.radius * 0.45,
        )
        .setRotation(angle)
        .setDisplaySize(length * 1.12, caster.radius * 4.2)
        .setAlpha(alpha * 3.1);
      this.shadows.batchDraw(this.projectedShadowMask);
    });
  }
}
