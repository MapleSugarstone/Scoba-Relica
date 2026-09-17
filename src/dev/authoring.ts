// What the editor knows about writing new records, kept apart from the DOM so
// it can be tested: the id a name becomes, the templates a new record starts
// from, the reference the palette lists, and which lines use which record.
import type { ScriptFile } from "../sim/script/content";
import { ABILITIES, MOVES, SPECIES, allSteps, type Species } from "../sim/species";
import { FIELDS, STATUSES, isContinuous, type Step } from "../sim/status";
import { BASE_GENES, TYPES, type ElementType, type Stats } from "../sim/types";
import type { MovementStyle } from "../sim/species";

/** The id a name is written as: lower-case letters, digits and dashes. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Whether an id is one the script reads. */
export const isId = (id: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(id);

/** The tables an id of each kind has to stay clear of. */
export function idTaken(file: ScriptFile, id: string): string | null {
  if (file === "moves" && MOVES[id]) return `a move called "${id}" already exists`;
  // A passive is carried as a status of its own id, so the two share one table.
  if ((file === "statuses" || file === "passives") && STATUSES[id]) {
    return `a ${ABILITIES[id] ? "passive" : "status"} called "${id}" already exists`;
  }
  if (file === "passives" && ABILITIES[id]) return `a passive called "${id}" already exists`;
  if (file === "fields" && FIELDS[id]) return `a field called "${id}" already exists`;
  return null;
}

// --- templates ---

export interface Template {
  label: string;
  /** What the template is for, shown beside its name. */
  says: string;
  text: (id: string, name: string) => string;
}

const q = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;

export const TEMPLATES: Record<ScriptFile, Template[]> = {
  moves: [
    {
      label: "Attack",
      says: "A physical blow at one enemy.",
      text: (id, name) => [
        `move ${id} ${q(name)}`,
        "  type plain",
        "  costs 30 mana",
        "  aim any enemy",
        `  text "Deals [damage] damage to one enemy."`,
        "  cast:",
        "    caster lunge",
        "    hit target 120% strength",
      ].join("\n"),
    },
    {
      label: "Spell",
      says: "A thrown magical hit at one enemy.",
      text: (id, name) => [
        `move ${id} ${q(name)}`,
        "  type moon",
        "  costs 35 mana",
        "  aim any enemy",
        `  text "Deals [damage] damage to one enemy."`,
        "  cast:",
        "    caster shake",
        "    throw as bolt to target",
        "    hit target 120% magic",
      ].join("\n"),
    },
    {
      label: "Attack that marks",
      says: "A hit that leaves a status on its target.",
      text: (id, name) => [
        `move ${id} ${q(name)}`,
        "  type sun",
        "  costs 40 mana",
        "  cooldown 1",
        "  aim any enemy",
        `  text "Deals [damage] damage and leaves one enemy [status:fire|burning]."`,
        "  cast:",
        "    caster shake",
        "    hit target 80% magic",
        "    inflict fire on target",
      ].join("\n"),
    },
    {
      label: "Line attack",
      says: "One hit on every enemy on the field.",
      text: (id, name) => [
        `move ${id} ${q(name)}`,
        "  type flux",
        "  costs 50 mana",
        "  cooldown 2",
        `  aim all enemies "The whole line"`,
        `  text "Deals [damage] damage to every enemy on the field."`,
        "  cast:",
        "    caster focus",
        "    throw as lob to target",
        "    hit target 80% magic",
      ].join("\n"),
    },
    {
      label: "Heal",
      says: "Restores a share of an ally's HP bar.",
      text: (id, name) => [
        `move ${id} ${q(name)}`,
        "  type moss",
        "  costs 45 mana",
        "  cooldown 2",
        `  aim any ally "Mend"`,
        `  text "Heals [heal] on one ally."`,
        "  cast:",
        "    caster focus",
        "    heal target 40% of their max hp",
      ].join("\n"),
    },
    {
      label: "Buff",
      says: "Leaves a good status on the caster.",
      text: (id, name) => [
        `move ${id} ${q(name)}`,
        "  type plain",
        "  costs 25 mana",
        "  cooldown 2",
        `  aim self "Brace"`,
        `  text "Leaves it [status:guard|guarded]."`,
        "  cast:",
        "    caster rear",
        "    inflict guard on target",
      ].join("\n"),
    },
    {
      label: "Wheel",
      says: "Picks a move out of the whole game, rewrites it and hands it over.",
      text: (id, name) => [
        `move ${id} ${q(name)}`,
        "  type fortuna",
        "  costs 40 mana",
        "  cooldown 3",
        `  aim self "Spin"`,
        `  text "Hands it one spell from anywhere in the game, rewritten as Fortuna."`,
        "  cast:",
        "    sound confirm",
        "    show spin as wheel over caster, pointer spintop",
        "    pick a random move, skip once per battle",
        "    change picked move:",
        "      set type fortuna",
        "      tint #e8c46a",
        "    give caster picked move as extra",
        `    say "The wheel comes up {picked}."`,
      ].join("\n"),
    },
  ],
  passives: [
    {
      label: "Stat boost",
      says: "Multiplies a stat for the whole battle.",
      text: (id, name) => [
        `passive ${id} ${q(name)}`,
        `  text "Strength +15%."`,
        "  while carried:",
        "    strength x1.15",
      ].join("\n"),
    },
    {
      label: "On a hit it lands",
      says: "Leaves a status on whoever it strikes.",
      text: (id, name) => [
        `passive ${id} ${q(name)}`,
        `  text "Every hit it lands leaves the target [status:wane|waning]."`,
        "  when it lands a hit:",
        "    inflict wane on other",
      ].join("\n"),
    },
    {
      label: "Each turn",
      says: "Runs a step at the end of every turn.",
      text: (id, name) => [
        `passive ${id} ${q(name)}`,
        `  text "Heals [heal:${id}] at the end of each turn."`,
        "  when a turn ends:",
        "    heal holder 6.25% of their max hp",
      ].join("\n"),
    },
    {
      label: "Once, on entry",
      says: "Runs once a battle as the holder takes the field.",
      text: (id, name) => [
        `passive ${id} ${q(name)}`,
        `  text "Taking the field leaves every enemy [status:sticky|stuck], once a battle."`,
        "  once per battle",
        "  when it takes the field:",
        "    inflict sticky on enemies",
      ].join("\n"),
    },
    {
      label: "Grants a move",
      says: "Hands the holder a move it can cast outside its slots.",
      text: (id, name) => [
        `passive ${id} ${q(name)}`,
        `  text "Lets it cast Crush without holding it."`,
        "  grants move crush",
      ].join("\n"),
    },
  ],
  statuses: [
    {
      label: "Stat change",
      says: "Multiplies a stat while it stands.",
      text: (id, name) => [
        `status ${id} ${q(name)}`,
        "  good",
        "  lasts 3 turns",
        "  while carried:",
        "    defense x1.25",
      ].join("\n"),
    },
    {
      label: "Damage each turn",
      says: "Deals damage at the end of every turn, measured off whoever left it.",
      text: (id, name) => [
        `status ${id} ${q(name)}`,
        "  bad",
        "  icon sun",
        "  lasts 3 turns",
        "  when a turn ends:",
        "    damage holder 15% of source magic, as sun magic, fixed when applied",
      ].join("\n"),
    },
    {
      label: "Drain that stacks",
      says: "Lowers a stat by a share of the source's, once per stack.",
      text: (id, name) => [
        `status ${id} ${q(name)}`,
        "  bad",
        "  icon boot",
        "  stacks up to 6",
        "  lost on switching out",
        "  power 30% of source magic",
        "  while carried:",
        "    speed - power",
      ].join("\n"),
    },
    {
      label: "Ward",
      says: "Stops the next hit of one element.",
      text: (id, name) => [
        `status ${id} ${q(name)}`,
        "  good",
        "  charges 1",
        "  while carried:",
        "    blocks sun hits",
      ].join("\n"),
    },
    {
      label: "Trigger",
      says: "Runs steps when something happens to the holder.",
      text: (id, name) => [
        `status ${id} ${q(name)}`,
        "  good",
        "  charges 1",
        "  when below 50% hp:",
        "    heal holder 10% of their max hp",
      ].join("\n"),
    },
  ],
  fields: [
    {
      label: "Element boost",
      says: "Multiplies one element's moves for the side under it.",
      text: (id, name) => [
        `field ${id} ${q(name)}`,
        "  icon sun",
        "  lasts 5 turns",
        "  tint #e7a03c",
        `  begins ${q(`${name} settles over the field.`)}`,
        `  ends ${q(`${name} lifts.`)}`,
        "  while standing:",
        "    sun moves x1.25",
      ].join("\n"),
    },
  ],
  hobbies: [
    {
      label: "One up, one down",
      says: "Raises one stat by half and takes a quarter off another.",
      text: (id, name) => [
        `hobby ${id} ${q(name)}`,
        `  doing ${q(`Doing ${name.toLowerCase()}`)}`,
        `  text ${q(`What ${name} is, in a line the hut reads out.`)}`,
        "  while carried:",
        "    strength x1.5",
        "    defense x0.75",
      ].join("\n"),
    },
    {
      label: "Two up, one down",
      says: "Raises two stats and takes a fifth off a third.",
      text: (id, name) => [
        `hobby ${id} ${q(name)}`,
        `  doing ${q(`Doing ${name.toLowerCase()}`)}`,
        `  text ${q(`What ${name} is, in a line the hut reads out.`)}`,
        "  while carried:",
        "    strength x1.35",
        "    defense x1.35",
        "    strength +15 after scaling",
        "    defense +15 after scaling",
        "    resistance x0.8",
      ].join("\n"),
    },
  ],
};

// --- the reference the palette lists ---

export interface RefLine {
  /** The phrase as an author writes it, with the parts to fill in angle brackets. */
  form: string;
  /** What it does, in one line. */
  says: string;
  /** A line that reads clean, put into the box when the entry is picked. */
  example: string;
}

export interface RefGroup {
  label: string;
  /** Which kinds of record the group belongs in. */
  in: ScriptFile[];
  lines: RefLine[];
}

const ALL: ScriptFile[] = ["moves", "statuses", "passives", "fields"];
const CARRIED: ScriptFile[] = ["statuses", "passives"];
const STEPPED: ScriptFile[] = ["moves", "statuses", "passives"];

export const REFERENCE: RefGroup[] = [
  {
    label: "Move lines",
    in: ["moves"],
    lines: [
      { form: "type <element>, <element>", says: "Its element, and an optional second one.", example: "type moon" },
      { form: "costs <n> mana", says: "What casting it takes.", example: "costs 30 mana" },
      { form: "cooldown <n>", says: "Turns it waits after a cast.", example: "cooldown 2" },
      { form: "starts on cooldown <n>", says: "Turns it waits at the start of a battle.", example: "starts on cooldown 1" },
      { form: "priority <n>", says: "Resolves ahead of every move with a lower one.", example: "priority 1" },
      { form: "once per battle", says: "Can be cast once a battle.", example: "once per battle" },
      { form: "aim <mode> \"<prompt>\" as <name>", says: "One group of targets. Write one line per group.", example: "aim any enemy" },
      { form: "text \"<words>\"", says: "The line a player reads.", example: "text \"Deals [damage] damage.\"" },
      { form: "cast:", says: "The steps casting it runs, in order.", example: "cast:" },
    ],
  },
  {
    label: "Aims",
    in: ["moves"],
    lines: [
      { form: "self", says: "The caster.", example: "aim self \"Brace\"" },
      { form: "any ally", says: "One ally on the field, the caster included.", example: "aim any ally \"Mend\"" },
      { form: "other ally", says: "One ally other than the caster.", example: "aim other ally \"Pass to\"" },
      { form: "any enemy", says: "One enemy on the field.", example: "aim any enemy" },
      { form: "any scoba", says: "Anyone on the field.", example: "aim any scoba \"Copy from\"" },
      { form: "benched ally", says: "One ally on the bench.", example: "aim benched ally \"Call\"" },
      { form: "benched enemy", says: "One enemy on the bench.", example: "aim benched enemy \"Reach\"" },
      { form: "all allies", says: "Every ally on the field.", example: "aim all allies \"Everyone\"" },
      { form: "all enemies", says: "Every enemy on the field.", example: "aim all enemies \"The whole line\"" },
      { form: "random ally", says: "One ally, rolled as the move resolves.", example: "aim random ally \"Whoever\"" },
      { form: "random enemy", says: "One enemy, rolled as the move resolves.", example: "aim random enemy \"Wherever it lands\"" },
      { form: "random scoba", says: "Anyone, rolled as the move resolves.", example: "aim random scoba \"Anyone\"" },
    ],
  },
  {
    label: "Status lines",
    in: ["statuses"],
    lines: [
      { form: "good | bad", says: "Which half of a cleanse removes it.", example: "bad" },
      { form: "icon <name>", says: "The sigil it shows, from assets/Sigils.", example: "icon sun" },
      { form: "sound <name>", says: "A sound as it lands, from assets/Sounds.", example: "sound stickysweet" },
      { form: "lasts <n> turns", says: "How many turns it stands.", example: "lasts 3 turns" },
      { form: "charges <n>", says: "How many times its when steps can run.", example: "charges 3" },
      { form: "stacks up to <n>", says: "Landing it again adds a stack.", example: "stacks up to 6" },
      { form: "lost on switching out", says: "Comes off when the holder is called back.", example: "lost on switching out" },
      { form: "shows a hand of cards", says: "Its stacks are a hand of cards.", example: "shows a hand of cards" },
      { form: "power <share>", says: "A number measured once as it lands.", example: "power 30% of source magic" },
    ],
  },
  {
    label: "Passive lines",
    in: ["passives"],
    lines: [
      { form: "text \"<words>\"", says: "The line a player reads.", example: "text \"Strength +15%.\"" },
      { form: "wears <name>", says: "Art worn by a line that inherited it, from assets/AccessoryScoba.", example: "wears cherry" },
      { form: "grants move <move>", says: "A move the holder casts outside its slots.", example: "grants move crush" },
      { form: "once per battle", says: "Its when steps run once a battle.", example: "once per battle" },
      { form: "charges <n>", says: "How many times its when steps run a battle.", example: "charges 2" },
    ],
  },
  {
    label: "Field lines",
    in: ["fields"],
    lines: [
      { form: "icon <name>", says: "The sigil it shows.", example: "icon sun" },
      { form: "lasts <n> turns", says: "How many turns it stands.", example: "lasts 5 turns" },
      { form: "tint <color>", says: "The wash over that side of the screen.", example: "tint #e7a03c" },
      { form: "begins \"<words>\"", says: "What the log says as it is laid.", example: "begins \"Sunlight pours over the field.\"" },
      { form: "ends \"<words>\"", says: "What the log says as it lifts.", example: "ends \"The sunlight fades.\"" },
      { form: "while standing:", says: "What it does to the side under it.", example: "while standing:" },
    ],
  },
  {
    label: "Blocks",
    in: CARRIED,
    lines: [
      { form: "while carried:", says: "Standing effects, for as long as it is there.", example: "while carried:" },
      { form: "grows <n> <art>", says: "Art growing out of the holder, that many pieces a stack.", example: "grows 6 randomcoral" },
      { form: "cuts the next hit by <share>", says: "Takes that share off the next damage it takes, for a charge.", example: "cuts the next hit by 50%" },
      { form: "when <trigger>:", says: "Steps that run when the trigger happens.", example: "when a turn ends:" },
    ],
  },
  {
    label: "Triggers",
    in: CARRIED,
    lines: [
      { form: "the battle starts", says: "Once as the battle opens, bench included.", example: "when the battle starts:" },
      { form: "it takes the field", says: "The holder is sent out or walks on.", example: "when it takes the field:" },
      { form: "a turn starts", says: "The start of every turn, on the field.", example: "when a turn starts:" },
      { form: "a turn ends", says: "The end of every turn, after mana comes back.", example: "when a turn ends:" },
      { form: "it makes a basic attack", says: "other is who it swung at.", example: "when it makes a basic attack:" },
      { form: "it casts", says: "other is the first Scoba aimed at.", example: "when it casts:" },
      { form: "it blocks", says: "The holder blocks.", example: "when it blocks:" },
      { form: "hit", says: "An attack lands on the holder. other is the attacker.", example: "when hit:" },
      { form: "hit by magic | physical | <element>", says: "The same, for one kind of damage.", example: "when hit by sun:" },
      { form: "it lands a hit", says: "The holder's attack lands. other is who it struck.", example: "when it lands a hit:" },
      { form: "it lands magic | physical | a spell", says: "The same, for one kind of hit.", example: "when it lands magic:" },
      { form: "it kills", says: "The holder's attack makes a Scoba faint.", example: "when it kills:" },
      { form: "it faints", says: "The holder faints. other is the killer.", example: "when it faints:" },
      { form: "an ally faints | an enemy faints | anyone faints", says: "Someone on that side faints, or on either side.", example: "when anyone faints:" },
      { form: "below <n>% hp", says: "Damage leaves the holder at or under that share.", example: "when below 50% hp:" },
    ],
  },
  {
    label: "Who",
    in: STEPPED,
    lines: [
      { form: "caster", says: "In a move: the Scoba casting it.", example: "caster" },
      { form: "target, target2, or an aim name", says: "In a move: everyone that aim group resolved to.", example: "target" },
      { form: "holder", says: "In a status or passive: the Scoba carrying it.", example: "holder" },
      { form: "source", says: "In a status: whoever left it.", example: "source" },
      { form: "other", says: "In a status: the far side of the trigger.", example: "other" },
      { form: "allies | enemies | everyone | others", says: "Whole teams, bench included, standing only.", example: "enemies" },
    ],
  },
  {
    label: "Damage and healing",
    in: STEPPED,
    lines: [
      { form: "hit <who> <n>% <stat> + <n>% <stat>", says: "An attack through the chart and armor. First stat sets physical or magic.", example: "hit target 120% strength" },
      { form: "hit <who> <n>% <stat> + <n> at max level", says: "A flat amount on top of the shares, scaled by the attacker's level.", example: "hit target 8% magic + 8 at max level" },
      { form: "hit <who> ..., per stack of <status>", says: "Counts the hit once per stack the target carries, and skips anyone carrying none.", example: "hit target 8% magic, per stack of coraled" },
      { form: "hit <who> <n> per level", says: "A flat amount per level of the attacker in place of the shares.", example: "hit target 2 per level" },
      { form: "hit ..., as <element> <physical|magic>, sound <name>", says: "Options on a hit.", example: "hit target 100% magic, as sun magic" },
      { form: "damage <who> <share>, as <element> <physical|magic|true>", says: "A set amount, no chart, no same-type bonus, no armor.", example: "damage holder 15% of source magic, as sun magic, fixed when applied" },
      { form: "damage ..., counts as attack | sets off hits | fixed when applied", says: "Options on damage.", example: "damage holder 10% of their max hp, as true, counts as attack" },
      { form: "heal <who> <share>, sound <name>", says: "Restores HP up to the bar.", example: "heal target 50% of their max hp" },
      { form: "take <n>% hp from <who>, deal it to <who>", says: "Takes HP from some and deals it to others.", example: "take 25% hp from target, deal it to target2" },
      { form: "take <n>% hp from <who>, heal <who> with it", says: "The same, split as healing.", example: "take 20% hp from target, heal target2 with it" },
    ],
  },
  {
    label: "Shares",
    in: STEPPED,
    lines: [
      { form: "<n>% of caster strength | magic | max hp", says: "In a move: read off the caster.", example: "50% of caster magic" },
      { form: "<n>% of source strength | magic | max hp", says: "In a status: read off whoever left it.", example: "15% of source magic" },
      { form: "<n>% of their strength | magic | max hp | hp", says: "Read off the Scoba the step lands on.", example: "10% of their max hp" },
    ],
  },
  {
    label: "Statuses and fields",
    in: STEPPED,
    lines: [
      { form: "inflict <status> on <who>, for <n> turns", says: "Lands a status on each Scoba.", example: "inflict fire on target" },
      { form: "clear <status> from <who>", says: "Takes one named status off, however many stacks it holds.", example: "clear coraled from target" },
      { form: "cleanse <good|bad> marks from <who>", says: "Takes every status of one half off.", example: "cleanse bad marks from target" },
      { form: "copy marks from <who> to <who>", says: "Copies every status from the first to each of the second.", example: "copy marks from target to target2" },
      { form: "lay <field> over <its side|the enemy side|both sides>", says: "Lays a field, taking the old one off.", example: "lay sunblessed over both sides" },
      { form: "raise <who> as a pawn at <share> level, as <element> <element>", says: "Puts a fallen Scoba back as a Pawn of the caster's side. The steps after it reach it as \"raised\".", example: "raise target as a pawn at 75% level, as moon flux" },
    ],
  },
  {
    label: "Other steps",
    in: STEPPED,
    lines: [
      { form: "summon <species> at level <n>", says: "Calls a Scoba to the side of the one running it.", example: "summon catsquito at level 5" },
      { form: "find <n> <item>", says: "Gives the side that many of an item.", example: "find 1 snare" },
      { form: "give <who> <n> mana", says: "Adds mana, up to 100.", example: "give holder 10 mana" },
      { form: "if <who> fell:", says: "Runs the steps under it only if one of them fainted.", example: "if target fell:" },
      { form: "refund", says: "Puts the mana back and clears the cooldown. Moves only.", example: "refund" },
      { form: "say \"<words>\"", says: "A line in the log. {self}, {target} and {picked} are filled in.", example: "say \"{self} shrugs it off.\"" },
    ],
  },
  {
    label: "Cards",
    in: STEPPED,
    lines: [
      { form: "draw a card, swap <color> for <color> <n>% of the time", says: "Draws the card the next steps use.", example: "draw a card, swap #bc0006 for #000000 50% of the time" },
      { form: "throw drawn card as <path> to <who>", says: "Throws the drawn card.", example: "throw drawn card as toss to target" },
      { form: "deal drawn card to <who>, hand <status>, 21 pays <n>% strength", says: "Adds its value to a hand.", example: "deal drawn card to target, hand dealt, 21 pays 230% strength" },
    ],
  },
  {
    label: "Picking a move",
    in: STEPPED,
    lines: [
      { form: "pick a random move, costing at least <n>, skip once per battle", says: "Picks a move out of the whole game.", example: "pick a random move, skip once per battle" },
      { form: "change picked move:", says: "Rewrites it. Under it: set type, set damage, scale off, tint, set cost, set name.", example: "change picked move:\n  set type fortuna\n  set damage physical\n  scale off strength\n  tint #e8c46a\n  set name \"Golden {name}\"\n  set cost x0.5" },
      { form: "give <who> picked move as extra | in slot <n>", says: "Hands the picked move over for the battle.", example: "give holder picked move as extra" },
    ],
  },
  {
    label: "Art and sound",
    in: STEPPED,
    lines: [
      { form: "<who> shake | lunge | blink | rear | focus", says: "Plays an animation.", example: "caster lunge" },
      { form: "<who> wears <costume>", says: "Puts a Scoba in a costume for the battle.", example: "caster wears cherryless" },
      { form: "throw <art> as <path> from <piece> to <who>, sound <name> | silent", says: "Throws art. Paths: bolt, lob, toss, drop, beam, burst, flames, glow.", example: "throw as bolt to target" },
      { form: "show <art> as <wheel|glow|burst|flames> on <who>, pointer <art>", says: "Shows art in place.", example: "show spin as wheel over holder, pointer spintop" },
      { form: "sound <name>", says: "Plays a sound. confirm, tap, back and summon are built in.", example: "sound confirm" },
      { form: "wait <n> seconds", says: "Holds the scene.", example: "wait 0.3 seconds" },
    ],
  },
  {
    label: "Standing effects",
    in: CARRIED,
    lines: [
      { form: "<stat> x<n>", says: "Multiplies the stat. Stacks multiply together.", example: "strength x1.25" },
      { form: "<stat> +<n> | -<n>", says: "Adds before any multiplier.", example: "defense +10" },
      { form: "<stat> +<n> after scaling", says: "Adds after every multiplier.", example: "speed +5 after scaling" },
      { form: "<stat> = <n>", says: "Sets the stat outright.", example: "speed = 1" },
      { form: "<stat> + <n>% of <stat>", says: "Adds a share of another stat.", example: "speed + 10% of magic" },
      { form: "<stat> + <n>% of base + <n>", says: "A share of the stat as it stood when the status landed, plus a flat amount.", example: "all stats + 25% of base + 15" },
      { form: "<stat> - power | + power | - <n>% power", says: "Moves the stat by the status's power.", example: "speed - power" },
      { form: "all stats <change>", says: "The same change to all six stats.", example: "all stats +3" },
      { form: "<element> moves x<n>", says: "The holder's attacks of that element.", example: "sun moves x1.25" },
      { form: "immune to <element>", says: "That element does nothing to the holder.", example: "immune to moon" },
      { form: "takes x<n> from <element>", says: "Damage of that element is multiplied.", example: "takes x1.5 from cipher" },
      { form: "blocks <element> hits", says: "Stops the next hit of that element and spends a charge.", example: "blocks sun hits" },
      { form: "cannot switch out", says: "The holder cannot be called back.", example: "cannot switch out" },
      { form: "marks it leaves hit x<n> if they last <n> turns or more", says: "Marks the holder leaves measure their power that many times.", example: "marks it leaves hit x1.3 if they last 2 turns or more" },
    ],
  },
  {
    label: "Field effects",
    in: ["fields"],
    lines: [
      { form: "<element> moves x<n>", says: "That element's attacks from the side under it.", example: "sun moves x1.25" },
      { form: "immune to <element>", says: "That element does nothing to the side under it.", example: "immune to moon" },
      { form: "takes x<n> from <element>", says: "Damage of that element to that side is multiplied.", example: "takes x1.5 from cipher" },
    ],
  },
];

/** The groups that belong in a record of this kind. */
export const referenceFor = (file: ScriptFile): RefGroup[] => REFERENCE.filter((g) => g.in.includes(file));

/**
 * Where a picked line goes into a box: on a line of its own after the caret's
 * line, at that line's indent. A line that opens a block puts the caret one
 * level under it. Returns the new text and where the caret should land.
 */
export function insertLine(text: string, caret: number, line: string): { text: string; caret: number } {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const lineEndAt = text.indexOf("\n", caret);
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
  const current = text.slice(lineStart, lineEnd);
  const indent = /^\s*/.exec(current)?.[0] ?? "";
  // Under a line that opens a block, a step sits one level in.
  const pad = current.trim().endsWith(":") ? `${indent}  ` : indent;
  const body = line.split("\n").map((l) => `${pad}${l}`).join("\n");
  const empty = current.trim() === "";
  const before = empty ? text.slice(0, lineStart) : `${text.slice(0, lineEnd)}\n`;
  const after = empty ? text.slice(lineEnd) : text.slice(lineEnd);
  const out = `${before}${body}${after}`;
  return { text: out, caret: before.length + body.length };
}

// --- who uses what ---

/** Every line that learns a move, or rolls or carries a passive. */
export function linesUsing(kind: ScriptFile | "species", id: string): Species[] {
  if (kind === "species") return [];
  const all = Object.values(SPECIES);
  if (kind === "moves") return all.filter((sp) => sp.moves.includes(id));
  if (kind === "passives") {
    return all.filter((sp) => sp.primaryAbility === id || sp.secondaryPool.includes(id) || sp.hyperAbility === id);
  }
  // A status or a field is reached through the records that leave it.
  const through = new Set<string>();
  for (const r of recordsUsing(kind, id)) {
    for (const sp of linesUsing(r.kind, r.id)) through.add(sp.id);
  }
  return all.filter((sp) => through.has(sp.id));
}

/** Every move, passive or status whose steps name a status or a field. */
export function recordsUsing(kind: ScriptFile, id: string): { kind: ScriptFile; id: string; name: string }[] {
  const out: { kind: ScriptFile; id: string; name: string }[] = [];
  const names = (steps: Step[]): boolean => allSteps(steps).some((s) =>
    (kind === "statuses" && ((s.kind === "inflict" && s.status === id) || (s.kind === "deal-card" && s.hand === id)))
    || (kind === "fields" && s.kind === "field" && s.field === id));
  if (kind === "moves") {
    for (const a of Object.values(ABILITIES)) if (a.grantsMove === id) out.push({ kind: "passives", id: a.id, name: a.name });
    return out;
  }
  if (kind === "passives") return out;
  for (const m of Object.values(MOVES)) {
    if (!m.derived && names(m.cast)) out.push({ kind: "moves", id: m.id, name: m.name });
  }
  for (const s of Object.values(STATUSES)) {
    if (s.id.includes("@")) continue;
    if (names(s.effects.filter((e): e is Step => !isContinuous(e.kind)))) {
      out.push({ kind: ABILITIES[s.id] ? "passives" : "statuses", id: s.id, name: s.name });
    }
  }
  return out;
}

// --- a new line ---

export interface NewSpecies {
  name: string;
  id: string;
  type: ElementType;
  type2?: ElementType;
  genes: Stats;
  art: string;
  movement: MovementStyle;
  primaryAbility: string;
  secondaryPool: string[];
  hyperAbility?: string;
  moves: string[];
  blurb?: string;
  starter?: boolean;
  baby?: boolean;
  evolvesTo?: string;
}

/** A line's record as `species.json` holds it, with the optional keys left out where they are empty. */
export function speciesRecord(n: NewSpecies): Species {
  const sp: Species = {
    id: n.id,
    name: n.name,
    type: n.type,
    ...(n.type2 && n.type2 !== n.type ? { type2: n.type2 } : {}),
    genes: { ...n.genes },
    primaryAbility: n.primaryAbility,
    secondaryPool: [...n.secondaryPool],
    moves: [...n.moves],
    sprite: { kind: "art", art: n.art },
    movement: n.movement,
  };
  if (n.baby) sp.baby = true;
  if (n.evolvesTo) sp.evolvesTo = n.evolvesTo;
  if (n.hyperAbility && !n.baby) sp.hyperAbility = n.hyperAbility;
  if (n.blurb?.trim()) sp.blurb = n.blurb.trim();
  if (n.starter) sp.starter = true;
  return sp;
}

/** What a new line starts as before anything is filled in. */
export function blankSpecies(): NewSpecies {
  return {
    name: "", id: "", type: TYPES[0], genes: { ...BASE_GENES }, art: "", movement: "scamper",
    primaryAbility: "", secondaryPool: [], moves: [],
  };
}

/** The art names in `assets/Scobas` no line has claimed. */
export function unclaimedArt(artNames: readonly string[]): string[] {
  const claimed = new Set<string>();
  for (const sp of Object.values(SPECIES)) {
    if (sp.sprite.kind !== "art") continue;
    claimed.add(sp.sprite.art);
    for (const f of Object.values(sp.sprite.forms ?? {})) claimed.add(f);
  }
  return artNames.filter((a) => !claimed.has(a)).sort();
}
