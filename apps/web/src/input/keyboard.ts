export interface Intent {
  left: boolean;
  right: boolean;
}

const LEFT_CODES = new Set(["KeyA", "ArrowLeft"]);
const RIGHT_CODES = new Set(["KeyD", "ArrowRight"]);

/**
 * Keyboard tracker.
 *
 * - Online/solo: A/D **and** arrows steer the local player.
 * - Hotseat: A/D steer player A, arrows steer player B (reference layout).
 */
export class KeyboardInput {
  private readonly pressed = new Set<string>();
  private lastOwn: Intent = { left: false, right: false };
  private lastA: Intent = { left: false, right: false };
  private lastB: Intent = { left: false, right: false };
  private listeners: Array<() => void> = [];
  private disposed = false;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp, { passive: false });
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    if (
      event.code.startsWith("Arrow") ||
      event.code === "Space" ||
      event.code === "KeyA" ||
      event.code === "KeyD"
    ) {
      event.preventDefault();
    }
    if (this.pressed.has(event.code)) return;
    this.pressed.add(event.code);
    this.emit();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (!this.pressed.delete(event.code)) return;
    this.emit();
  };

  private onBlur = (): void => {
    this.clear();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === "hidden") this.clear();
  };

  clear(): void {
    if (this.pressed.size === 0) return;
    this.pressed.clear();
    this.emit();
  }

  own(): Intent {
    return {
      left: [...LEFT_CODES].some((code) => this.pressed.has(code)),
      right: [...RIGHT_CODES].some((code) => this.pressed.has(code)),
    };
  }

  hotseat(): { a: Intent; b: Intent } {
    return {
      a: { left: this.pressed.has("KeyA"), right: this.pressed.has("KeyD") },
      b: {
        left: this.pressed.has("ArrowLeft"),
        right: this.pressed.has("ArrowRight"),
      },
    };
  }

  isAnyPressed(): boolean {
    return this.pressed.size > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.listeners = [];
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}
