// Quest progression, pure over (content, save) so it unit-tests without a
// browser. A quest is an ordered list of steps; progress is how many are done,
// stored per quest id in the save. A quest with a `talk` first step starts
// when that NPC is spoken to, which is how "talk to X, go there, beat Y"
// chains read in the editor.
import type { NpcDef, QuestDef, QuestStep, WorldContent } from "./content";

/** The slice of SaveData quests read and write. */
export interface QuestSave {
  quests: Record<string, number>;
  story: { chapter: number; flags: Record<string, boolean> };
  money: number;
  bag: Record<string, number>;
}

export function questProgress(save: QuestSave, questId: string): number {
  return save.quests[questId] ?? 0;
}

export function questDone(quest: QuestDef, save: QuestSave): boolean {
  return quest.steps.length > 0 && questProgress(save, quest.id) >= quest.steps.length;
}

/** Visible to the player: prerequisites met and not finished. */
export function questAvailable(quest: QuestDef, content: WorldContent, save: QuestSave): boolean {
  if (quest.steps.length === 0 || questDone(quest, save)) return false;
  if (quest.after) {
    const prereq = content.quests.find((q) => q.id === quest.after);
    if (prereq && !questDone(prereq, save)) return false;
  }
  return true;
}

export function activeStep(quest: QuestDef, save: QuestSave): QuestStep | null {
  return quest.steps[questProgress(save, quest.id)] ?? null;
}

export function stepText(step: QuestStep, content: WorldContent): string {
  const npcName = (id: string): string => content.npcs.find((n) => n.id === id)?.name ?? id;
  if (step.kind === "talk") return `Talk to ${npcName(step.npcId)}`;
  if (step.kind === "defeat") return `Defeat ${npcName(step.npcId)}`;
  return step.label || "Reach the marked spot";
}

/**
 * Complete the active step. Returns toast lines: step start/finish notes, and
 * reward lines when the quest ends (rewards applied to the save here).
 */
export function advanceQuest(content: WorldContent, save: QuestSave, questId: string): string[] {
  const quest = content.quests.find((q) => q.id === questId);
  if (!quest || questDone(quest, save)) return [];
  const was = questProgress(save, questId);
  save.quests[questId] = was + 1;
  const messages: string[] = [];
  if (was === 0) messages.push(`Quest started: ${quest.name}`);
  const next = quest.steps[was + 1];
  if (next) {
    messages.push(`${quest.name}: ${stepText(next, content)}`);
    return messages;
  }
  messages.push(`Quest complete: ${quest.name}`);
  const r = quest.reward;
  if (r?.money) {
    save.money += r.money;
    messages.push(`+${r.money} coins`);
  }
  for (const [item, count] of Object.entries(r?.items ?? {})) {
    save.bag[item] = (save.bag[item] ?? 0) + count;
    messages.push(`+${count} ${item}`);
  }
  return messages;
}

export type NpcAction =
  | { kind: "quest-talk"; questId: string; lines: string[] }
  | { kind: "quest-battle"; questId: string; intro: string[] }
  | { kind: "battle"; intro: string[] }
  | { kind: "chat"; lines: string[] };

const beatFlag = (npcId: string): string => `beat:${npcId}`;

export function trainerBeaten(save: QuestSave, npcId: string): boolean {
  return save.story.flags[beatFlag(npcId)] === true;
}

export function markTrainerBeaten(save: QuestSave, npcId: string): void {
  save.story.flags[beatFlag(npcId)] = true;
}

/**
 * What talking to this NPC does right now. Quests take priority (first
 * available quest whose active step targets them), then their own trainer
 * fight, then chat.
 */
export function npcAction(content: WorldContent, save: QuestSave, npc: NpcDef): NpcAction {
  for (const quest of content.quests) {
    if (!questAvailable(quest, content, save)) continue;
    const step = activeStep(quest, save);
    if (!step) continue;
    if (step.kind === "talk" && step.npcId === npc.id) {
      return { kind: "quest-talk", questId: quest.id, lines: step.lines };
    }
    if (step.kind === "defeat" && step.npcId === npc.id && npc.trainer) {
      return { kind: "quest-battle", questId: quest.id, intro: step.intro };
    }
  }
  if (npc.trainer && !trainerBeaten(save, npc.id)) {
    return { kind: "battle", intro: npc.trainer.intro };
  }
  if (npc.trainer && trainerBeaten(save, npc.id) && npc.trainer.beaten.length > 0) {
    return { kind: "chat", lines: npc.trainer.beaten };
  }
  return { kind: "chat", lines: npc.lines };
}

/** Active `reach` steps to check the player's position against. */
export function reachSteps(content: WorldContent, save: QuestSave, mapId?: string): { questId: string; x: number; y: number; r: number }[] {
  const out: { questId: string; x: number; y: number; r: number }[] = [];
  for (const quest of content.quests) {
    if (!questAvailable(quest, content, save)) continue;
    const step = activeStep(quest, save);
    if (step?.kind === "reach" && (mapId === undefined || step.map === mapId)) {
      out.push({ questId: quest.id, x: step.x, y: step.y, r: step.r });
    }
  }
  return out;
}

/** NPC ids that should show a quest marker right now. */
export function markedNpcs(content: WorldContent, save: QuestSave): Set<string> {
  const marked = new Set<string>();
  for (const quest of content.quests) {
    if (!questAvailable(quest, content, save)) continue;
    const step = activeStep(quest, save);
    if (step && (step.kind === "talk" || step.kind === "defeat")) marked.add(step.npcId);
  }
  return marked;
}

/** The menu's quest log: started or startable quests with their objective. */
export function questLog(content: WorldContent, save: QuestSave): { name: string; objective: string; done: boolean }[] {
  const out: { name: string; objective: string; done: boolean }[] = [];
  for (const quest of content.quests) {
    if (questDone(quest, save)) {
      if (questProgress(save, quest.id) > 0) out.push({ name: quest.name, objective: "Complete", done: true });
      continue;
    }
    if (!questAvailable(quest, content, save)) continue;
    const step = activeStep(quest, save);
    if (!step) continue;
    // Unstarted quests stay hidden until their opening talk happens.
    if (questProgress(save, quest.id) === 0 && step.kind === "talk") continue;
    out.push({ name: quest.name, objective: stepText(step, content), done: false });
  }
  return out;
}
