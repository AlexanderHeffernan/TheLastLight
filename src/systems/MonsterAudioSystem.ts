import Phaser from 'phaser';
import type { DuoMonsterVoiceEvent, DuoSoundEffect } from '../network/protocol';

export type MonsterType = 'shambler' | 'runner' | 'crawler' | 'brute' | 'charred'
  | 'breaker' | 'lurker' | 'furnace' | 'spitter';
export type MonsterVoiceEvent = 'spawn' | 'ambient' | 'hurt' | 'attack' | 'death';

interface VoiceProfile {
  pitch: number;
  duration: number;
  formants: [number, number];
  breathFrequency: number;
  breathAmount: number;
  waveform: OscillatorType;
  volume: number;
  vibratoRate: number;
  vibratoDepth: number;
}

const PROFILES: Record<MonsterType, VoiceProfile> = {
  shambler: {
    pitch: 76, duration: 1.75, formants: [360, 820], breathFrequency: 720, breathAmount: 0.18,
    waveform: 'sawtooth', volume: 0.17, vibratoRate: 2.4, vibratoDepth: 0.045,
  },
  runner: {
    pitch: 112, duration: 0.78, formants: [520, 1180], breathFrequency: 1350, breathAmount: 0.22,
    waveform: 'sawtooth', volume: 0.13, vibratoRate: 4.8, vibratoDepth: 0.035,
  },
  crawler: {
    pitch: 68, duration: 1.5, formants: [290, 640], breathFrequency: 520, breathAmount: 0.27,
    waveform: 'sawtooth', volume: 0.16, vibratoRate: 1.8, vibratoDepth: 0.06,
  },
  brute: {
    pitch: 48, duration: 2.15, formants: [220, 510], breathFrequency: 390, breathAmount: 0.16,
    waveform: 'sawtooth', volume: 0.23, vibratoRate: 1.45, vibratoDepth: 0.035,
  },
  charred: {
    pitch: 126, duration: 1.35, formants: [690, 1500], breathFrequency: 1750, breathAmount: 0.3,
    waveform: 'sawtooth', volume: 0.14, vibratoRate: 5.8, vibratoDepth: 0.05,
  },
  breaker: {
    pitch: 38, duration: 2.45, formants: [180, 430], breathFrequency: 320, breathAmount: 0.22,
    waveform: 'sawtooth', volume: 0.29, vibratoRate: 1.1, vibratoDepth: 0.03,
  },
  lurker: {
    pitch: 62, duration: 1.72, formants: [270, 760], breathFrequency: 680, breathAmount: 0.34,
    waveform: 'sawtooth', volume: 0.22, vibratoRate: 2.9, vibratoDepth: 0.08,
  },
  furnace: {
    pitch: 98, duration: 1.8, formants: [540, 1280], breathFrequency: 1900, breathAmount: 0.4,
    waveform: 'sawtooth', volume: 0.22, vibratoRate: 5.1, vibratoDepth: 0.055,
  },
  spitter: {
    pitch: 84, duration: 1.5, formants: [430, 1120], breathFrequency: 1450, breathAmount: 0.42,
    waveform: 'sawtooth', volume: 0.2, vibratoRate: 3.6, vibratoDepth: 0.075,
  },
};

const EVENT_SHAPE: Record<MonsterVoiceEvent, { duration: number; pitch: number; volume: number }> = {
  spawn: { duration: 1.08, pitch: 0.92, volume: 0.92 },
  ambient: { duration: 1.18, pitch: 0.96, volume: 0.9 },
  hurt: { duration: 0.38, pitch: 1.15, volume: 0.82 },
  attack: { duration: 0.5, pitch: 1.08, volume: 1 },
  death: { duration: 0.95, pitch: 0.78, volume: 1 },
};

