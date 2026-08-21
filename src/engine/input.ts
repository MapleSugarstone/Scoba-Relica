// Keyboard (WASD/arrows, E/Enter to interact) plus a dynamic touch joystick:
// touching the left 60% of the screen plants the stick there, dragging sets
// the axis. Touching the right side or the A button interacts.
export class Input {
  x = 0;
  y = 0;
  private keys = new Set<string>();
  private interactQueued = false;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stickEl: HTMLElement;
  private knobEl: HTMLElement;

  constructor() {
    this.stickEl = document.getElementById("stick")!;
    this.knobEl = document.getElementById("stickKnob")!;

    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.key.toLowerCase());
      if (e.key === "Enter" || e.key.toLowerCase() === "e" || e.key === " ") {
        this.interactQueued = true;
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());

    const hud = document.getElementById("hud")!;
    hud.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button, #dialog")) return;
      if (e.pointerType === "mouse") return;
      document.body.classList.add("touch");
      if (e.clientX < window.innerWidth * 0.6 && this.stickId === null) {
        this.stickId = e.pointerId;
        this.stickOrigin = { x: e.clientX, y: e.clientY };
        this.stickEl.style.display = "block";
        this.stickEl.style.left = `${e.clientX - 55}px`;
        this.stickEl.style.top = `${e.clientY - 55}px`;
        this.moveKnob(0, 0);
        hud.setPointerCapture(e.pointerId);
      } else {
        this.interactQueued = true;
      }
    });
    hud.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.stickId) return;
      const dx = e.clientX - this.stickOrigin.x;
      const dy = e.clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy);
      const max = 40;
      const clamped = Math.min(len, max);
      const nx = len > 4 ? (dx / len) * (clamped / max) : 0;
      const ny = len > 4 ? (dy / len) * (clamped / max) : 0;
      this.x = nx;
      this.y = ny;
      this.moveKnob(nx * max, ny * max);
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.x = 0;
      this.y = 0;
      this.stickEl.style.display = "none";
    };
    hud.addEventListener("pointerup", endStick);
    hud.addEventListener("pointercancel", endStick);

    document.getElementById("actBtn")!.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.interactQueued = true;
    });
  }

  private moveKnob(dx: number, dy: number): void {
    this.knobEl.style.left = `${33 + dx}px`;
    this.knobEl.style.top = `${33 + dy}px`;
  }

  /** Current movement axis, unit-clamped. Keyboard overrides when active. */
  axis(): { x: number; y: number } {
    let kx = 0;
    let ky = 0;
    if (this.keys.has("a") || this.keys.has("arrowleft")) kx -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) kx += 1;
    if (this.keys.has("w") || this.keys.has("arrowup")) ky -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) ky += 1;
    if (kx !== 0 || ky !== 0) {
      const len = Math.hypot(kx, ky);
      return { x: kx / len, y: ky / len };
    }
    const len = Math.hypot(this.x, this.y);
    if (len > 1) return { x: this.x / len, y: this.y / len };
    return { x: this.x, y: this.y };
  }

  /** True once per interact press. */
  takeInteract(): boolean {
    const v = this.interactQueued;
    this.interactQueued = false;
    return v;
  }
}
