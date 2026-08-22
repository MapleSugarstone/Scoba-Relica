// Setting up an adventure with somebody, before either save exists.
//
// The waiting room first, then both of you making characters at the same time,
// then both walking into the world on the same beat. Each of you sees what the
// other has chosen as they choose it, so the Scoba one takes is greyed out for
// the other rather than being a surprise afterwards.
import { sfx } from "../engine/sfx";
import { Lobby, mayPick, type LobbyState, type StarterTurn } from "../net/lobby";
import type { CharacterProfile } from "../net/protocol";
import type { SlotId } from "../save/save";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export interface LobbyScreenDeps {
  /** Puts a screen up, the same way every other screen here does. */
  screen(build: (root: HTMLElement) => void): HTMLElement;
  toast(text: string): void;
  /** Make your own character, reporting each step so the other side can watch. */
  makeCharacter(
    slot: SlotId,
    turn: () => StarterTurn,
    onNamed: (profile: CharacterProfile) => void,
    onDone: (profile: CharacterProfile) => void,
  ): void;
  /** Both are ready and the world is settled. */
  onStart(lobby: Lobby, worldSeed: string, seats: LobbyState): void;
  onCancel(): void;
}

/** How a seat reads while you are waiting on it. */
function seatLine(who: string, seat: LobbyState["A"], theirTurn: boolean): string {
  if (!seat.here) return `${who}: not here yet`;
  if (seat.ready) return `${who}: ready`;
  if (seat.character) {
    return theirTurn
      ? `${who}: ${seat.character.name}, picking a Scoba`
      : `${who}: ${seat.character.name}, waiting for their turn to pick`;
  }
  return `${who}: here, making their character`;
}

/**
 * The waiting room. The host sees the code to read out; the guest arrives
 * already knowing it. Once both are here, both start making characters.
 */
export function lobbyScreen(deps: LobbyScreenDeps, room: string, mine: SlotId): Lobby {
  const other: SlotId = mine === "A" ? "B" : "A";
  let phase: "waiting" | "making" | "ready" | "done" = "waiting";

  const lobby = new Lobby(room, mine, {
    onState: (state) => render(state),
    onStart: (worldSeed) => {
      phase = "done";
      deps.onStart(lobby, worldSeed, lobby.seats);
    },
    onStatus: () => render(lobby.seats),
    onError: (reason) => setProblem(reason),
  });

  let statusEl: HTMLElement | null = null;
  let mineEl: HTMLElement | null = null;
  let theirsEl: HTMLElement | null = null;
  let problemEl: HTMLElement | null = null;
  /**
   * Something that stops this working at all, as opposed to something that
   * just happened. A toast is the wrong home for it: the relay follows an
   * out-of-date warning with an error for every message it then refuses, and
   * the last one wins, so the useful sentence is the one that gets buried.
   */
  let problem = "";

  const setProblem = (text: string): void => {
    // Keep the first, which is the one that explains the rest.
    if (!problem) problem = text;
    if (problemEl) {
      problemEl.textContent = problem;
      problemEl.hidden = false;
    }
  };

  const render = (state: LobbyState): void => {
    if (!statusEl?.isConnected) return;
    const bothHere = state[mine].here && state[other].here;
    statusEl.textContent = phase === "ready"
      ? "Waiting for the other player to finish..."
      : phase === "making"
        ? "Make your character. You will both start together."
        : bothHere
          ? "Both here. Starting setup..."
          : "Waiting for the other player to join...";
    if (mineEl) mineEl.textContent = seatLine("You", state[mine], mayPick(state, mine));
    if (theirsEl) theirsEl.textContent = seatLine("Them", state[other], mayPick(state, other));

    // The moment they turn up, both sides move on to making characters. It
    // starts here rather than on a button so neither of you is left waiting on
    // the other to press something.
    if (bothHere && phase === "waiting") {
      phase = "making";
      startMaking();
    }
  };

  const startMaking = (): void => {
    deps.makeCharacter(
      mine,
      () => lobby.starterTurn(),
      // Named but not finished: enough for the other side to stop guessing who
      // they are waiting for.
      (partial) => lobby.setMine(partial, false),
      (finished) => {
        lobby.setMine(finished, true);
        waitingForOther();
      },
    );
  };

  const waitingForOther = (): void => {
    phase = "ready";
    deps.screen((s) => {
      s.appendChild(el("h2", undefined, "Ready"));
      statusEl = el("div", "sub", "Waiting for the other player to finish...");
      s.appendChild(statusEl);
      problemEl = el("div", "lobbyProblem");
      problemEl.hidden = true;
      s.appendChild(problemEl);
      if (problem) setProblem(problem);

      const card = el("div", "card");
      mineEl = el("div", "dim", seatLine("You", lobby.seats[mine], mayPick(lobby.seats, mine)));
      theirsEl = el("div", "dim", seatLine("Them", lobby.seats[other], mayPick(lobby.seats, other)));
      card.appendChild(mineEl);
      card.appendChild(theirsEl);
      s.appendChild(card);
    });
    render(lobby.seats);
  };

  deps.screen((s) => {
    s.appendChild(el("h2", undefined, mine === "A" ? "Waiting for your friend" : "Joining"));
    statusEl = el("div", "sub", "Waiting for the other player to join...");
    s.appendChild(statusEl);

    if (mine === "A") {
      const card = el("div", "card");
      card.appendChild(el("strong", undefined, "Your code"));
      card.appendChild(el("div", "code", room));
      card.appendChild(el("div", "dim",
        "Read this out. They pick Join someone's adventure and type it in."));
      s.appendChild(card);
    }

    problemEl = el("div", "lobbyProblem");
    problemEl.hidden = true;
    s.appendChild(problemEl);
    if (problem) setProblem(problem);

    const seats = el("div", "card");
    mineEl = el("div", "dim", seatLine("You", lobby.seats[mine], mayPick(lobby.seats, mine)));
    theirsEl = el("div", "dim", seatLine("Them", lobby.seats[other], mayPick(lobby.seats, other)));
    seats.appendChild(mineEl);
    seats.appendChild(theirsEl);
    s.appendChild(seats);

    const back = el("button", "big", "Never mind");
    back.addEventListener("click", () => {
      sfx.back();
      lobby.close();
      deps.onCancel();
    });
    s.appendChild(back);
  });

  lobby.open();
  return lobby;
}
