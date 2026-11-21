import { PAINT_PALETTE } from "@flash/core";

export const ASSET_BASE = "/v1";
export const FONT_FAMILY = "Comic Neue";
export const PALETTES = PAINT_PALETTE;

/**
 * `data/effects.py` multiplies cosmetic sizes by
 * `min(width / 1440, height / 900)`; on the reference 1920x1080 window that is
 * exactly 1.2. Keep that factor so the browser matches the desktop build.
 */
export const FX_SCALE = 1.2;

export interface EnvLike {
  VITE_SERVER_URL?: string;
}

function envUrl(): string | undefined {
  const value = (import.meta.env as unknown as EnvLike).VITE_SERVER_URL;
  return value && value.trim() ? value.trim().replace(/\/$/, "") : undefined;
}

function splitProtocol(base: string): { http: string; ws: string } {
  if (base.startsWith("ws://") || base.startsWith("wss://")) {
    return {
      ws: base,
      http: base.replace(/^ws/, "http"),
    };
  }
  return {
    http: base,
    ws: base.replace(/^http/, "ws"),
  };
}

export function httpBase(): string {
  const configured = envUrl();
  if (configured) return splitProtocol(configured).http;
  return location.origin;
}

export function wsUrl(room: string): string {
  const configured = envUrl();
  const base = configured
    ? splitProtocol(configured).ws
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  return `${base}/ws?room=${encodeURIComponent(room)}`;
}

export function inviteUrl(room: string): string {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", room);
  return url.toString();
}

export function roomFromUrl(): string | null {
  const room = new URL(location.href).searchParams.get("room");
  if (!room) return null;
  const normalized = room.toUpperCase();
  return /^[A-Z0-9]{4,8}$/.test(normalized) ? normalized : null;
}

export function paletteColor(index: number): number {
  const rgb = PALETTES[index]?.rgb ?? PALETTES[0]!.rgb;
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

export function paletteCss(index: number): string {
  const rgb = PALETTES[index]?.rgb ?? PALETTES[0]!.rgb;
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function paletteName(index: number): string {
  return PALETTES[index]?.name ?? PALETTES[0]!.name;
}

export const STORAGE = {
  name: "flash.name",
  palette: "flash.palette",
  music: "flash.audio.music",
  sfx: "flash.audio.sfx",
  token: (room: string) => `flash.token.${room}`,
};
