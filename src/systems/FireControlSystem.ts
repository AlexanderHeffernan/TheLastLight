import type { DuoPlayerId } from '../network/protocol';

export type FireControlDropState = 'none' | 'descending' | 'ready';

export interface FireControlProfile {
  index: number;
  name: string;
  description: string;
  color: number;
  fireIntervalMultiplier: number;
  damageMultiplier: number;
  impactMultiplier: number;
  bulletSpeedMultiplier: number;
  normalPierces: number;
}

export interface FireControlSnapshot {
  profileIndex: number;
  progressByPlayer: Partial<Record<DuoPlayerId, number>>;
  requirement: number;
  dropState: FireControlDropState;
}

interface FireControlHooks {
  onProgressReset: (previousProgressByPlayer: Partial<Record<DuoPlayerId, number>>) => void;
  onDropStarted: () => void;
  onDropReady: () => void;
  onProfileInstalled: (profile: FireControlProfile) => void;
}

// The first package arrives quickly enough to teach the loop. The later
// packages keep getting harder without the opening 32 -> 220 cliff, while the
// final package remains a long-run achievement.
export const FIRE_CONTROL_REQUIREMENTS = [32, 120, 220, 360, 560];
export const FIRE_CONTROL_BOSS_KILL_VALUE = 20;

export const FIRE_CONTROL_PROFILES: FireControlProfile[] = [
  {
    index: 0,
    name: 'STANDARD ISSUE',
    description: 'BASELINE FIRE CONTROL',
    color: 0xf3cf75,
    fireIntervalMultiplier: 1,
    damageMultiplier: 1,
    impactMultiplier: 1,
    bulletSpeedMultiplier: 1,
    normalPierces: 0,
  },
  {
    index: 1,
    name: 'QUICK-CYCLE ACTION',
    description: 'REDUCED ACTION TIME',
    color: 0xffc05f,
    fireIntervalMultiplier: 0.74,
    damageMultiplier: 1,
    impactMultiplier: 1,
    bulletSpeedMultiplier: 1,
    normalPierces: 0,
  },
  {
    index: 2,
    name: 'OVERPRESSURE AMMUNITION',
    description: 'INCREASED IMPACT',
    color: 0xff934d,
    fireIntervalMultiplier: 0.74,
    damageMultiplier: 1.5,
    impactMultiplier: 1.5,
    bulletSpeedMultiplier: 1,
    normalPierces: 0,
  },
  {
    index: 3,
    name: 'HIGH-VELOCITY LOAD',
    description: 'REDUCED TRAVEL TIME',
    color: 0xff5f37,
    fireIntervalMultiplier: 0.74,
    damageMultiplier: 1.5,
    impactMultiplier: 1.5,
    bulletSpeedMultiplier: 1.22,
    normalPierces: 0,
  },
  {
    index: 4,
    name: 'ARMOUR-PIERCING TRACER',
    description: 'ONE TARGET PENETRATION',
    color: 0xff3026,
    fireIntervalMultiplier: 0.74,
    damageMultiplier: 1.5,
    impactMultiplier: 1.5,
    bulletSpeedMultiplier: 1.22,
    normalPierces: 1,
  },
  {
    index: 5,
    name: 'FULL-BORE PENETRATOR',
    description: 'PASSES THROUGH ALL NORMAL TARGETS',
    color: 0xff1d14,
    fireIntervalMultiplier: 0.74,
    damageMultiplier: 1.5,
    impactMultiplier: 1.5,
    bulletSpeedMultiplier: 1.22,
    normalPierces: Number.POSITIVE_INFINITY,
  },
];

export class FireControlSystem {
  private profileIndex = 0;
  private dropState: FireControlDropState = 'none';
  private queuedDrops = 0;
  // Kills belong to individual players, but a completed meter is a squad-wide
  // milestone: both meters reset and both weapons share the resulting mod.
  private readonly contributions = new Map<DuoPlayerId, number>();

  constructor(
    playerIds: DuoPlayerId[],
    private readonly hooks: FireControlHooks,
  ) {
    playerIds.forEach((id) => this.contributions.set(id, 0));
  }

