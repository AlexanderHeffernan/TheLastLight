import Phaser from 'phaser';
import { BOSS_MUSIC_KEYS, DEFEAT_MUSIC_KEYS, MUSIC_KEYS, MUSIC_URLS } from '../assets/manifest';
import type { DuoOscillatorType, DuoPlayerId, DuoSoundEffect } from '../network/protocol';

const MUSIC_VOLUME = 0.16;

type BossMusicKind = keyof typeof BOSS_MUSIC_KEYS;
type MusicTrack = HTMLAudioElement;

interface AudioPosition {
  x: number;
  y: number;
}

interface SoundMetadata {
  ownerId?: DuoPlayerId;
  shotSequence?: number;
}

interface BossEncounter {
  kind: BossMusicKind;
  sequence: number;
}

export interface MusicCue {
  key: string;
  loop: boolean;
}

const BOSS_MUSIC_PRIORITY: Record<BossMusicKind, number> = {
  breaker: 1,
  lurker: 2,
  furnace: 3,
  spitter: 4,
};

export class AudioSystem {
  private music?: MusicTrack;
  private musicKey?: string;
  private lastMusicKey?: string;
  private bossSequence = 0;
  private readonly bossEncounters = new Map<number, BossEncounter>();
  private readonly musicTracks = new Set<MusicTrack>();
  private readonly pendingMusicPlays = new Map<MusicTrack, number>();
  private musicUnlockHandler?: () => void;
  private musicPaused = false;
  private fadingOut = false;
  private destroyed = false;
  private readonly onCue?: (cue: MusicCue) => void;
  private readonly onSound?: (sound: DuoSoundEffect) => void;
  private readonly networkControlled: boolean;

  constructor(
    private readonly scene: Phaser.Scene,
    options: {
      onCue?: (cue: MusicCue) => void;
      onSound?: (sound: DuoSoundEffect) => void;
      networkControlled?: boolean;
    } = {},
  ) {
    this.onCue = options.onCue;
    this.onSound = options.onSound;
    this.networkControlled = options.networkControlled === true;
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  startMusic(): void {
    if (this.destroyed || this.networkControlled) return;
    const boss = this.activeBossEncounter();
    if (boss) this.transitionTo(BOSS_MUSIC_KEYS[boss.kind], true);
    else this.playNextMusicTrack();
  }

  setPaused(paused: boolean): void {
    this.musicPaused = paused;
    if (paused) {
      this.musicTracks.forEach((track) => track.pause());
      return;
    }
    if (this.music) this.playTrack(this.music, this.pendingMusicPlays.get(this.music) ?? 0);
  }

  beginBossTheme(kind: BossMusicKind): number {
    if (this.networkControlled) return 0;
    const encounterId = ++this.bossSequence;
    this.bossEncounters.set(encounterId, { kind, sequence: encounterId });
    const active = this.activeBossEncounter();
    if (active) this.transitionTo(BOSS_MUSIC_KEYS[active.kind], true);
    return encounterId;
  }

  endBossTheme(encounterId: number | undefined): void {
    if (this.networkControlled) return;
    if (encounterId === undefined || !this.bossEncounters.delete(encounterId)) return;
    const active = this.activeBossEncounter();
    if (active) this.transitionTo(BOSS_MUSIC_KEYS[active.kind], true);
    else this.playNextMusicTrack(true);
  }

  endLatestBossTheme(kind?: BossMusicKind): void {
    const matches = [...this.bossEncounters.entries()]
      .filter(([, encounter]) => !kind || encounter.kind === kind)
      .sort(([, left], [, right]) => right.sequence - left.sequence);
    const encounter = matches[0];
    if (encounter) this.endBossTheme(encounter[0]);
  }

  applyNetworkCue(cue: MusicCue): void {
    if (this.destroyed || !cue?.key) return;
    this.transitionTo(cue.key, cue.loop, 0, false);
  }

  beginDefeatTheme(): void {
    if (this.destroyed || this.networkControlled) return;
    this.bossEncounters.clear();
    this.transitionTo(Phaser.Math.RND.pick(DEFEAT_MUSIC_KEYS), true);
  }

  fadeOutMusic(onComplete: () => void, duration = 700): void {
    if (this.fadingOut) return;
    this.fadingOut = true;
    const tracks = [...this.musicTracks];
    if (tracks.length === 0) {
      onComplete();
      return;
    }
    tracks.forEach((track) => this.scene.tweens.killTweensOf(track));
    this.scene.tweens.add({
      targets: tracks,
      volume: 0,
      duration,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        tracks.forEach((track) => {
          this.releaseMusicTrack(track);
        });
        this.music = undefined;
        this.musicKey = undefined;
        onComplete();
      },
    });
  }

