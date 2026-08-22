import { describe, expect, it } from "vitest";
import { mayPick, starterTurn, type LobbyState } from "../src/net/lobby";

const seat = (over: Partial<LobbyState["A"]> = {}): LobbyState["A"] => ({
  character: null, ready: false, here: true, ...over,
});

/** A seat belonging to somebody who has typed a name but not chosen yet. */
const named = (name: string): LobbyState["A"] =>
  seat({ character: { name, look: {}, starter: "" } });

const picked = (name: string, starter: string): LobbyState["A"] =>
  seat({ character: { name, look: {}, starter }, ready: true });

const state = (A: LobbyState["A"], B: LobbyState["A"]): LobbyState => ({ A, B });

describe("taking turns over the starters", () => {
  it("lets character A choose straight away", () => {
    expect(mayPick(state(named("Ren"), named("Nia")), "A")).toBe(true);
  });

  it("holds character B back until A has chosen", () => {
    expect(mayPick(state(named("Ren"), named("Nia")), "B")).toBe(false);
  });

  it("opens B's turn the moment A's choice lands", () => {
    expect(mayPick(state(picked("Ren", "flarea"), named("Nia")), "B")).toBe(true);
  });

  it("does not mistake a typed name for a choice", () => {
    // The name is announced as soon as it exists so the other side knows who
    // they are waiting on, with the starter still empty.
    const s = state(named("Ren"), seat());
    expect(s.A.character).not.toBeNull();
    expect(mayPick(s, "B")).toBe(false);
  });

  it("holds B back while A is still making a character at all", () => {
    expect(mayPick(state(seat(), named("Nia")), "B")).toBe(false);
  });

  it("still lets A choose while B is not here", () => {
    expect(mayPick(state(named("Ren"), seat({ here: false })), "A")).toBe(true);
  });
});

describe("what each player is told about the other", () => {
  it("locks A's Scoba out for B", () => {
    const turn = starterTurn(state(picked("Ren", "flarea"), named("Nia")), "B");
    expect(turn).toEqual({ yours: true, taken: "flarea", who: "Ren", here: true });
  });

  it("names who B is waiting on, before there is anything to lock", () => {
    const turn = starterTurn(state(named("Ren"), named("Nia")), "B");
    expect(turn.yours).toBe(false);
    expect(turn.who).toBe("Ren");
    expect(turn.taken).toBeNull();
  });

  it("has nothing to lock out for A, because B cannot have gone first", () => {
    const turn = starterTurn(state(named("Ren"), named("Nia")), "A");
    expect(turn.yours).toBe(true);
    expect(turn.taken).toBeNull();
  });

  it("says when the player being waited on has dropped out", () => {
    const away = seat({ character: { name: "Ren", look: {}, starter: "" }, here: false });
    const turn = starterTurn(state(away, named("Nia")), "B");
    expect(turn.here).toBe(false);
    expect(turn.yours).toBe(false);
  });

  it("has no name to give before the other player has typed one", () => {
    expect(starterTurn(state(seat(), named("Nia")), "B").who).toBeNull();
  });
});
