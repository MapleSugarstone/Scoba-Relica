import { describe, expect, it } from "vitest";
import { emptyContent, type NpcDef, type WorldContent } from "../src/game/content";
import {
  advanceQuest, markTrainerBeaten, markedNpcs, npcAction, questAvailable,
  questDone, questLog, reachSteps, trainerBeaten, type QuestSave,
} from "../src/game/quests";

function guide(): NpcDef {
  return {
    id: "guide", name: "Maple", map: "m", x: 100, y: 100,
    skin: { kind: "scoba", species: "plib" },
    lines: ["Nice weather."], wander: 0,
  };
}

function rival(): NpcDef {
  return {
    id: "rival", name: "Juno", map: "m", x: 300, y: 200,
    skin: { kind: "scoba", species: "flarea" },
    lines: ["..."], wander: 0,
    trainer: {
      team: [{ species: "plib", level: 4 }],
      reward: 80,
      intro: ["Fight me."],
      beaten: ["You win, again."],
    },
  };
}

function fixture(): { content: WorldContent; save: QuestSave } {
  const content = emptyContent();
  content.npcs = [guide(), rival()];
  content.quests = [
    {
      id: "q1", name: "First Steps",
      steps: [
        { kind: "talk", npcId: "guide", lines: ["Go see the far island."] },
        { kind: "reach", map: "m", x: 500, y: 300, r: 30, label: "Visit the far island" },
        { kind: "defeat", npcId: "rival", intro: ["So you made it."] },
      ],
      reward: { money: 100, items: { snare: 2 } },
    },
    {
      id: "q2", name: "Second Wind", after: "q1",
      steps: [{ kind: "talk", npcId: "guide", lines: ["Back already?"] }],
    },
  ];
  const save: QuestSave = { quests: {}, story: { chapter: 0, flags: {} }, money: 0, bag: {} };
  return { content, save };
}

describe("quest progression", () => {
  it("walks a talk-reach-defeat chain to completion", () => {
    const { content, save } = fixture();
    const g = content.npcs[0]!;
    const r = content.npcs[1]!;

    const first = npcAction(content, save, g);
    expect(first).toEqual({ kind: "quest-talk", questId: "q1", lines: ["Go see the far island."] });
    expect(markedNpcs(content, save).has("guide")).toBe(true);
    expect(reachSteps(content, save)).toHaveLength(0);

    const started = advanceQuest(content, save, "q1");
    expect(started[0]).toBe("Quest started: First Steps");
    expect(started[1]).toContain("Visit the far island");

    expect(reachSteps(content, save)).toEqual([{ questId: "q1", x: 500, y: 300, r: 30 }]);
    advanceQuest(content, save, "q1");

    const fight = npcAction(content, save, r);
    expect(fight).toEqual({ kind: "quest-battle", questId: "q1", intro: ["So you made it."] });
    expect(markedNpcs(content, save).has("rival")).toBe(true);

    const finished = advanceQuest(content, save, "q1");
    expect(finished).toContain("Quest complete: First Steps");
    expect(save.money).toBe(100);
    expect(save.bag["snare"]).toBe(2);
    expect(questDone(content.quests[0]!, save)).toBe(true);
  });

  it("gates a quest behind its prerequisite", () => {
    const { content, save } = fixture();
    const q2 = content.quests[1]!;
    expect(questAvailable(q2, content, save)).toBe(false);
    save.quests["q1"] = 3;
    expect(questAvailable(q2, content, save)).toBe(true);
    const g = content.npcs[0]!;
    expect(npcAction(content, save, g)).toEqual({ kind: "quest-talk", questId: "q2", lines: ["Back already?"] });
  });

  it("does not advance past the end or double-pay rewards", () => {
    const { content, save } = fixture();
    save.quests["q1"] = 2;
    advanceQuest(content, save, "q1");
    expect(save.money).toBe(100);
    expect(advanceQuest(content, save, "q1")).toEqual([]);
    expect(save.money).toBe(100);
    expect(save.quests["q1"]).toBe(3);
  });

  it("falls back to trainer fight and beaten chat outside quests", () => {
    const { content, save } = fixture();
    save.quests["q1"] = 3;
    const r = content.npcs[1]!;
    expect(npcAction(content, save, r)).toEqual({ kind: "battle", intro: ["Fight me."] });
    markTrainerBeaten(save, "rival");
    expect(trainerBeaten(save, "rival")).toBe(true);
    expect(npcAction(content, save, r)).toEqual({ kind: "chat", lines: ["You win, again."] });
  });

  it("keeps unstarted talk-opening quests out of the log", () => {
    const { content, save } = fixture();
    expect(questLog(content, save)).toEqual([]);
    save.quests["q1"] = 1;
    expect(questLog(content, save)).toEqual([
      { name: "First Steps", objective: "Visit the far island", done: false },
    ]);
    save.quests["q1"] = 3;
    const log = questLog(content, save);
    expect(log[0]).toEqual({ name: "First Steps", objective: "Complete", done: true });
  });
});
