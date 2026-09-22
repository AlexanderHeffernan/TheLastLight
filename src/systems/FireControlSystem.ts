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
  progress: number;
  requirement: number;
  dropState: FireControlDropState;
}

interface FireControlHooks {
  onDropStarted: () => void;
  onDropReady: () => void;
  onProfileInstalled: (profile: FireControlProfile) => void;
}

// The first package arrives quickly enough to teach the loop. Later packages
// are spaced around the introduction of heavier threats instead of arriving
// during the opening waves.
export const FIRE_CONTROL_REQUIREMENTS = [32, 220, 340, 480, 900];

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
  private readonly contributions = new Map<DuoPlayerId, number>();
  private readonly pendingContributions = new Map<DuoPlayerId, number>();

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
      progress: this.progress(),
      requirement,
      dropState: this.dropState,
    };
  }

  recordKill(playerId: DuoPlayerId): void {
    if (this.profileIndex >= FIRE_CONTROL_PROFILES.length - 1) return;
    const target = this.dropState === 'descending'
      ? this.pendingContributions
      : this.contributions;
    if (!target.has(playerId)) target.set(playerId, 0);
    target.set(playerId, (target.get(playerId) ?? 0) + 1);
    if (this.dropState === 'none' && this.progress() >= this.requirement()) {
      this.beginDrop();
    }
  }

  recordDamage(playerId: DuoPlayerId): void {
    if (!this.contributions.has(playerId)) this.contributions.set(playerId, 0);
    this.contributions.set(playerId, 0);
    this.pendingContributions.set(playerId, 0);
  }

  markDropReady(): void {
    if (this.dropState !== 'descending') return;
    this.contributions.clear();
    this.pendingContributions.forEach((value, id) => this.contributions.set(id, value));
    this.pendingContributions.clear();
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
    if (this.progress() >= this.requirement()) {
      this.beginDrop();
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
    const progress = Math.max(0, Math.round(snapshot.progress));
    const existingIds = [...this.contributions.keys()];
    if (existingIds.length === 0) this.contributions.set('host', progress);
    else {
      existingIds.forEach((id, index) => this.contributions.set(id, index === 0 ? progress : 0));
    }
    this.pendingContributions.clear();
  }

  applyNetworkProfile(profileIndex: number): void {
    this.applyNetworkSnapshot({
      profileIndex,
      progress: 0,
      requirement: this.requirement(),
      dropState: 'none',
    });
  }

  progress(): number {
    return [...this.contributions.values()].reduce((total, value) => total + value, 0);
  }

  requirement(): number {
    return FIRE_CONTROL_REQUIREMENTS[this.profileIndex] ?? 0;
  }

  fireInterval(baseInterval: number): number {
    return Math.round(baseInterval * this.profile().fireIntervalMultiplier);
  }

  private beginDrop(): void {
    const requirement = this.requirement();
    let overflow = Math.max(0, this.progress() - requirement);
    this.pendingContributions.clear();
    if (overflow > 0) {
      this.contributions.forEach((value, id) => {
        if (overflow <= 0) return;
        const carried = Math.min(value, overflow);
        if (carried <= 0) return;
        this.contributions.set(id, value - carried);
        this.pendingContributions.set(id, carried);
        overflow -= carried;
      });
    }
    this.dropState = 'descending';
    this.hooks.onDropStarted();
  }
}
