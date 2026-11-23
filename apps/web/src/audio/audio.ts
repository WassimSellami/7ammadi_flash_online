import { RAIN_DELAY, RAIN_DROPS } from "@flash/core";
import { ASSET_BASE, STORAGE } from "../config";

interface SfxSpec {
  file: string;
  volume: number;
}

const SFX: Record<string, SfxSpec> = {
  smash: { file: "smash.mp3", volume: 1 },
  punch: { file: "punch.mp3", volume: 1 },
  gun: { file: "gun.mp3", volume: 0.2 },
  bomb: { file: "bomb.mp3", volume: 0.2 },
  plop: { file: "beep.mp3", volume: 0.3 },
  evil: { file: "evil.mp3", volume: 0.4 },
  s_go: { file: "s_go.mp3", volume: 0.2 },
  s_3: { file: "s_3.mp3", volume: 0.1 },
  s_2: { file: "s_2.mp3", volume: 0.1 },
  s_1: { file: "s_1.mp3", volume: 0.1 },
  /* Scoreboard and menu cue: a short beep. */
  scoreTick: { file: "beep.mp3", volume: 0.55 },
};

/** Music ceiling: the reference 0.2 lowered by 50%. */
const MUSIC_VOLUME = 0.1;
/** Every sound sample is lowered by 20% before the user's level is applied. */
const SFX_VOLUME = 0.8;
const POOL_SIZE = 5;

export type SfxName = keyof typeof SFX;

export type CountdownSfx = "s_3" | "s_2" | "s_1" | "s_go";

const COUNTDOWN_SFX: readonly CountdownSfx[] = ["s_3", "s_2", "s_1", "s_go"];

export class AudioManager {
  sfxEnabled: boolean;
  musicEnabled: boolean;
  /** User levels in [0, 1]; 1 is the reduced maximum. */
  musicLevel: number;
  sfxLevel: number;
  private unlocked = false;
  private pools = new Map<string, HTMLAudioElement[]>();
  private poolIndex = new Map<string, number>();
  private countdown = new Map<CountdownSfx, HTMLAudioElement>();
  private music: HTMLAudioElement | null = null;
  private musicWanted = false;
  private rainStop: number | null = null;

  constructor() {
    this.sfxEnabled = readFlag(STORAGE.sfx, true);
    this.musicEnabled = readFlag(STORAGE.music, true);
    this.musicLevel = readLevel(STORAGE.musicLevel);
    this.sfxLevel = readLevel(STORAGE.sfxLevel);
    for (const [name, spec] of Object.entries(SFX)) {
      const pool: HTMLAudioElement[] = [];
      for (let i = 0; i < POOL_SIZE; i += 1) {
        const audio = new Audio(`${ASSET_BASE}/sounds/${spec.file}`);
        audio.preload = "none";
        audio.volume = this.sfxVolume(spec.volume);
        pool.push(audio);
      }
      this.pools.set(name, pool);
      this.poolIndex.set(name, 0);
    }
    for (const name of COUNTDOWN_SFX) {
      const audio = new Audio(`${ASSET_BASE}/sounds/${SFX[name]!.file}`);
      audio.preload = "auto";
      audio.volume = this.sfxVolume(SFX[name]!.volume);
      audio.load();
      this.countdown.set(name, audio);
    }
    if (this.musicEnabled) this.music = this.createMusic();
  }

  private sfxVolume(base: number): number {
    return base * SFX_VOLUME * this.sfxLevel;
  }

  private musicVolume(): number {
    return MUSIC_VOLUME * this.musicLevel;
  }

  private createMusic(): HTMLAudioElement {
    const audio = new Audio(`${ASSET_BASE}/sounds/play_music.mp3`);
    audio.loop = true;
    audio.volume = this.musicVolume();
    audio.preload = "none";
    return audio;
  }

  unlock(): void {
    this.unlocked = true;
    if (this.musicWanted) this.playMusic();
  }

