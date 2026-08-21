// Fixed-timestep update (60 Hz) with render once per animation frame.
export function startLoop(update: (dt: number) => void, render: () => void): () => void {
  const STEP = 1 / 60;
  let last = performance.now();
  let acc = 0;
  let raf = 0;
  const tick = (now: number) => {
    acc += Math.min((now - last) / 1000, 0.25);
    last = now;
    while (acc >= STEP) {
      update(STEP);
      acc -= STEP;
    }
    render();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
