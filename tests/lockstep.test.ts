import { describe, expect, it } from "vitest";
import {
  resolveTurn, startBattle, stateHash, type BattleState, type Choice,
} from "../src/sim/battle";
import { makeWild } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

/**
 * Two independent battles built from one seed, the way the two clients in a
 * co-op fight each build their own copy.
 */
function pair(seedA = "shared-seed", seedB = "shared-seed"): [BattleState, BattleState] {
  // Owned, because a slot held by a character only fields that character's
  // Scobas: an unowned one leaves the slot empty and no choice is legal for it.
  const team = () => [
    { ...makeWild("cresce", 8, rngFrom("lock:a")), owner: "A" as const },
    { ...makeWild("grima", 8, rngFrom("lock:b")), owner: "B" as const },
  ];
  const foes = () => [
    makeWild("plib", 7, rngFrom("lock:e1")),
    makeWild("meepa", 7, rngFrom("lock:e2")),
  ];
  const opts = { slots: 2 as const, owners: ["A", "B"] as ["A", "B"] };
  return [
    startBattle(seedA, team(), foes(), opts),
    startBattle(seedB, team(), foes(), opts),
  ];
}

/**
 * Aims at whoever is still standing. A fixed index stops being legal the moment
 * that enemy faints, and nothing here sends a replacement in: that happens in
 * the battle scene, not in the sim.
 */
const standingFoe = (st: BattleState): number =>
  st.teams[1].findIndex((c) => !c.fainted);

const attack = (st: BattleState, slot: 0 | 1): Choice => ({
  kind: "attack", side: 0, slot,
  picks: [{ side: 1, index: standingFoe(st) }],
});

describe("two clients resolving the same round", () => {
  it("start from the same state given the same seed", () => {
    const [host, guest] = pair();
    expect(stateHash(host)).toBe(stateHash(guest));
  });

  it("agree when they hand the round in from opposite ends", () => {
    const [host, guest] = pair();
    // Each client asks about its own character first, so the arrays differ.
    // This is the property the whole co-op battle rests on.
    let rounds = 0;
    for (let turn = 0; turn < 4; turn++) {
      if (host.winner !== -1 || host.outcome !== "") break;
      if (standingFoe(host) < 0) break;
      rounds++;
      resolveTurn(host, [attack(host, 0), attack(host, 1)]);
      resolveTurn(guest, [attack(guest, 1), attack(guest, 0)]);
      expect(stateHash(guest)).toBe(stateHash(host));
    }
    expect(rounds).toBeGreaterThan(0);
  });

  it("agree when one character blocks and the other attacks", () => {
    const [host, guest] = pair();
    const block: Choice = { kind: "block", side: 0, slot: 1 };
    resolveTurn(host, [attack(host, 0), block]);
    resolveTurn(guest, [block, attack(guest, 0)]);
    expect(stateHash(guest)).toBe(stateHash(host));
  });

  it("disagree when the two rounds are genuinely different, so the hash is worth sending", () => {
    const [host, guest] = pair();
    resolveTurn(host, [attack(host, 0), attack(host, 1)]);
    resolveTurn(guest, [attack(guest, 0), { kind: "block", side: 0, slot: 1 }]);
    expect(stateHash(guest)).not.toBe(stateHash(host));
  });
});