  private activeBossEncounter(): BossEncounter | undefined {
    return [...this.bossEncounters.values()].sort((left, right) => (
      BOSS_MUSIC_PRIORITY[right.kind] - BOSS_MUSIC_PRIORITY[left.kind]
      || right.sequence - left.sequence
    ))[0];
  }

  private playNextMusicTrack(resumeInProgress = false): void {
    if (this.destroyed || this.networkControlled || this.bossEncounters.size > 0) return;
    const choices = MUSIC_KEYS.filter((key) => key !== this.lastMusicKey);
    const key = Phaser.Math.RND.pick(choices.length > 0 ? choices : MUSIC_KEYS);
    this.lastMusicKey = key;
    this.transitionTo(key, false, resumeInProgress ? 60 : 0);
  }

  private transitionTo(key: string, loop: boolean, seek = 0, notify = true): void {
    if (this.destroyed || (this.musicKey === key && this.music)) return;
    const url = MUSIC_URLS[key];
    if (!url) return;

    const previous = this.music;
    if (previous) this.releaseMusicTrack(previous);
    const track = new Audio();
    track.preload = 'auto';
    track.loop = loop;
    track.volume = MUSIC_VOLUME;
    track.setAttribute('playsinline', '');
    track.setAttribute('aria-hidden', 'true');
    track.src = url;
    this.musicTracks.add(track);
    this.music = track;
    this.musicKey = key;
    if (notify) this.onCue?.({ key, loop });
    track.addEventListener('ended', () => {
      if (this.music !== track || this.destroyed) return;
      this.music = undefined;
      this.musicKey = undefined;
      this.releaseMusicTrack(track);
      if (!this.networkControlled) this.playNextMusicTrack();
    });
    this.playTrack(track, seek);
  }

  private playTrack(track: MusicTrack, seek = 0): void {
    if (this.destroyed || this.musicPaused || this.music !== track) return;
    if (seek > 0) {
      const applySeek = () => {
        if (this.destroyed || this.music !== track || !Number.isFinite(track.duration)) return;
        track.currentTime = Math.min(seek, Math.max(0, track.duration - 20));
      };
      if (track.readyState >= HTMLMediaElement.HAVE_METADATA) applySeek();
      else track.addEventListener('loadedmetadata', applySeek, { once: true });
    }

    const playPromise = track.play();
    if (!playPromise) return;
    void playPromise.then(() => {
      this.pendingMusicPlays.delete(track);
      this.removeMusicUnlockHandlerIfIdle();
    }).catch((error: unknown) => {
      if (this.destroyed || this.music !== track) return;
      const name = error && typeof error === 'object' && 'name' in error
        ? String(error.name)
        : '';
      if (name !== 'NotAllowedError') return;
      this.pendingMusicPlays.set(track, seek);
      this.installMusicUnlockHandler();
    });
  }

  private installMusicUnlockHandler(): void {
    if (this.musicUnlockHandler) return;
    this.musicUnlockHandler = () => {
      if (this.destroyed) return;
      [...this.pendingMusicPlays.entries()].forEach(([track, seek]) => {
        if (track !== this.music) this.pendingMusicPlays.delete(track);
        else this.playTrack(track, seek);
      });
      this.removeMusicUnlockHandlerIfIdle();
    };
    document.addEventListener('pointerdown', this.musicUnlockHandler);
    document.addEventListener('keydown', this.musicUnlockHandler);
  }

  private removeMusicUnlockHandlerIfIdle(): void {
    if (this.pendingMusicPlays.size > 0 || !this.musicUnlockHandler) return;
    document.removeEventListener('pointerdown', this.musicUnlockHandler);
    document.removeEventListener('keydown', this.musicUnlockHandler);
    this.musicUnlockHandler = undefined;
  }

  private releaseMusicTrack(track: MusicTrack): void {
    this.scene.tweens.killTweensOf(track);
    this.pendingMusicPlays.delete(track);
    track.pause();
    track.removeAttribute('src');
    track.load();
    this.musicTracks.delete(track);
    this.removeMusicUnlockHandlerIfIdle();
  }

  playTone(
    frequency: number,
    duration: number,
    volume: number,
    type: DuoOscillatorType = 'square',
    position?: AudioPosition,
    metadata?: SoundMetadata,
  ): void {
    const context = this.context();
    if (!context || context.state !== 'running') return;
    this.emitSound({
      kind: 'tone',
      frequency,
      duration,
      volume,
      oscillator: type,
    }, position, metadata);
    this.playToneInternal(context, frequency, duration, volume, type);
  }

  playToneLocally(
    frequency: number,
    duration: number,
    volume: number,
    type: DuoOscillatorType = 'square',
  ): void {
    const context = this.context();
    if (!context || context.state !== 'running') return;
    this.playToneInternal(context, frequency, duration, volume, type);
  }

