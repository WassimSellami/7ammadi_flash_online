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

const MUSIC_VOLUME = 0.2;
const POOL_SIZE = 5;

export type SfxName = keyof typeof SFX;

export class AudioManager {
  sfxEnabled: boolean;
  musicEnabled: boolean;
  private unlocked = false;
  private pools = new Map<string, HTMLAudioElement[]>();
  private poolIndex = new Map<string, number>();
  private music: HTMLAudioElement | null = null;
  private musicWanted = false;
  private rainStop: number | null = null;

  constructor() {
    this.sfxEnabled = readFlag(STORAGE.sfx, true);
    this.musicEnabled = readFlag(STORAGE.music, true);
    for (const [name, spec] of Object.entries(SFX)) {
      const pool: HTMLAudioElement[] = [];
      for (let i = 0; i < POOL_SIZE; i += 1) {
        const audio = new Audio(`${ASSET_BASE}/sounds/${spec.file}`);
        audio.preload = "none";
        audio.volume = spec.volume;
        pool.push(audio);
      }
      this.pools.set(name, pool);
      this.poolIndex.set(name, 0);
    }
    if (this.musicEnabled) this.music = this.createMusic();
  }

  private createMusic(): HTMLAudioElement {
    const audio = new Audio(`${ASSET_BASE}/sounds/play_music.mp3`);
    audio.loop = true;
    audio.volume = MUSIC_VOLUME;
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

  /** Colour-rain uses a stretched gun sample, matching the pygame intent. */
  playRain(): void {
    if (!this.sfxEnabled || !this.unlocked) return;
    const audio = new Audio(`${ASSET_BASE}/sounds/gun.mp3`);
    audio.volume = SFX.gun!.volume;
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
    }, 1500);
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

  setMusic(enabled: boolean): void {
    this.musicEnabled = enabled;
    writeFlag(STORAGE.music, enabled);
    if (!enabled) this.stopMusic();
  }

  setSfx(enabled: boolean): void {
    this.sfxEnabled = enabled;
    writeFlag(STORAGE.sfx, enabled);
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
