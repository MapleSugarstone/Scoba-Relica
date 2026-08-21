export class Camera {
  x = 0;
  y = 0;

  follow(
    tx: number,
    ty: number,
    viewW: number,
    viewH: number,
    worldW: number,
    worldH: number,
  ): void {
    // Smooth follow, then clamp to world; center small worlds.
    const goalX = tx - viewW / 2;
    const goalY = ty - viewH / 2;
    this.x += (goalX - this.x) * 0.15;
    this.y += (goalY - this.y) * 0.15;
    this.x = worldW <= viewW ? (worldW - viewW) / 2 : Math.max(0, Math.min(this.x, worldW - viewW));
    this.y = worldH <= viewH ? (worldH - viewH) / 2 : Math.max(0, Math.min(this.y, worldH - viewH));
  }
}