  playNoise(
    duration: number,
    volume: number,
    frequency: number,
    position?: AudioPosition,
    metadata?: SoundMetadata,
  ): void {
    const context = this.context();
    if (!context || context.state !== 'running') return;
    this.emitSound({ kind: 'noise', duration, volume, frequency }, position, metadata);
    this.playNoiseInternal(context, duration, volume, frequency);
  }

  playAlert(position?: AudioPosition): void {
    const context = this.context();
    if (!context || context.state !== 'running') return;
    this.emitSound({ kind: 'alert' }, position);
    this.playAlertInternal(context);
  }

  playNetworkSound(sound: Record<string, unknown>, listener?: AudioPosition): void {
    const context = this.context();
    if (!context || context.state !== 'running' || !sound || typeof sound.kind !== 'string') return;
    const origin = this.networkPosition(sound);
    const attenuation = origin && listener
      ? Phaser.Math.Clamp(1 - Phaser.Math.Distance.Between(origin.x, origin.y, listener.x, listener.y) / 900, 0.14, 1)
      : 1;
    if (sound.kind === 'tone') {
      const oscillator = sound.oscillator;
      if (!isOscillatorType(oscillator)) return;
      this.playToneInternal(
        context,
        clampFinite(sound.frequency, 20, 20000, 440),
        clampFinite(sound.duration, 0.001, 4, 0.08),
        clampFinite(sound.volume, 0, 1, 0.04) * attenuation,
        oscillator,
      );
    } else if (sound.kind === 'noise') {
      this.playNoiseInternal(
        context,
        clampFinite(sound.duration, 0.001, 4, 0.08),
        clampFinite(sound.volume, 0, 1, 0.03) * attenuation,
        clampFinite(sound.frequency, 20, 20000, 900),
      );
    } else if (sound.kind === 'alert') {
      this.playAlertInternal(context);
    }
  }

  private playToneInternal(
    context: AudioContext,
    frequency: number,
    duration: number,
    volume: number,
    type: DuoOscillatorType,
  ): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(28, frequency * 0.42), context.currentTime + duration);
    gain.gain.setValueAtTime(volume, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + duration);
  }

  private playNoiseInternal(context: AudioContext, duration: number, volume: number, frequency: number): void {
    const frameCount = Math.floor(context.sampleRate * duration);
    const buffer = context.createBuffer(1, frameCount, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i += 1) {
      samples[i] = (Math.random() * 2 - 1) * (1 - i / frameCount);
    }

    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = 'lowpass';
    filter.frequency.value = frequency;
    gain.gain.value = volume;
    source.connect(filter).connect(gain).connect(context.destination);
    source.start();
  }

  private playAlertInternal(context: AudioContext): void {
    const start = context.currentTime;
    [0, 0.17].forEach((delay, index) => {
      const oscillator = context.createOscillator();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const beginsAt = start + delay;
      const endsAt = beginsAt + 0.11;
      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(index === 0 ? 520 : 410, beginsAt);
      oscillator.frequency.exponentialRampToValueAtTime(index === 0 ? 410 : 330, endsAt);
      filter.type = 'bandpass';
      filter.frequency.value = 850;
      filter.Q.value = 0.8;
      gain.gain.setValueAtTime(0.001, beginsAt);
      gain.gain.exponentialRampToValueAtTime(0.045, beginsAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, endsAt);
      oscillator.connect(filter).connect(gain).connect(context.destination);
      oscillator.start(beginsAt);
      oscillator.stop(endsAt);
    });
    this.playNoiseInternal(context, 0.08, 0.018, 1200);
  }

  private emitSound(sound: DuoSoundEffect, position?: AudioPosition, metadata?: SoundMetadata): void {
    if (!this.onSound) return;
    const enriched = metadata ? { ...sound, ...metadata } : sound;
    if (position) this.onSound({ ...enriched, x: position.x, y: position.y } as DuoSoundEffect);
    else this.onSound(enriched as DuoSoundEffect);
  }

  private networkPosition(sound: Record<string, unknown>): AudioPosition | undefined {
    const x = Number(sound.x);
    const y = Number(sound.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }

  private context(): AudioContext | undefined {
    return 'context' in this.scene.sound ? this.scene.sound.context : undefined;
  }

  private destroy(): void {
    this.destroyed = true;
    this.bossEncounters.clear();
    if (this.musicUnlockHandler) {
      document.removeEventListener('pointerdown', this.musicUnlockHandler);
      document.removeEventListener('keydown', this.musicUnlockHandler);
      this.musicUnlockHandler = undefined;
    }
    [...this.musicTracks].forEach((track) => this.releaseMusicTrack(track));
    this.pendingMusicPlays.clear();
    this.musicTracks.clear();
    this.music = undefined;
    this.musicKey = undefined;
  }
}

function isOscillatorType(value: unknown): value is DuoOscillatorType {
  return value === 'sine' || value === 'square' || value === 'sawtooth' || value === 'triangle';
}

function clampFinite(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Phaser.Math.Clamp(number, minimum, maximum) : fallback;
}