  profile(): FireControlProfile {
    return FIRE_CONTROL_PROFILES[this.profileIndex] ?? FIRE_CONTROL_PROFILES[0];
  }

  snapshot(): FireControlSnapshot {
    const requirement = this.requirement();
    return {
      profileIndex: this.profileIndex,
      progressByPlayer: this.progressByPlayer(),
      requirement,
      dropState: this.dropState,
    };
  }

  recordKill(playerId: DuoPlayerId, amount = 1): void {
    if (this.profileIndex >= FIRE_CONTROL_PROFILES.length - 1) return;
    if (!this.contributions.has(playerId)) this.contributions.set(playerId, 0);
    this.contributions.set(playerId, (this.contributions.get(playerId) ?? 0) + Math.max(0, amount));
    if (this.hasCompletedMeter()) this.triggerDrop();
  }

  recordDamage(playerId: DuoPlayerId): void {
    if (!this.contributions.has(playerId)) this.contributions.set(playerId, 0);
    this.contributions.set(playerId, 0);
  }

  markDropReady(): void {
    if (this.dropState !== 'descending') return;
    this.dropState = 'ready';
    this.hooks.onDropReady();
  }

  canInteract(): boolean {
    return this.dropState === 'ready' && this.profileIndex < FIRE_CONTROL_PROFILES.length - 1;
  }

  installNext(): boolean {
    if (!this.canInteract()) return false;
    this.profileIndex += 1;
    this.dropState = 'none';
    this.hooks.onProfileInstalled(this.profile());
    if (this.profileIndex >= FIRE_CONTROL_PROFILES.length - 1) {
      this.queuedDrops = 0;
      return true;
    }
    if (this.queuedDrops > 0) {
      this.queuedDrops -= 1;
      this.dropState = 'descending';
      this.hooks.onDropStarted();
    } else if (this.hasCompletedMeter()) {
      this.triggerDrop();
    }
    return true;
  }

  applyNetworkSnapshot(snapshot: FireControlSnapshot | undefined): void {
    if (!snapshot) return;
    this.profileIndex = Math.max(0, Math.min(
      FIRE_CONTROL_PROFILES.length - 1,
      Math.round(snapshot.profileIndex),
    ));
    this.dropState = snapshot.dropState === 'descending' || snapshot.dropState === 'ready'
      ? snapshot.dropState
      : 'none';
    const existingIds = [...this.contributions.keys()];
    existingIds.forEach((id) => {
      const progress = Number(snapshot.progressByPlayer?.[id] ?? 0);
      this.contributions.set(id, Number.isFinite(progress) ? Math.max(0, Math.round(progress)) : 0);
    });
    this.queuedDrops = 0;
  }

  applyNetworkProfile(profileIndex: number): void {
    this.profileIndex = Math.max(0, Math.min(
      FIRE_CONTROL_PROFILES.length - 1,
      Math.round(profileIndex),
    ));
    this.dropState = 'none';
    this.queuedDrops = 0;
  }

  progress(playerId: DuoPlayerId): number {
    return this.contributions.get(playerId) ?? 0;
  }

  progressByPlayer(): Partial<Record<DuoPlayerId, number>> {
    return Object.fromEntries(this.contributions.entries()) as Partial<Record<DuoPlayerId, number>>;
  }

  requirement(): number {
    return FIRE_CONTROL_REQUIREMENTS[this.profileIndex] ?? 0;
  }

  fireInterval(baseInterval: number): number {
    return Math.round(baseInterval * this.profile().fireIntervalMultiplier);
  }

  private hasCompletedMeter(): boolean {
    const requirement = this.requirement();
    return [...this.contributions.values()].some((value) => value >= requirement);
  }

  private triggerDrop(): void {
    const previousProgressByPlayer = this.progressByPlayer();
    this.contributions.forEach((_value, id) => this.contributions.set(id, 0));
    this.hooks.onProgressReset(previousProgressByPlayer);
    if (this.dropState === 'none') {
      this.dropState = 'descending';
      this.hooks.onDropStarted();
    } else {
      this.queuedDrops += 1;
    }
  }
}
