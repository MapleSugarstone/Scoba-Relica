import { sfx } from "../engine/sfx";
import type { UI } from "./screens";
import { SPECIAL } from "../sim/species";

// Bounce: a marker sweeps the bar, tap when it's inside the green zone.
// Five taps, each worth up to 20 points; the score feeds the pet's mood.
export function openBounceGame(ui: UI, onScore: (score: number) => void): void {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  let raf = 0;
  let round = 0;
  let score = 0;
  const rounds = 5;

  ui.screen((s) => {
    s.appendChild(el("h2", undefined, `Bounce with ${SPECIAL.name}`));
    s.appendChild(el("div", "sub", "Tap when the marker is in the green."));
    const status = el("div", undefined, `Round 1/${rounds}`);
    s.appendChild(status);

    const bar = el("div", "mgbar");
    const zone = el("div", "mgzone");
    const mark = el("div", "mgmark");
    bar.appendChild(zone);
    bar.appendChild(mark);
    s.appendChild(bar);

    const tapBtn = el("button", "big primary", "Tap");
    s.appendChild(tapBtn);
    const quit = el("button", "big", "Stop early");
    s.appendChild(quit);

    let zoneCenter = 0.5;
    const zoneHalf = 0.09;
    const speed = 0.9 + Math.random() * 0.4;
    const phase = Math.random() * Math.PI * 2;

    const placeZone = (): void => {
      zoneCenter = 0.2 + Math.random() * 0.6;
      zone.style.left = `${(zoneCenter - zoneHalf) * 100}%`;
      zone.style.width = `${zoneHalf * 2 * 100}%`;
    };
    placeZone();

    let pos = 0;
    const start = performance.now();
    const animate = (now: number): void => {
      const t = (now - start) / 1000;
      pos = (Math.sin(t * speed * Math.PI * 2 + phase) + 1) / 2;
      mark.style.left = `calc(${pos * 100}% - 3px)`;
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    const finish = (): void => {
      cancelAnimationFrame(raf);
      ui.setLocked(false);
      ui.closeScreen();
      onScore(score);
    };

    tapBtn.addEventListener("click", () => {
      const dist = Math.abs(pos - zoneCenter);
      let pts = 0;
      if (dist <= zoneHalf * 0.35) pts = 20;
      else if (dist <= zoneHalf) pts = 12;
      else if (dist <= zoneHalf * 2) pts = 5;
      score += pts;
      if (pts >= 20) sfx.confirm();
      else if (pts > 0) sfx.tap();
      else sfx.back();
      ui.toast(pts > 0 ? `+${pts}` : "Miss");
      round += 1;
      if (round >= rounds) {
        finish();
      } else {
        status.textContent = `Round ${round + 1}/${rounds} · ${score} pts`;
        placeZone();
      }
    });
    quit.addEventListener("click", finish);
  });
  ui.setLocked(true);
}
