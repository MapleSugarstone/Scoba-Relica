// Rebuilds everything a kept Scoba has from what it is: its line, its level,
// its father and the choices breeding made for it. A save keeps only those, so
// a line whose moves, passives or stats change in the content changes every
// Scoba of that line the next time the save is loaded.
import { babyLineOf, inheritGenes } from "./breeding";
import { MAX_MANA, costOf, maxHp, rescaleLine, type ScobaInstance } from "./scoba";
import { ABILITIES, MOVES, SPECIES, evolutionOf, firstFormOf, speciesMoves, type Species } from "./species";
import type { Stats } from "./types";

/** Every species a line passes through, first form first. */
function formsOf(sp: Species): Species[] {
  const out = [firstFormOf(sp)];
  for (let next = evolutionOf(out[0]!); next && !out.includes(next); next = evolutionOf(next)) out.push(next);
  return out;
}

/** A Scoba of this species that was never bred, for measuring its line. */
const unbred = (sp: Species): ScobaInstance => ({ speciesId: sp.id, genes: { ...sp.genes } }) as ScobaInstance;

/**
 * The stat line a hybrid of this line and this father hatches with, grown into
 * `sp` the way evolving grows it. The mother is measured as her line's first
 * form, which is exact for every line there is: a line with a baby measures any
 * mother as that baby, and a line without one has one form.
 */
function bredLine(sp: Species, sire: Species): Stats | null {
  const forms = formsOf(sp);
  const at = forms.findIndex((f) => f.id === sp.id);
  if (at < 0) return null;
  let genes = inheritGenes(babyLineOf(unbred(forms[0]!)), babyLineOf(unbred(sire)));
  for (let i = 1; i <= at; i++) genes = rescaleLine(genes, forms[i - 1]!.genes, forms[i]!.genes);
  return genes;
}

/**
 * The move a hybrid took from its father and the slot it took. A save from
 * before this was kept says it only through the moves, so it is read off those.
 */
function inheritedOf(s: ScobaInstance, sp: Species): { move: string; slot: number } | null {
  if (s.inherited) return s.inherited;
  const slot = (s.moves ?? []).findIndex((m) => MOVES[m] && !sp.moves.includes(m));
  return slot >= 0 ? { move: s.moves[slot]!, slot } : null;
}

/** Whether a passive is on some line's pool, which is what a father could have handed on. */
function onSomePool(id: string): boolean {
  return Object.values(SPECIES).some((x) => !x.pawn && !x.fusion && !x.special && x.secondaryPool.includes(id));
}

/**
 * Puts back everything that follows from what the Scoba is. An unbred one is
 * its line: its line's stats and moves, and a second passive off its line's
 * pool. A hybrid is its line and its father: the stats the two make, its line's
 * moves with the one it took from him on the slot it took, and the passive it
 * was bred with while some line still offers it. HP keeps its share of the bar.
 */
export function rebuildScoba(s: ScobaInstance): void {
  const sp = SPECIES[s.speciesId];
  if (!sp || sp.pawn || sp.fusion) return;
  const was = s.genes ? maxHp(s) : 0;
  const sire = s.hybrid && s.sire ? SPECIES[s.sire] : undefined;
  const forms = formsOf(sp);

  // A hybrid from before fathers were kept has nothing to rebuild its line
  // from, so it keeps the one it has.
  if (!s.hybrid) s.genes = { ...sp.genes };
  else if (sire) s.genes = bredLine(sp, sire) ?? s.genes;

  const moves = speciesMoves(sp);
  const took = s.hybrid ? inheritedOf(s, sp) : null;
  if (took && MOVES[took.move] && moves.length > 0 && !moves.includes(took.move) && costOf(sp.id, took.move) <= MAX_MANA) {
    moves[Math.min(took.slot, moves.length - 1)] = took.move;
    s.inherited = { move: took.move, slot: took.slot };
  } else {
    delete s.inherited;
  }
  s.moves = moves.length > 0 ? moves : s.moves ?? [];

  const own = forms.flatMap((f) => f.secondaryPool);
  const kept = ABILITIES[s.secondaryAbility] !== undefined
    && (s.hybrid ? onSomePool(s.secondaryAbility) : own.includes(s.secondaryAbility));
  if (!kept) s.secondaryAbility = sp.secondaryPool[0] ?? "";

  // A hybrid leads with its father's element too, where its line leads with another.
  if (sire) {
    if (sire.type !== forms[0]!.type) s.type2 = sire.type;
    else delete s.type2;
  } else if (!s.hybrid) {
    delete s.type2;
  }

  const now = maxHp(s);
  s.hp = was > 0 && typeof s.hp === "number" ? Math.min(now, Math.round((s.hp * now) / was)) : now;
}

/**
 * A Scoba as the save keeps it: what it is, without what is rebuilt from that.
 * A hybrid's stat line stays, as the fallback for one whose father is unknown.
 */
export function storedScoba(s: ScobaInstance): Partial<ScobaInstance> {
  const out: Partial<ScobaInstance> = { ...s };
  delete out.moves;
  if (!s.hybrid) {
    delete out.genes;
    delete out.type2;
  }
  return out;
}