  play(name: SfxName): void {
    if (!this.sfxEnabled || !this.unlocked) return;
    const pool = this.pools.get(name);
    if (!pool) return;
    const index = this.poolIndex.get(name) ?? 0;
    const audio = pool[index]!;
    this.poolIndex.set(name, (index + 1) % pool.length);
    try {
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    } catch {
      // Autoplay or decode failure: ignore, the next gesture retries.
    }
  }

  /** One dedicated, preloaded clip per countdown label so it starts with the number. */
  playCountdown(name: CountdownSfx): void {
    if (!this.sfxEnabled || !this.unlocked) return;
    for (const audio of this.countdown.values()) {
      audio.pause();
      audio.currentTime = 0;
    }
    const audio = this.countdown.get(name);
    if (!audio) return;
    try {
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    } catch {
      // Autoplay or decode failure: ignore.
    }
  }

  stopCountdown(): void {
    for (const audio of this.countdown.values()) {
      audio.pause();
      audio.currentTime = 0;
    }
  }

  /** Colour-rain uses a stretched gun sample, matching the pygame intent. */
  playRain(): void {
    if (!this.sfxEnabled || !this.unlocked) return;
    const audio = new Audio(`${ASSET_BASE}/sounds/gun.mp3`);
    audio.volume = this.sfxVolume(SFX.gun!.volume);
    audio.preservesPitch = false;
    audio.playbackRate = 0.32;
    try {
      void audio.play().catch(() => undefined);
    } catch {
      return;
    }
    if (this.rainStop !== null) window.clearTimeout(this.rainStop);
    this.rainStop = window.setTimeout(() => {
      audio.pause();
      audio.currentTime = 0;
    }, RAIN_DROPS * RAIN_DELAY * 1000);
  }

  private playMusic(): void {
    if (!this.musicEnabled || !this.unlocked) return;
    if (!this.music) this.music = this.createMusic();
    if (this.music.paused) {
      void this.music.play().catch(() => undefined);
    }
  }

  /** Request the round music; it only starts for an unlocked playing round. */
  startMusic(): void {
    this.musicWanted = true;
    this.playMusic();
  }

  stopMusic(): void {
    this.musicWanted = false;
    if (!this.music) return;
    this.music.pause();
    this.music.currentTime = 0;
  }

  pauseMusic(): void {
    this.musicWanted = false;
    this.music?.pause();
  }

  setMusicLevel(level: number): void {
    this.musicLevel = clamp01(level);
    writeLevel(STORAGE.musicLevel, this.musicLevel);
    if (this.music) this.music.volume = this.musicVolume();
  }

  setSfxLevel(level: number): void {
    this.sfxLevel = clamp01(level);
    writeLevel(STORAGE.sfxLevel, this.sfxLevel);
    for (const [name, pool] of this.pools) {
      const volume = this.sfxVolume(SFX[name]!.volume);
      for (const audio of pool) audio.volume = volume;
    }
    for (const name of COUNTDOWN_SFX) {
      const audio = this.countdown.get(name);
      if (audio) audio.volume = this.sfxVolume(SFX[name]!.volume);
    }
  }

  setMusic(enabled: boolean): void {
    this.musicEnabled = enabled;
    writeFlag(STORAGE.music, enabled);
    if (!enabled) this.stopMusic();
  }

  setSfx(enabled: boolean): void {
    this.sfxEnabled = enabled;
    writeFlag(STORAGE.sfx, enabled);
    if (!enabled) this.stopCountdown();
  }

  toggleMusic(): boolean {
    this.setMusic(!this.musicEnabled);
    return this.musicEnabled;
  }

  toggleSfx(): boolean {
    this.setSfx(!this.sfxEnabled);
    return this.sfxEnabled;
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Private mode: keep the in-memory setting.
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function readLevel(key: string): number {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return 1;
    return clamp01(Number(value));
  } catch {
    return 1;
  }
}

function writeLevel(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private mode: keep the in-memory setting.
  }
}
