import Phaser from 'phaser';

export type BossKind = 'breaker' | 'lurker' | 'furnace' | 'spitter';

const ALL_BOSS_KINDS: BossKind[] = ['breaker', 'lurker', 'furnace', 'spitter'];

interface WaveDirectorHooks {
  spawnZombie: (edge?: number) => void;
  spawnBoss: (kind: BossKind, edge: number) => void;
  telegraphHorde: (edge: number) => void;
  announce: (title: string, subtitle: string) => void;
  startPowerFailure: (wave: number) => boolean;
  isGameOver: () => boolean;
}

export class WaveDirector {
  wave = 1;

  private openingEvent?: Phaser.Time.TimerEvent;
  private spawnEvent?: Phaser.Time.TimerEvent;
  private advanceEvent?: Phaser.Time.TimerEvent;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly hooks: WaveDirectorHooks,
  ) {}

  start(): void {
    this.openingEvent = this.scene.time.delayedCall(6500, () => {
      if (this.hooks.isGameOver()) return;
      const openingEdge = Phaser.Math.Between(0, 3);
      this.hooks.telegraphHorde(openingEdge);
      this.scene.time.delayedCall(1900, () => {
        if (this.hooks.isGameOver()) return;
        this.hooks.spawnZombie(openingEdge);
        this.spawnEvent = this.scene.time.addEvent({
          delay: 1850,
          callback: () => this.hooks.spawnZombie(),
          loop: true,
        });
        this.updateSpawnRate();
      });
    });
    this.scheduleAdvance();
  }

  stop(): void {
    this.openingEvent?.remove();
    this.spawnEvent?.remove();
    this.advanceEvent?.remove();
    this.advanceEvent = undefined;
  }

  private scheduleAdvance(): void {
    this.advanceEvent = this.scene.time.delayedCall(this.phaseDuration(this.wave), () => {
      this.advanceEvent = undefined;
      if (this.hooks.isGameOver()) return;
      this.advance();
      if (!this.hooks.isGameOver()) this.scheduleAdvance();
    });
  }

  private advance(): void {
    if (this.hooks.isGameOver()) return;
    this.wave += 1;
    const messages: Record<number, [string, string]> = {
      2: ['FIRST CONTACT', 'THE HORDE IS PRESSING THE PERIMETER'],
      3: ['PRESSURE RISING', 'THE HORDE IS NOT SLOWING'],
      4: ['FAST MOVERS', 'RUNNERS HAVE ENTERED THE KILL ZONE'],
      5: ['APEX CONTACT', 'THE BREAKER IS ENTERING THE KILL ZONE'],
      6: ['NO SAFE GROUND', 'ALL APPROACHES ARE COMPROMISED'],
      7: ['LOW PROFILE CONTACT', 'CRAWLERS ARE MOVING THROUGH THE KILL ZONE'],
      10: ['APEX CONTACT', 'THE LURKER IS INSIDE THE PERIMETER'],
      13: ['BURNING DEAD', 'CHARRED INFECTED HAVE ENTERED THE KILL ZONE'],
      15: ['APEX CONTACT', 'THE FURNACE IS ENTERING THE KILL ZONE'],
      20: ['APEX CONTACT', 'THE SPITTER IS ENTERING THE KILL ZONE'],
      25: ['MULTIPLE APEX CONTACTS', 'THE BREAKER AND FURNACE ARE ENTERING THE KILL ZONE'],
      30: ['MULTIPLE APEX CONTACTS', 'THE LURKER AND SPITTER ARE CLOSING IN'],
      35: ['TRIPLE APEX CONTACTS', 'THE BREAKER, LURKER, AND FURNACE ARE CONVERGING'],
      40: ['TRIPLE APEX CONTACTS', 'THE BREAKER, FURNACE, AND SPITTER ARE CONVERGING'],
      45: ['FOUR HORSEMEN', 'ALL APEX CONTACTS ARE CONVERGING'],
    };
    let message = messages[this.wave];
    if (this.wave === 4) {
      message = this.hooks.startPowerFailure(this.wave)
        ? ['POWER FAILURE', 'OUTPOST LIGHTS ARE COLLAPSING']
        : ['FAST MOVERS', 'RUNNERS HAVE ENTERED THE KILL ZONE'];
    }
    const bossKinds = this.bossKindsForWave(this.wave);
    if (!message && bossKinds.length === ALL_BOSS_KINDS.length) {
      message = ['FOUR HORSEMEN', 'ALL APEX CONTACTS ARE CONVERGING'];
    }
    const escalationMessages: [string, string][] = [
      ['MASS CONTACT', 'THE HORDE IS NOT SLOWING'],
      ['PRESSURE RISING', 'MORE CONTACTS ARE CONVERGING'],
      ['SURGE DETECTED', 'ANOTHER HORDE IS CLOSING IN'],
    ];
    const fallback = escalationMessages[(this.wave - 7) % escalationMessages.length];
    const [title, subtitle] = message ?? fallback;
    this.hooks.announce(title, subtitle);
    this.updateSpawnRate();

    const edgeCount = Math.min(4, this.wave >= 5 ? 1 + Math.floor(this.wave / 5) : 1);
    const hordeEdges = Phaser.Utils.Array.Shuffle([0, 1, 2, 3]).slice(0, edgeCount);
    hordeEdges.forEach((edge) => this.hooks.telegraphHorde(edge));
    const hordeSize = this.hordeSize();
    const spawnSpacing = Math.max(145, 260 - this.wave * 5);
    for (let i = 0; i < hordeSize; i += 1) {
      const edge = hordeEdges[i % hordeEdges.length];
      this.scene.time.delayedCall(2100 + i * spawnSpacing, () => this.hooks.spawnZombie(edge));
    }

    this.spawnMilestoneBosses(hordeEdges);
  }

  private updateSpawnRate(): void {
    if (this.spawnEvent) {
      const targetInterval = this.regularSpawnInterval(this.wave);
      this.spawnEvent.timeScale = 1850 / targetInterval;
    }
  }

  private regularSpawnInterval(wave: number): number {
    if (wave <= 12) return Math.max(620, 1850 - (wave - 1) * 120);
    if (wave <= 20) return Phaser.Math.Linear(620, 600, (wave - 12) / 8);
    if (wave <= 30) return Phaser.Math.Linear(600, 550, (wave - 20) / 10);
    if (wave <= 40) return Phaser.Math.Linear(550, 500, (wave - 30) / 10);
    if (wave <= 45) return Phaser.Math.Linear(500, 440, (wave - 40) / 5);
    return 440;
  }

  private phaseDuration(wave: number): number {
    if (wave <= 10) return 26000;
    if (wave <= 20) return 28000;
    if (wave <= 30) return 30000;
    if (wave <= 40) return 32000;
    return 34000;
  }

  private hordeSize(): number {
    const baseSize = this.baseHordeSize(this.wave);
    const bossCount = this.bossKindsForWave(this.wave).length;
    const bossMultiplier = bossCount === 0
      ? 1
      : bossCount === 1
        ? 0.9
        : bossCount === 2
          ? 0.8
          : bossCount === 3
            ? 0.65
            : 0.55;
    return Math.max(1, Math.round(baseSize * bossMultiplier));
  }

  private baseHordeSize(wave: number): number {
    if (wave < 5) return 2 + wave;
    if (wave < 25) return wave * 2 - 2;
    return Math.min(160, 50 + (wave - 25) * 4);
  }

  private bossKindsForWave(wave: number): BossKind[] {
    const milestoneBosses: Partial<Record<number, BossKind[]>> = {
      5: ['breaker'],
      10: ['lurker'],
      15: ['furnace'],
      20: ['spitter'],
      25: ['breaker', 'furnace'],
      30: ['lurker', 'spitter'],
      35: ['breaker', 'lurker', 'furnace'],
      40: ['breaker', 'furnace', 'spitter'],
      45: ALL_BOSS_KINDS,
    };
    if (milestoneBosses[wave]) return milestoneBosses[wave]!;
    if (wave > 45 && wave % 5 === 0) return ALL_BOSS_KINDS;
    return [];
  }

  private spawnMilestoneBosses(edges: number[]): void {
    const kinds = this.bossKindsForWave(this.wave);
    if (kinds.length === 0) return;
    const stagger = kinds.length === 1 ? 0 : kinds.length === 2 ? 4200 : 3600;
    kinds.forEach((kind, index) => {
      const spawn = () => this.hooks.spawnBoss(kind, edges[index % edges.length]);
      if (index === 0) spawn();
      else this.scene.time.delayedCall(index * stagger, spawn);
    });
  }
}