/** Procedural, spatial monster vocals with a strict voice budget for large waves. */
export class MonsterAudioSystem {
  private readonly maxVoices = 7;
  private activeVoices = 0;
  private master?: GainNode;
  private noise?: AudioBuffer;
  private paused = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly options: { onSound?: (sound: DuoSoundEffect) => void } = {},
  ) {
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  play(
    type: MonsterType,
    event: MonsterVoiceEvent,
    x: number,
    y: number,
    listenerX: number,
    listenerY: number,
    replicate = true,
  ): boolean {
    if (replicate) {
      this.options.onSound?.({ kind: 'monster', monsterType: type, event, x, y });
    }
    const context = this.context();
    const apex = type === 'breaker' || type === 'lurker' || type === 'furnace' || type === 'spitter';
    const voiceLimit = apex
      ? this.maxVoices + 2
      : event === 'ambient' ? 3 : event === 'spawn' ? 4 : event === 'hurt' ? 6 : this.maxVoices;
    if (!context || context.state !== 'running' || this.paused || this.activeVoices >= voiceLimit) return false;

    const distance = Phaser.Math.Distance.Between(x, y, listenerX, listenerY);
    if (distance > 680) return false;

    const profile = PROFILES[type];
    const shape = EVENT_SHAPE[event];
    const duration = profile.duration * shape.duration * Phaser.Math.FloatBetween(0.88, 1.12);
    const pitch = profile.pitch * shape.pitch * Phaser.Math.FloatBetween(0.9, 1.1);
    const attenuation = Phaser.Math.Clamp(1 - distance / 920, 0.16, 1) ** 1.05;
    const level = profile.volume * shape.volume * attenuation;
    const now = context.currentTime;
    const output = context.createGain();
    const panner = context.createStereoPanner();
    const master = this.getMaster(context);

    panner.pan.value = Phaser.Math.Clamp((x - listenerX) / 430, -0.86, 0.86);
    const attack = event === 'ambient' || event === 'spawn' || event === 'death'
      ? Math.min(0.2, duration * 0.22)
      : Math.min(0.035, duration * 0.12);
    output.gain.setValueAtTime(0.0001, now);
    output.gain.exponentialRampToValueAtTime(level, now + attack);
    output.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    output.connect(panner).connect(master);

    const voice = context.createOscillator();
    const undertone = context.createOscillator();
    const undertoneGain = context.createGain();
    const firstFormant = context.createBiquadFilter();
    const secondFormant = context.createBiquadFilter();
    const firstFormantGain = context.createGain();
    const secondFormantGain = context.createGain();
    voice.type = profile.waveform;
    voice.frequency.setValueAtTime(pitch, now);
    voice.frequency.exponentialRampToValueAtTime(Math.max(28, pitch * this.endPitch(type, event)), now + duration);
    undertone.type = 'triangle';
    undertone.frequency.setValueAtTime(pitch * 0.505, now);
    undertone.frequency.exponentialRampToValueAtTime(Math.max(24, pitch * 0.505 * this.endPitch(type, event)), now + duration);
    undertoneGain.gain.value = type === 'breaker' ? 0.62 : type === 'brute' ? 0.5 : 0.24;
    firstFormant.type = 'bandpass';
    firstFormant.frequency.value = profile.formants[0] * Phaser.Math.FloatBetween(0.94, 1.06);
    firstFormant.Q.value = 5.5;
    secondFormant.type = 'bandpass';
    secondFormant.frequency.value = profile.formants[1] * Phaser.Math.FloatBetween(0.94, 1.06);
    secondFormant.Q.value = 7;
    firstFormantGain.gain.value = 0.92;
    secondFormantGain.gain.value = type === 'crawler' || type === 'lurker' ? 0.34 : 0.5;
    voice.connect(firstFormant).connect(firstFormantGain).connect(output);
    voice.connect(secondFormant).connect(secondFormantGain).connect(output);
    undertone.connect(undertoneGain).connect(firstFormant);

    const tremolo = context.createOscillator();
    const tremoloDepth = context.createGain();
    tremolo.frequency.value = profile.vibratoRate * Phaser.Math.FloatBetween(0.88, 1.12);
    tremoloDepth.gain.value = pitch * profile.vibratoDepth;
    tremolo.connect(tremoloDepth).connect(voice.frequency);

    const noiseSource = context.createBufferSource();
    const noiseFilter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noiseSource.buffer = this.getNoise(context);
    noiseSource.loop = true;
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(profile.breathFrequency, now);
    noiseFilter.Q.value = type === 'furnace' ? 2.4 : type === 'charred' ? 1.8 : type === 'spitter' ? 3.1 : 1.1;
    if (type === 'crawler' || type === 'lurker') {
      noiseFilter.frequency.exponentialRampToValueAtTime(310, now + duration);
      noiseFilter.Q.value = 3.8;
    }
    noiseGain.gain.value = profile.breathAmount;
    noiseSource.connect(noiseFilter).connect(noiseGain).connect(output);

    this.activeVoices += 1;
    voice.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
      output.disconnect();
    };
    voice.start(now);
    undertone.start(now);
    tremolo.start(now);
    noiseSource.start(now, Math.random() * 0.8);
    voice.stop(now + duration);
    undertone.stop(now + duration);
    tremolo.stop(now + duration);
    noiseSource.stop(now + duration);
    return true;
  }

  playNetworkSound(sound: Record<string, unknown>, listenerX: number, listenerY: number): void {
    const type = String(sound.monsterType ?? '');
    const event = String(sound.event ?? '') as DuoMonsterVoiceEvent;
    if (!isMonsterType(type) || !isMonsterVoiceEvent(event)) return;
    const x = Number(sound.x);
    const y = Number(sound.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.play(type, event, x, y, listenerX, listenerY, false);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    const context = this.context();
    if (!context || !this.master) return;
    this.master.gain.cancelScheduledValues(context.currentTime);
    this.master.gain.setTargetAtTime(paused ? 0 : 0.84, context.currentTime, 0.015);
  }

  private endPitch(type: MonsterType, event: MonsterVoiceEvent): number {
    if (event === 'death') {
      if (type === 'furnace') return 0.56;
      if (type === 'charred') return 0.62;
      if (type === 'breaker') return 0.6;
      return 0.68;
    }
    if (event === 'hurt') return 0.9;
    if (event === 'attack') return 0.86;
    if (type === 'runner') return 0.91;
    if (type === 'crawler' || type === 'lurker') return 0.82;
    return 0.88;
  }

  private getMaster(context: AudioContext): GainNode {
    if (this.master) return this.master;
    const master = context.createGain();
    const compressor = context.createDynamicsCompressor();
    master.gain.value = 0.84;
    compressor.threshold.value = -18;
    compressor.knee.value = 16;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.16;
    master.connect(compressor).connect(context.destination);
    this.master = master;
    return master;
  }

  private getNoise(context: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const samples = buffer.getChannelData(0);
    let previous = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const white = Math.random() * 2 - 1;
      previous = white * 0.72 + previous * 0.28;
      samples[i] = previous;
    }
    this.noise = buffer;
    return buffer;
  }

  private context(): AudioContext | undefined {
    return 'context' in this.scene.sound ? this.scene.sound.context : undefined;
  }

  private destroy(): void {
    this.master?.disconnect();
    this.master = undefined;
    this.noise = undefined;
    this.activeVoices = 0;
  }
}

function isMonsterType(value: string): value is MonsterType {
  return value in PROFILES;
}

function isMonsterVoiceEvent(value: string): value is MonsterVoiceEvent {
  return value === 'spawn' || value === 'ambient' || value === 'hurt' || value === 'attack' || value === 'death';
}
