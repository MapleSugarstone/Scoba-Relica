# Move script

Move script is the plain-text language every move, status, passive and field in
Scoba Relica is written in. A record says what it is, and then lists what happens
in the order it happens: what the caster does, what is thrown, what is heard, and
what changes in the battle. The game runs those steps in that order, and the
battle scene plays them back in that order.

This document covers every line the language accepts. If a line is not described
here, the game does not read it.

## Where the files are

The four script files live in `src/sim/content`:

| File | Holds |
| --- | --- |
| `moves.txt` | Every move a Scoba can cast. |
| `statuses.txt` | Every status a move or a passive can leave on a Scoba. |
| `passives.txt` | Every passive, with what it does written inside it. |
| `fields.txt` | Every field that can be laid over a side of the battle. |
| `hobbies.txt` | Every hobby a Scoba can take up, and what it does to its stats. |

The Scoba lines themselves (stats, which four moves they know, which passives
they roll) stay in `src/sim/content/species.json`, which is plain JSON and is
not move script.

The game reads all four files as it loads. You can edit them in any text editor,
or in the cosmetics editor (`npm run cosmetics`, or F3 in a dev build), which
shows every record the Scoba on screen depends on under **Data**, checks each one
as you type, and writes the files back when you press Save. In the editor's boxes,
Tab indents by two spaces and Shift+Tab takes two off, on every line a selection
touches. Press Escape and then Tab to move out of a box.

The editor also writes new records. **+ Move**, **+ Passive**, **+ Status** and
**+ Field** under **Data** open a builder that starts from a template, lists
every line this document describes in a palette beside the box, puts an example
in at the caret when you click one, checks the record as you type, and shows the
sentence the game would build from it. A new move or passive can be handed to
the Scoba on screen as it is filed. Under **Kit**, a line's passives and its four
moves are picked out of the shared tables by search, and **+ New** beside a slot
opens the builder bound for that slot. The form for a new Scoba offers the same.
A record is one record however many lines use it, and its box says which lines
those are.

## How a file is laid out

A file is a list of records. Each record starts at the left edge with its kind,
its id and its name in double quotes, and everything indented under that header
belongs to it.

```
move crush "Crush"
  type plain
  costs 30 mana
  aim any enemy
  cast:
    caster lunge
    hit target 110% strength
```

These rules hold everywhere in every file:

1. A record's header is its kind (`move`, `status`, `passive` or `field`), its id and its name, and it starts at the left edge.
2. Every file holds one kind of record, so `moves.txt` holds only `move` records.
3. An id is lower-case letters, digits and dashes, like `cold-wave`, and it is how every other record names this one.
4. A name is the text a player sees, written in double quotes.
5. A line that ends in a colon opens a block, and the lines indented under it belong to that block.
6. A line that does not end in a colon can still have lines indented under it, and each of those lines is one more option for it, exactly as if it had been written after a comma.
7. A comma separates a step from its options, as in `throw coldwave as bolt to target, sound coldwave`.
8. A line that starts with `#` is a note for people, and the game skips it.
9. Indentation is spaces. A tab counts as two spaces. Two spaces per level is the convention the shipped files use.
10. Words the language knows ignore case, so `Hit` and `hit` are the same word.
11. Text in double quotes is taken exactly as written. Write `\"` for a quote inside it and `\\` for a backslash.
12. A percentage is a number followed by `%`, and `110%` means 1.1 times.
13. A multiplier is `x` followed by a number, and `x1.25` means 1.25 times.
14. A color is `#` and six hex digits, like `#e7a03c`.
15. Art, sound, icon and costume names are file names without their extension. Write a name with a space in it in double quotes, like `"tantalizing sweet"`.
16. A number that counts something is never negative. A cost, a cooldown, a level, a count of turns, charges, stacks, seconds or mana all start at nothing.
17. A count of one is written in the singular, as in `lasts 1 turn` and `wait 1 second`.

These two ways of writing a step are the same step:

```
pick a random move, costing at least 80, skip once per battle
```

```
pick a random move
  costing at least 80
  skip once per battle
```

## Moves

A move is a header, the lines that describe it, and a `cast:` block.

```
move cold-wave "Cold Wave"
  type moon, sugar
  costs 70 mana
  cooldown 3
  aim all enemies "The whole line"
  text "Washes over the whole enemy line at once. Deals [damage] damage to each of them, and [status:cold|chills] them."
  cast:
    caster focus
    throw coldwave as bolt to target, sound coldwave
    hit target 100% magic
    inflict cold on target
```

| Line | Required | What it does |
| --- | --- | --- |
| `type <element>` or `type <element>, <element>` | Yes | The move's element, and an optional second one. Both are read against the type chart and both grant the same-type bonus. |
| `costs <n> mana` | Yes | What casting it takes out of the caster's mana bar. |
| `cooldown <n>` | No | Turns it waits after being cast before it can be cast again. Leave it out for none. |
| `starts on cooldown <n>` | No | Turns it waits at the start of a battle. Leave it out for none. |
| `priority <n>` | No | A move with a higher priority resolves ahead of every move with a lower one, whatever either caster's Speed. Leave it out for 0. |
| `once per battle` | No | It can be cast once a battle. |
| `looks ahead` | No | It is cast before anything else in the round, and then its caster picks an action that takes its place. See [Looking ahead](#looking-ahead). |
| `aim <mode>` | Yes, at least one | Who it asks you to aim at. Write one `aim` line per target group. See [Aiming](#aiming). |
| `text "<words>"` | No | The line a player reads. See [Written text](#written-text). A move with none shows a sentence the game builds from its steps. |
| `cast:` | Yes | The steps casting it runs, in order. See [Steps](#steps). |

The mana bar opens at 40, gains 20 at the end of every turn and holds 100, so a
move that costs more than 100 can never be cast.

The game works out a move's kind from its steps, for anything that sorts moves
instead of casting them, such as the enemy AI and the move list. The first `hit`
or `heal` step decides it, wherever it is written, an `if` block included: a
`hit` makes it physical or magical, a `heal` makes it a heal, and a move with
neither is a utility move.

A cost shown to a player can be higher than the `costs` line. A Scoba casting a
move its own line does not learn pays a surcharge, except for a move a passive
grants or a move a step handed over during the battle.

### Aiming

Each `aim` line is one group of targets. The player picks a target for each group
that needs a pick, in order, before the move goes off.

| Mode | Who it reaches | Asks the player |
| --- | --- | --- |
| `self` | The caster. | No |
| `any ally` | One ally on the field, the caster included. | Yes |
| `other ally` | One ally on the field other than the caster. | Yes |
| `any enemy` | One enemy on the field. | Yes |
| `any scoba` | Anyone on the field, on either side. | Yes |
| `benched ally` | One ally on the bench. | Yes |
| `benched enemy` | One enemy on the bench. | Yes |
| `fallen scoba` | One Scoba that has fainted, on either side, bench included. A Pawn that fell is gone rather than lying there. | Yes |
| `all allies` | Every ally on the field. | No |
| `all enemies` | Every enemy on the field. | No |
| `random ally` | One ally on the field, rolled when the move resolves. | No |
| `random enemy` | One enemy on the field, rolled when the move resolves. | No |
| `random scoba` | Anyone on the field, rolled when the move resolves. | No |

After the mode you can write a prompt in double quotes, which the picker shows
while that group is being chosen.

A pick is aimed at a mark rather than at a body. Switching happens ahead of
every action in the round, so a Scoba aimed at can be on the bench by the time
the move reaches it, and the move lands on whoever took its mark. A Scoba that
fell is not replaced until the round is over, so a move aimed at one that fell
finds nobody, and a pick aimed at the bench is left where it was pointed.

Steps name the groups. The first group is `target`, the second is `target2`, the
third is `target3`, and so on. Write `as <name>` at the end of an `aim` line to
give a group a name of your own:

```
move blood-pact "Blood Pact"
  type mystic
  costs 40 mana
  cooldown 3
  starts on cooldown 1
  aim other ally "Draw from" as donor
  aim all enemies "Spend it on" as foes
  cast:
    caster rear
    take 25% hp from donor, deal it to foes
```

A group's name cannot be `caster`, `allies`, `enemies`, `everyone` or `others`,
since those already mean something in a step.

### Looking ahead

A move with a `looks ahead` line is cast before the round is ordered and before
anything else in the round happens. It is the caster's whole round until it is
answered: the player is shown the round as it would go with that Scoba standing
still, and then picks an action, which takes the move's place in the round and
is paid for as usual. A caster nobody is there to answer for braces.

```
move crystal-ball "Crystal Ball"
  type mystic
  costs 60 mana
  cooldown 5
  looks ahead
  aim self
  cast:
    caster focus
    show crystalball as glow on caster
```

The steps still run, ahead of the question, so the move keeps whatever it is
drawn and heard as. Nothing looks ahead twice in one round: an action picked
this way is a plain action, even where the move behind it looks ahead.

## Statuses

A status is something that sits on one Scoba and is shown as one sigil in the row
under its card. It has standing effects, which apply for as long as it is there,
and it can have steps that run when something happens.

```
status fire "Fire"
  bad
  icon firework
  lasts 3 turns
  stacks
  when a turn ends:
    damage holder 15% of source magic, as firework magic, fixed when applied
```

```
status slowed "Slowed"
  bad
  icon boot
  stacks up to 6
  lost on switching out
  power 30% of source magic
  while carried:
    speed - power
```

| Line | Required | What it does |
| --- | --- | --- |
| `good` or `bad` | Yes | Which half of a cleanse removes it. |
| `text "<words>"` | No | The line a player reads. With none, the game builds a sentence from what the status does, which is enough for all but a mark that only says something else is coming. |
| `icon <name>` | No | The sigil it is shown as, by file name in `assets/Sigils`. With none, or with a name that has no file, it shows the placeholder sigil. |
| `lit <color>` | No | The colour its holder's line art is drawn in while it carries the status, in place of the black every drawing is outlined in. It is how a status shows on the Scoba itself rather than only on its card. |
| `planted <art>` | No | Art drawn on the mark it is planted under, by file name in `assets/Powers`. A status with this line is a patch of ground rather than something a Scoba carries. See [`plant`](#statuses-and-fields). |
| `sound <name>` | No | A sound that plays as it lands, by file name in `assets/Sounds`. |
| `lasts <n> turns` | No | How many turns it stands. Leave it out and it stands until something takes it off. |
| `charges <n>` | No | How many times it can go off: its `when` steps running is one, and a `blocks <element> hits` effect catching a hit is one. When the charges run out, it is gone. Leave it out for no limit. |
| `stacks` or `stacks up to <n>` | No | Landing it again adds another stack instead of refreshing it. `stacks` alone allows 99. Leave it out and landing it again refreshes the one already there. |
| `lost on switching out` | No | It comes off when its holder is called back. Leave it out and it stays through a switch. |
| `spends a stack` | No | One stack answers a trigger rather than every stack answering it, and that stack is gone once it has. What it stacks up to is how many times it can answer before it is spent. |
| `shows a hand of cards` | No | Its stack count is a hand of cards, with the last card dealt drawn over the holder's head. `deal drawn card` uses a status like this. |
| `no sigil` | No | It is never shown in the sigil row. Hyper-Mode takes this line, since the Scoba's drawing already shows it. |
| `always as written` | No | Nothing makes it more or less effective: a `marks ... hit` effect passes it by. Hyper-Mode and EZ mode take this line. |
| `grows <n> <art>` | No | Art that grows out of the holder behind its body, by file name in `assets/Powers`. Each stack grows `<n>` pieces, or one where the number is left out. A name with numbered files beside it (`randomcoral1`, `randomcoral2`) draws one of them per piece. Each piece leans away from the middle of the body, so one on a flank sticks out sideways and one on the crown stands up. |
| `power <share>` | No | A number measured once, as the status lands, and kept on it. A standing `power` effect moves a stat by it. See [Shares](#shares). Write `+ <n> at max level` after the share to add a flat amount scaled by the source's level, or write `power <n> at max level` for the flat amount alone. A status keeps one measured number, so a status with a `power` line cannot also hold a damage step marked `fixed when applied`. |
| `while carried:` | No | Its standing effects. See [Standing effects](#standing-effects). |
| `when <trigger>:` | No | The steps it runs when the trigger happens. See [Triggers](#triggers) and [Steps](#steps). A status can have several, each answering its own trigger. |

### How a status lands

A status lands from a move's `inflict` step, a status's `inflict` step, or a
`deal a card` step.

1. A status that does not stack refreshes the one already there: its turns, its charges and its power are all put back to what a fresh one would have.
2. A status that stacks adds a stack until it reaches its limit. At the limit, landing it again only tops up its turns.
3. A status that lands this turn does not count down this turn, and its `when a turn starts` and `when a turn ends` steps wait for the next turn. Every other trigger it answers straight away.
4. A status measures one number off whoever left it at the moment it lands: its `power`, or the damage of a step marked `fixed when applied`. It takes one or the other, and the game refuses a status that asks for both.
5. A status with `lasts` counts down at the end of every turn after the one it landed on, and comes off when it reaches zero.
6. A status that raises the holder's HP keeps the share of it the holder had, the way Hyper-Mode does, so a Scoba at half HP is still at half HP once its maximum has grown.

### One sigil, one effect

Write each lasting change as its own status. A move that drops a target's Speed
and its Defense should leave two statuses, so a player can read each one on its
own sigil and so removing one sigil removes exactly that one change. Standing
effects are read off the statuses a Scoba is carrying every time a number is
needed, so a change is gone the moment its status is.

Damage and healing are the exception. A `damage` or `heal` step changes HP when it
runs and leaves nothing behind, so a burn is one status that deals damage each
turn, and there is never a status that stands for HP already lost.

## Passives

A passive is carried as a status with the same id, hung on the Scoba as a battle
opens. That status is always good, stands for the whole battle, stays through a
switch, and is never cleansed or copied.

A passive is read in the sigil row like any other mark while it has something
left to do: a `while carried:` block, a `when` block that can go off again, or
only an `icon` line, such as Cherry on Top, which hands over a move. One that
only acts as the Scoba enters (`when it takes the field:` or
`when the battle starts:` and nothing else, or only a `fuses with` line) does
its work and has nothing more to show, so it stays off the row. Give every
passive that shows a sigil of its own with an `icon` line: one without shows
the placeholder, which says a mark is there but not which.

```
passive roll-the-wheel "Roll the Wheel"
  text "Every time it takes the field, the wheel hands it one more spell out of the whole game, rewritten as Fortuna off Strength."
  when it takes the field:
    sound confirm
    show spin as wheel over holder, pointer spintop
    pick a random move, skip once per battle
    change picked move:
      set type fortuna
      set damage physical
      scale off strength
      tint #e8c46a
      set name "Golden {name}"
    give holder picked move as extra
    say "The wheel comes up {picked}."
```

| Line | Required | What it does |
| --- | --- | --- |
| `text "<words>"` | No | The line a player reads. With none, the game builds a sentence from what the passive does. |
| `icon <name>` | No | The sigil it shows in the row, from `assets/Sigils`. A passive with an `icon` line is always carried as a status, so it shows even with nothing else in it. One that only acts on entry is never shown there. |
| `wears <name>` | No | Art worn over a Scoba that inherited this passive from another line, by file name in `assets/AccessoryScoba`. A line with the passive in its own pool already has it drawn in and wears nothing. In a fight the art goes with the status: a fusion wears it when either half brought the passive, and clearing the status takes the art off. |
| `grants move <move>` | No | A move the Scoba can cast without holding it in a slot. It is offered after the four it knows and costs what the move says. |
| `fuses with <status> into <species>` | No | Fuses the Scoba with an ally Scoba carrying the named status or passive into one Scoba of the named species. See [Fusions](#fusions). |
| `basic attack is <move>` | No | The Scoba's basic attack becomes that move, cast for nothing and aimed the way the move's `aim` lines say. It is still a basic attack: it sets off `when it makes a basic attack:`, its hits are not a spell, and nothing echoes it. Where two passives both change it, the one the Scoba gained last wins, so a Hyper-Mode passive can change a basic attack its primary already changed. |
| `once per battle` | No | It goes off once a battle. The same as `charges 1`, and a passive takes one of the two lines rather than both. |
| `charges <n>` | No | How many times it can go off in a battle. |
| `while carried:` | No | Its standing effects. See [Standing effects](#standing-effects). |
| `when <trigger>:` | No | The steps it runs when the trigger happens. A passive can have several, each answering its own trigger, so one can act on entry and on something else as well. |

A passive with none of `while carried:`, `when`, `fuses with`,
`basic attack is` or `icon` is carried as no status at all. It shows no sigil,
and a fusion does not inherit it.

A passive can be bred onto another line, so write the secondary passives of a
line so they still make sense on a Scoba that is not this one.

### Fusions

A passive with a `fuses with <status> into <species>` line fuses the Scoba
carrying it with the ally Scoba on the other Scoba mark, where that ally carries
the named status, into one Scoba of the named species. The status can be a
passive or any status at all. Both have to be in Hyper-Mode, and neither can
already be part of a fusion, a Pawn or a visitor from another time. It is tried
whenever the Scoba carrying the line takes the field, which entering Hyper-Mode
counts as, before anything else it does on arriving.

Addiza and Poki each gain a mark on entering Hyper-Mode and fuse with an ally
carrying the other's, so whichever of the two goes Hyper second fuses them:

```
passive flame-blade "Flame Blade"
  fuses with ultimate-addition into equalizea
  when it lands firework physical:
    inflict seared on other
  when it takes the field:
    inflict ultimate-multiplication on holder
```

The fusion stands on a mark of its own between the two Scoba marks:

1. Its HP is two bars, each the HP one of the two had. Damage empties the first slot's bar first, and a hit that empties it stops there without reaching the second bar. It falls once both are empty, and both Scobas fall with it.
2. It picks two moves a round, one from each Scoba's own moves, paid for from that Scoba's own mana bar. Each player picks for the Scoba they brought, and each move goes at that Scoba's own Speed.
3. Its level is both levels added together, so anything scaled by level grows with it.
4. Its other stats are both Scobas' stats added together and cut by a quarter, with Hyper-Mode in. It fights as every element either had.
5. It carries every passive and every status either had, and its own species' passive on top. A status that does not stack is kept once. The statuses its `fuses with` lines name are dropped, and nothing can give them back to it.
6. It cannot block and cannot be switched out, and neither Scoba mark takes anyone else until it falls.
7. It gains the turn's mana in its first bar only. Its second bar fills through whatever gives it mana, such as a passive with `give holder 20 mana, second bar`.
8. It is painted in both Scobas' colors: a father's colors or a shiny's turn on either of them carries over to the half of the fusion drawn in that Scoba's colors.

A species meant only to be fused into sets `fusion` true in `species.json`. It
takes its art and its passive from its own entry, and everything else from the
two it was made of, so it needs no moves and spends no stat budget.

## Hobbies

A hobby is what a Scoba does with its time. Every Scoba has exactly one, it is
rolled when the Scoba is, and it changes only at the hut. It is part of the
Scoba rather than something it is carrying, so it counts in a battle and out of
one, nothing can take it off, and it never shows as a mark.

```
hobby crochet "Crochet"
  doing "Crocheting"
  text "A creative act of weaving yarn with a hook. It is a powerful hobby, often underestimated."
  while carried:
    strength x1.5
    defense x0.75
```

| Line | Required | What it does |
| --- | --- | --- |
| `doing "<words>"` | Yes | What the Scoba is doing, for its own card: "Crocheting". |
| `text "<words>"` | Yes | The line the hut reads out when it is offered. |
| `while carried:` | No | What it does to the stat line. See [Standing effects](#standing-effects). A hobby with none, like Unmotivated, changes nothing. |

A hobby only ever changes stats: it takes no `when` block and leaves no mark.
The shipped ones never touch HP, which is what keeps them a choice about how a
Scoba fights rather than about how long it lives.

A hobby's changes are folded in before a Scoba's passives and before any tea it
has drunk, so a hobby multiplies the line the species and the level gave it and
nothing else multiplies what a hobby gave.

## Fields

A field stands over a whole side of the battle instead of on one Scoba. A side
has one field at a time, and laying a new one takes the old one off. Nobody
carries a field, so it cannot be cleansed and it survives every switch and faint.

```
field sunblessed "Sunblessed"
  icon firework
  lasts 5 turns
  tint #e7a03c
  begins "Sunlight pours over the field."
  ends "The sunlight fades."
  while standing:
    firework moves x1.25
```

| Line | Required | What it does |
| --- | --- | --- |
| `icon <name>` | No | The sigil it is shown as, by file name in `assets/Sigils`. |
| `lasts <n> turns` | No | How many turns it stands. Leave it out and it stands until another field replaces it. |
| `tint <color>` | Yes | The wash laid over that side of the screen, as a color like `#e7a03c`. |
| `begins "<words>"` | Yes | What the battle log says as it is laid. |
| `ends "<words>"` | Yes | What the battle log says as it lifts. |
| `while standing:` | No | What it does to the side under it. A field takes only `<element> moves x<n>`, `immune to <element>` and `takes x<n> from <element>`. |

## Who a step reaches

A step names who it reaches with one of these words. A move runs its steps as its
caster. A status or a passive runs its steps as the Scoba carrying it.

| Word | In a move | In a status or a passive |
| --- | --- | --- |
| `caster` | The Scoba casting the move. | Not used. |
| `holder` | Not used. | The Scoba carrying the status. |
| `target`, `target2`, or a name from `as` | Everyone that aim group resolved to. | Not used. |
| `source` | Not used. | Whoever left the status. Nobody left a passive, so in a passive it is the Scoba carrying it. |
| `other` | Not used. | Whoever was on the far side of the trigger: the attacker for `when hit`, the Scoba struck for `when it lands a hit`, the victim for `when it kills`, and the killer for `when it faints`. |
| `raised` | The Pawn a `raise` or `summon` step above it put on the field. Nobody, where no step put anyone there. | Not used. |
| `traveller` | The Scoba a `travel back` step above it left standing in another time. Nobody, where no journey is in progress. | Not used. |
| `allies` | Every Scoba on the caster's team that has not fainted, benched ones and the caster included. | The same, for the holder's team. |
| `enemies` | Every Scoba on the other team that has not fainted, benched ones included. | The same, for the holder's other team. |
| `everyone` | Every Scoba on both teams that has not fainted. | The same. |
| `others` | Everyone but the caster. | Everyone but the holder. |
| `allies on the field` | Every ally standing on the field, Pawns and the caster included. | The same, for the holder. |
| `enemies on the field` | Every enemy standing on the field, Pawns included. | The same, for the holder. |
| `ally scobas` | Every ally Scoba standing on the field, the caster included. No Pawn. | The same, for the holder. |
| `enemy scobas` | Every enemy Scoba standing on the field. No Pawn. | The same, for the holder. |
| `ally pawns` | Every ally Pawn standing on the field. No Scoba. | The same, for the holder. |
| `enemy pawns` | Every enemy Pawn standing on the field. No Scoba. | The same, for the holder. |
| `next ally scoba from <who>` | The first ally Scoba standing on the field, in mark order, that `<who>` does not reach. Nobody where there is none. | The same. `next ally scoba from holder` is the other ally Scoba. |
| `next enemy scoba from <who>` | The same, for an enemy Scoba. `next enemy scoba from target` is the other enemy Scoba, or the first enemy Scoba where the target was a Pawn. | The same. |
| `<who> or <who>` | Whoever the first reaches, or whoever the second reaches where the first reaches nobody standing, like `next enemy scoba from target or target`. | The same. |

"Ally" in a player's text means any ally, Pawns included, and "ally Scoba"
means Scobas only. The words here follow the same line: `allies on the field`
reaches Pawns and `ally scobas` does not.

## Shares

A share is a percentage of a number read off a Scoba. `damage`, `heal` and a
status's `power` line are written with one.

```
15% of source magic
10% of their max hp
50% of caster magic
```

| Whose | In a move | In a status or a passive |
| --- | --- | --- |
| `caster` | The caster. | Not used. |
| `source` | Not used. | Whoever left the status. In a passive it is the Scoba carrying it, so `10% of source magic` is the holder's own Magic. |
| `their` | The Scoba the step lands on. | The Scoba the step lands on. |

| Measure | Allowed with | What it reads |
| --- | --- | --- |
| `strength` | `caster`, `source`, `their` | Strength, with every standing effect folded in. |
| `magic` | `caster`, `source`, `their` | Magic, with every standing effect folded in. |
| `max hp` | `caster`, `source`, `their` | The size of the HP bar. |
| `hp` | `their` | The HP left right now. |

## Steps

Steps run one after another, in the order they are written, and the battle scene
plays each one back in that same order. A step that changes nothing in the battle,
such as `throw` or `sound`, still takes its turn in the order, which is how a
script decides what a player sees and hears and when.

### Movement, art and sound

These steps change only what is drawn and heard.

**`<who> <animation>`** plays an animation on a Scoba. It holds the scene for a
short beat before the next step, and the movement keeps playing while the next
step happens.

| Animation | What it looks like |
| --- | --- |
| `shake` | Rattles in place. |
| `lunge` | Steps at the target and back. |
| `blink` | Vanishes, appears over the target, rattles, and vanishes back. |
| `rear` | Rises and slams down. |
| `focus` | Holds still and gathers. |
| `dance` | Sways from side to side in little hops, turning to face the way it steps. It lasts 1.2 seconds unless it says how long. |

```
caster lunge
```

Write `, for <n> seconds` after it to stretch the animation to that long. The
next step then waits until the Scoba has reached what it is moving at, which for
a `blink` is the moment it appears over the target, and the rest of the
animation plays beside the steps after it. Follow it with a `wait` to hold the
scene until the animation is over.

```
caster blink, for 1 second
hit target 150% strength
wait 0.5 seconds
```

**`<who> wears <costume>`** puts a Scoba in a costume for the rest of the battle,
by the costume's tag in the line's `sprite.forms` in `species.json`. A costume is
worn only by a line that has art drawn for it. A Scoba wearing a piece from an
inherited passive takes the piece off when it wears the costume that passive's
granted move puts it in.

```
caster wears cherryless
```

**`throw [<art>] as <path> [from <piece>] to <who>`** throws art from the Scoba
running the step at each Scoba in `<who>`, all at once. The art is a file name in
`assets/Powers`, and it can be left out. Write `drawn card` in place of the art to
throw the card a `draw a card` step drew, as it was drawn. See
[Cards](#cards). The scene waits for the throw to land before the next step.

| Path | How it travels | Time in the air |
| --- | --- | --- |
| `bolt` | Straight at the target. | 0.15 seconds |
| `lob` | In an arc. | 0.2 seconds |
| `toss` | In a slow arc, turning as it goes. | 0.42 seconds |
| `drop` | Appears over the target and falls onto it. | 0.34 seconds |
| `beam` | A line drawn straight through, all at once. | None |
| `burst` | Bursts on the target with nothing thrown. It shows only when the step names art. | None |
| `flames` | The same as `burst`. | None |
| `glow` | The same as `burst`. | None |

These rules decide how a throw looks and sounds:

1. `from <piece>` throws from where a worn or drawn piece sits, such as `from cherry`. Without it, the throw leaves from the middle of the Scoba, or from wherever the cosmetics editor moved its throwing point.
1. A name with no file of its own and numbered files beside it throws one of them at random each time, so `throw grinkle as bolt to target` throws `Grinkle1`, `Grinkle2` or `Grinkle3`. The same goes for `show`.
1. `, off <who>` throws from the middle of the first Scoba `<who>` reaches instead, for something that bounces off one Scoba onto another. A bounce onto the Scoba it bounced off has nowhere to travel and is not thrown.
2. A throw at the Scoba throwing it has nowhere to travel, so nothing is thrown at it.
3. A throw that travels makes a throwing noise. Write `, sound <name>` to play a sound of your own instead, or `, silent` for no sound.
4. The thrown art and the blocks drawn without art take the move's element color, or the tint a rewrite gave the move.

```
throw cherry as lob from cherry to target
throw coldwave as bolt to target, sound coldwave
throw as beam to target
```

**`show <art> as <way> on <who>`** shows art in place on each Scoba in `<who>`.
You can write `over` instead of `on`, and the two mean the same thing.

| Way | What it looks like | How long the scene waits |
| --- | --- | --- |
| `wheel` | Spins over the Scoba's head and slows to a stop. Add `, pointer <art>` for art drawn still over it. | 0.9 seconds |
| `clock` | Appears over the Scoba's head and climbs as it fades. Add a `, pointer <art>` clause per hand that turns on it. | 1.3 seconds |
| `glow` | A halo on the Scoba. | 0.45 seconds |
| `burst` | A burst on the Scoba. | 0.3 seconds |
| `ghost` | Swells out past its own size and thins away with it, so it reads as something spreading from the Scoba rather than landing on it. | Nothing: it plays beside the steps after it |
| `flames` | Licking flames on the Scoba. | 0.45 seconds |
| `liftoff` | The Scoba fades into the art and it carries them off the top of the screen. | 1.1 seconds |
| `landing` | The art comes down out of the sky onto the Scoba's mark and leaves them standing there. | 1.0 seconds |
| `rise` | Starts somewhere about the Scoba and drifts up with a little sway as it fades. Each one starts somewhere else. | Nothing: it plays beside the steps after it |

Write `itself` as the art to show the Scoba's own drawing, as it stands and
facing the way it faces. A ghost of it starts at its own size rather than smaller,
so it reads as swelling out of the Scoba.

```
show musicnote as rise on caster
show itself as ghost on caster
```

A hand is drawn on the same sheet the face is and is left exactly where it was
drawn. It turns about the point it is fixed at, which the game reads off the art:
a hand drawn as a thin sliver turns about its foot, and anything squarer, like a
cross over a face, turns about its middle. Hands turn in the order they are
written, each one faster than the one above it, which is an hour hand, a minute
hand and a second hand written in that order.

A `ghost` holds the scene for nothing, unlike every other way of showing
something. It is the flourish on a blow rather than a beat of its own, so the
steps after it run while it is still spreading and the damage lands with it.

```
show spin as wheel over holder, pointer spintop
show cogworkzap as ghost on target
show undoclock as clock over target, pointer undohourhand, pointer undominutehand, pointer undosecondhand
```

**`sound <name>`** plays a sound, by file name in `assets/Sounds`. Four names are
tones the game makes itself: `confirm`, `tap`, `back` and `summon`.

```
sound confirm
```

**`flash <color> for <n> seconds`** washes the whole screen in that color and
fades it out. What happens behind it is over by the time it clears, which is
what it is for: a rewind or a journey changes the whole board at once, and the
flash is what the change happens behind.

```
flash #fff4dd for 0.5 seconds
```

**`wait <n> seconds`** holds the scene for that long before the next step.

```
wait 0.3 seconds
```

**`say "<words>"`** writes a line in the battle log. `{self}` is filled in with the
name of the Scoba running the step, `{target}` with the first Scoba the move is
aimed at or the far side of the trigger, and `{picked}` with the name of the
picked move.

```
say "The wheel comes up {picked}."
```

### Damage and healing

**`hit <who> <share> <stat> [+ <share> <stat> ...]`** is an attack. It reads
shares of the attacker's own stats, where the attacker is the Scoba running the
step, and adds them together.

```
hit target 110% strength
hit target 100% strength + 100% defense
```

An attack lands through these rules, in order:

1. The shares of the attacker's stats are added up. The stats can be `hp`, `strength`, `defense`, `resistance`, `magic` and `speed`.
2. An attacker that shares an element with the attack deals 1.5 times as much.
3. The type chart multiplies it for each element of the attack against each element of the target.
4. Every element power the attacker is carrying, and the field over the attacker's side, multiplies it.
5. The target's Defense reduces a physical attack and its Resistance reduces a magical one.
6. A target that is immune to the element takes nothing, and a ward against the element stops it and spends a charge.
7. Vulnerability to the element multiplies it, and a target that is blocking takes half.
8. Every Scoba in `<who>` is struck before any of them reacts, so a Scoba struck second is struck by the same attack the first one was.

An attack's elements are the move's element or elements. In a status, where there
is no move, it is Plain. Immunity, wards and vulnerability read only the first of
them. An attack whose first stat is `magic` is magical and any other attack is
physical.

| Option | What it does |
| --- | --- |
| `, as <element>` | Reads the attack as this one element instead. |
| `, as physical` or `, as magic` | Sets whether Defense or Resistance reduces it. |
| `, as <element> <physical or magic>` | Both at once. |
| `, as mixed` or `, as <element> mixed` | Physical and magical at once. The shares of `magic` are magical and reduced by Resistance, and everything else in the attack is physical and reduced by Defense. It answers triggers waiting for either kind. |
| `, sound <name>` | The sound it lands with, instead of the plain blow. |

**`hit <who> <share> <stat> + <n> at max level`** adds a flat amount on top of
the shares, scaled by the attacker's level against the ceiling of 30, so `+ 8 at
max level` is 8 damage at level 30 and a fifth of that at level 6.

**`+ <share> of their max hp`** adds a share of the HP bar of whoever the attack
lands on, which is the one part of an attack read off the target rather than off
the attacker. It joins the shares before any multiplier, so the same-type bonus,
the type chart and the target's armor all cut it the same way they cut the rest.

```
hit target 100% strength + 100% of their max hp
```

**`, bouncing at <share>`** carries the attack on to every other enemy standing,
in mark order, after the ones it was aimed at. Each one takes that share of what
the one before it took, so `bouncing at 70%` lands at 70% on the second, 49% on
the third and so on. Each bounce is worked out against the Scoba it lands on, so
armor and the type chart still read against that Scoba.

Write `throwing <art>` after it to draw the bounce: the art arcs from each
target to the next one it reaches, and lands before the damage it delivers. The
first leg, from the caster to the target it was aimed at, is an ordinary `throw`
step above the hit.

```
throw rockthrow as lob to target
hit target 100% strength, bouncing at 70% throwing rockthrow
```

**`, per stack of <status>`** counts the hit once for each stack of that status
the target carries, and throws it at nobody carrying none.

```
hit target 8% magic + 8 at max level, per stack of coraled, as flux magic
```

**`hit <who> <n> per level`** is flat damage: that number times the attacker's
level, in place of a share of a stat. The rest is an ordinary hit. The same-type
bonus, the type chart and Defense or Resistance all apply, and it takes the same
`, as` clauses. With no stat to read a category off, it is physical unless it
says otherwise.

```
hit target 2 per level
```

A `hit` or `heal` step in a move whose aim group resolved to nobody writes
"But there was no target..." and does nothing.

**`damage <who> <share> [+ <n> at max level], as <element> <category>`** deals a
set amount, with no type chart, no same-type bonus and no armor. Immunity, wards,
vulnerability and blocking still apply. The category is `physical`, `magic` or
`true`, and `as true` alone means Plain true damage.

```
damage holder 15% of source magic, as firework magic, fixed when applied
damage holder 20% of source strength + 50 at max level, as firework magic, fixed when applied
damage holder 10% of their max hp, as true, counts as attack
```

| Option | What it does |
| --- | --- |
| `, as <element> <category>` | Required. What kind of damage it is. |
| `, fixed when applied` | In a status, the number is measured once as the status lands, and later changes to the source change nothing. |
| `+ <n> at max level` | Adds a flat number, scaled by the source's level against the level ceiling of 30, so it means that number at level 30 and a fifth of it at level 6. Players read it as what each level adds, so `+ 50 at max level` shows as 1.67 damage per level. It counts only on a status marked `fixed when applied`. |
| `, counts as attack` or `, counts as status` | Whether a kill with it counts for `when it kills`. An attack counts and a status tick does not. Damage in a status counts as a status tick unless it says otherwise, and damage in a move counts as an attack unless it says otherwise. |
| `, sets off hits` | The Scoba it lands on answers `when hit` triggers, and its source answers `when it lands a hit` triggers. Without it, neither happens. |
| `, sound <name>` | The sound it lands with. |

In a status, a `damage` step also writes "<status> hits <name>." in the log.

**`heal <who> <share>`** restores HP, up to the size of the bar. It can never
bring back a Scoba that has fainted.

```
heal target 50% of their max hp
heal target 50% of caster magic, sound heal
heal holder 6.25% of their max hp
```

**`take <share> hp from <who>, deal it to <who>`** takes that share of the current
HP of each Scoba in the first group as true damage, then splits the total evenly
across the second group as true damage that sets off hits.

**`heal <who> power`** heals by the number the status or the patch running the
step snapshotted as it landed, in place of a share of a stat.

**`take <share> hp from <who>, heal <who> with it`** does the same, and splits the
total across the second group as healing.

```
take 25% hp from target, deal it to target2
take 20% hp from target, heal target2 with it
```

### Statuses and fields

**`inflict <status> on <who>`** lands a status on each Scoba in `<who>`. It is
measured off the caster in a move, and off whoever left the running status in a
status, so a status that spreads another one keeps naming the Scoba it came from.
In a passive, which nobody left, it is measured off the holder.

```
inflict cold on target
inflict sticky on others, for 2 turns
```

| Option | What it does |
| --- | --- |
| `, for <n> turns` | The status stands this many turns instead of its own `lasts`. |

**`undo what <who> takes this round, marked <status>`** remembers the HP and the
statuses each Scoba in `<who>` is carrying, and puts them back at the end of the
round. One that falls in the meantime stays fallen: what is undone is damage that
was survived. The mark is what the board shows while it is held, so a player can
see who is covered, and it comes off with the putting back. It is optional, and a
step without one holds the round just the same.

```
undo what target takes this round, marked undoing
```

**`rewind <n> turns`** puts the whole battle back the way it stood that many
rounds ago. The round it runs in stops there, since everything after it in that
round happened in a past that is gone. Where the battle has not run that many
rounds, it goes back as far as it has.

**`travel back <n> turns, <n> mana off`** goes back the same way and stands the
caster there as a visitor on a spare mark. The round it ran in ends there. The
next round, the visitor picks a move in the past like anybody else while
everyone around it repeats what they chose, and the rounds after that play
themselves out. A choice the new past has made impossible simply does not
happen. The visitor pays the named discount on everything it casts while it is
back there, everything on the field reaches it, and what becomes of it becomes
of the Scoba it came from. Only a move uses it, and the mana off is optional.
The steps after it can name the visitor as `traveller`.

```
travel back 3 turns, 30 mana off
show timemachine as landing on traveller
```

**`clear <status> from <who>`** takes one named status off each Scoba in
`<who>`, however many stacks it holds.

```
clear coraled from target
```

**`cleanse <good or bad> marks from <who>`** takes every good or every bad status
off each Scoba in `<who>`, except the statuses its passives are carried as.

**`copy marks from <who> to <who>`** copies every status the first Scoba in the
first group is carrying onto each Scoba in the second group, except the statuses
its passives are carried as.

**`lay <field> over <side>`** lays a field over `its side`, `the enemy side` or
`both sides`, taking off whatever field was standing there.

```
lay sunblessed over both sides
```

**`plant <status> under <who>`** grows a patch on the mark each Scoba in
`<who>` is standing on. The patch is on the ground rather than on the Scoba: it
stays where it is when that Scoba switches out or falls, and what it does, it
does to whoever is standing on the mark when it goes off. One patch to a mark,
so planting again stands a fresh one up in place of the old.

A patch is an ordinary status with a `planted <art>` line, which is both what
says it is a patch and the art drawn on the mark. It measures its `power` off
whoever planted it as it goes down, so that Scoba leaving the field does not
weaken it, it counts its own `lasts` down at the end of each turn, and whoever
is standing on it reads it as a sigil for as long as they stand there.

```
plant grove-patch under ally scobas
```

```
status grove-patch "Grove"
  good
  icon grove
  planted grove
  lasts 5 turns
  power 5% of source magic
  when a turn ends:
    heal holder power
```

### Other steps

**`raise <who> as a pawn at <share> level, as <element> <element>`** puts a
fallen Scoba back on the field as a Pawn of the caster's side, at that share of
the level it fell at, painted in the caster's own colours and answering to the
caster's owner. The elements replace what it was, and with none named it comes
back as whatever the caster is, which is what a hybrid raiser passes on. The body it came from stays down, so
the side that lost it does not get it back, and the steps after it reach the
Pawn as `raised`. A side with no free Pawn mark raises nothing.

```
raise target as a pawn at 75% level, as moon flux
inflict decaying-coral on raised
```

**`give <who> <move> in slot <n>`** puts a named move in that slot for the rest
of the battle, the same way `give <who> picked move in slot <n>` puts the move a
`pick` turned up. `as extra` hands it over beside the four instead.

**`basic attack <who>`** makes the Scoba running the step take one free basic
attack on each Scoba in `<who>`, the same swing a chosen attack makes: the move
a passive turned the basic attack into where there is one, and a plain blow
otherwise. It costs nothing, and everything watching for a basic attack answers
it, so a passive that acts on the holder's basic attacks acts on this one too.
Where the step is run by a status answering `when hit`, write `other` to swing
back at whoever landed the hit.

```
basic attack other
```

**`ask <who> to pick <aim> as <name>, saying "<words>"`** stops the round and
asks each Scoba in `<who>` to pick one Scoba, in the same words an `aim` line
uses. What they pick stands as the group `<name>` for the steps below it. A
Scoba that cannot be asked, or that is answered with nothing, is not in the
group. The round carries on where it stopped once everyone it asked has
answered, so ask everyone in one step rather than one at a time.

```
ask ally scobas to pick any enemy as chosen, saying "Who takes it?"
hit chosen 100% magic
```

**`summon <species> at level <n>`** calls a Scoba to the side of the one running
the step. A Pawn species takes a Pawn slot and comes out at its summoner's level,
whatever the step says. Anything else joins the bench at the level given. A side
refuses a seventh summon, and a side with no free Pawn slot refuses another Pawn.
The steps after it reach a Pawn it called up as `raised`.

**`summon <species> at <share> level`** calls it at that share of the summoner's
own level instead, for a Pawn or anything else.

| Option | What it does |
| --- | --- |
| `, copying <who>` | Hands it the moves the first Scoba in `<who>` holds, its second passive, every status it carries and every move it was handed for the battle. A Scoba that was bred toward some stats calls up one leaning the same way: the new one's line gains whatever the bred one has more or less of than its own species would at the same total. Hyper-Mode is never copied. |
| `, except <status>` | A status the copy leaves out. Write it once for each. |

```
summon grinkling at 60% level, copying caster, except pylon, except double-spawn
if raised stands:
  damage caster 30% of their max hp, as true, counts as status
```

**`find <n> <item>`** gives the side of the one running the step that many of an
item for the rest of the battle.

**`sap <n> mana from <who>`** takes that much mana off each Scoba in `<who>`,
down to an empty bar and no further.

**`give <who> <n> mana`** adds mana to each Scoba in `<who>`, up to 100. A
fusion has two mana bars, and the mana goes to whichever holds less. Write
`, second bar` after it to put the mana in a fusion's second bar instead. On a
Scoba that is not a fusion the option changes nothing.

```
give holder 20 mana, second bar
```

### Cards

These three steps work together. The card is drawn once, and the throw, the value
dealt and the card shown over the target's head all come from that one draw.

**`draw a card`** draws one card from the deck and calls it the drawn card for the
steps after it. The deck is the twelve card drawings in `assets/Powers`, listed
with their values in `src/sim/cards.ts`: Ace is 1, Two to Nine are 2 to 9, and the
Jack, Queen and King are 10 each. One roll picks the card's place in the deck, and
that place decides both which drawing it has and what it is worth.

| Option | What it does |
| --- | --- |
| `, swap <color> for <color> <share> of the time` | Replaces one color on the card's drawing with another, that share of the draws. Colors are written like `#bc0006`. Write the option more than once for more than one color, and each one rolls on its own. |

```
draw a card, swap #bc0006 for #000000 50% of the time
```

Every roll a draw makes comes off the battle seed, the turn, the Scoba drawing, the
id of the record the step is in, and how many cards the same steps have already
drawn. Nothing about a card is rolled where it is drawn on screen, so every player
in a shared battle draws, throws and holds the same card in the same colors.

**`throw drawn card as <path> to <who>`** throws the drawn card, with its color
changes, the same way `throw` throws any art.

**`deal drawn card to <who>, hand <status>, 21 pays <share> strength`** adds the
drawn card's value to the hand the `hand` status counts on each Scoba in `<who>`.
The card lands on top of that hand and is shown over the Scoba's head, as it was
thrown, until another card lands on it or the hand clears. A hand of exactly 21
pays out for that share of the dealer's Strength as Fortuna physical damage and
clears. A hand over 21 busts and clears.

A `throw drawn card` or `deal drawn card` step needs a `draw a card` step above it
in the same record.

```
draw a card, swap #bc0006 for #000000 50% of the time
throw drawn card as toss to target
hit target 30% strength
deal drawn card to target, hand dealt, 21 pays 230% strength
```

### Conditions

**`if <who> fell:`** runs the steps under it only if a Scoba in `<who>` that was
standing when the steps began has fainted since.

**`if <who> stands:`** runs the steps under it only if a Scoba in `<who>` is
standing. After a `summon`, `if raised stands:` runs only where something
actually arrived.

**`refund`** puts back the mana the move was cast for and clears its cooldown. It
only works in a move.

```
hit target 140% magic, sound tantalizingsweet
if target fell:
  refund
```

### Picking and rewriting moves

These three steps work together, and any passive or move can use them.

**`pick a random move`** picks one move out of every move in the game and calls
it the picked move for the steps after it. The roll comes off the battle seed, the
turn, the Scoba picking and the id of the record the step is in, so every player
in a shared battle lands on the same move. A pick that finds no move ends the
block it is in, so nothing after it runs.

| Option | What it does |
| --- | --- |
| `, costing at least <n>` | Only moves whose `costs` line is at least this much. |
| `, skip once per battle` | Leaves out moves that are `once per battle`. |

A pick never lands on a move that is itself a rewrite. A `change picked move:`
or a `give <who> picked move` step needs a `pick a random move` step above it in
the same record.

**`change picked move:`** rewrites the picked move. The lines under it are the
changes, applied in order.

| Change | What it does |
| --- | --- |
| `set type <element>` | Sets the move's first element. A second element is kept. Every status the move inflicts is rewritten too, so its damage steps and attacks deal the new element. |
| `set damage physical` or `set damage magic` | Sets how every `hit` step in the move is reduced. Heals are not changed. |
| `scale off strength` or `scale off magic` | Sets the first stat every `hit` step reads, where that stat is Strength or Magic. A heal that reads a share of the caster's Strength or Magic reads the new stat. A heal that reads a share of the target's own HP is not changed. |
| `tint <color>` | The color the move is played back in, and the color its art is tinted. |
| `set cost x<n>` | Multiplies its mana cost and rounds it to a whole number, so `set cost x0.5` makes an 85 mana move cost 43. |
| `set name "<words>"` | Renames it. `{name}` in the words is the name it had, so `set name "Golden {name}"` turns Moonbeam into Golden Moonbeam. |

A rewrite is built once and kept under an id of the form
`<move>@<record>`, such as `moonbeam@roll-the-wheel`. It keeps the name of the
move it came from unless a `set name` change gives it another. A player who joins a shared battle part way through builds
every rewrite the battle already names from that id, so both players read the same
move under it.

**`give <who> picked move as extra`** hands the picked move to each Scoba in
`<who>` for the rest of the battle, on top of the moves it holds, replacing the
last move handed over this way.

**`give <who> picked move in slot <n>`** puts the picked move in that slot, from 1
to 4, for the rest of the battle.

A move handed over either way costs what its `costs` line says, arrives off
cooldown, and is never written onto the Scoba the player keeps.

```
pick a random move, costing at least 80, skip once per battle
change picked move:
  set type fortuna
  set damage physical
  scale off strength
  tint #e8c46a
  set name "Golden {name}"
  set cost x0.5
give holder picked move in slot 4
```

## Standing effects

Standing effects go under `while carried:` in a status or a passive, and under
`while standing:` in a field. Each one applies once for every stack of the
status.

| Effect | What it does |
| --- | --- |
| `<stat> x<n>` | Multiplies the stat. Stacks multiply together. |
| `<stat> +<n>` or `<stat> -<n>` | Adds to the stat before any multiplier. |
| `<stat> +<n> after scaling` | Adds to the stat after every multiplier, so it stays a flat amount. |
| `<stat> = <n>` | Sets the stat outright. The last one applied wins. |
| `<stat> + <share> of <stat>` | Adds a share of another stat, as it stood after every add. |
| `<stat> + <share> of base + <n>` | Adds a share of the stat as it was when the status landed, plus a flat amount. Hyper-Mode is written this way. |
| `<stat> - power` or `<stat> + power` | Moves the stat by the status's `power` number. |
| `<stat> - <share> power` | Moves the stat by a share of the `power` number. |
| `all stats <change>` | The same change to all six stats, like `all stats +3`. |
| `<element> moves x<n>` | The holder's attacks of that element are multiplied. |
| `immune to <element>` | Attacks and damage of that element do nothing to the holder. |
| `takes x<n> from <element>` | Damage of that element to the holder is multiplied. |
| `blocks <element> hits` | The next hit of that element is stopped outright and spends one of the status's charges. |
| `cannot switch out` | The holder cannot be called back. |
| `cannot enter hyper-mode` | The holder can no longer enter Hyper-Mode. |
| `cannot cast spells` | The holder cannot cast any move, its granted ones included. Its basic attack is still offered. |
| `casts again at <share>` | Everything the holder casts is cast a second time, worth that share of the first. What the second cast leaves stands beside what the first left rather than refreshing it, even where that status does not stack, and is worth the same share. |
| `takes x<n> from everything` | Everything hurts the holder that much more, whatever element it is. |
| `cuts the next hit by <share>` | The next instance of damage the holder takes is cut by that share, and it spends one of the status's charges. |
| `marks it leaves hit x<n> if they last <n> turns or more` | Every status the holder leaves that stands at least that many turns measures its `power`, and its `fixed when applied` damage, that many times over. |
| `bad marks it carries hit x<n>` | Every bad status on the holder is that many times as effective. `good marks it carries hit x<n>` does the same for good ones. |
| `bad marks on enemies hit x<n>` | Every bad status on every enemy on the field is that many times as effective, for as long as the holder is standing on the field. |
| `good marks on allies hit x<n>` | Every good status on every ally on the field, the holder included, is that many times as effective, for as long as the holder is standing on the field. |
| `heals on allies + <n> at max level` | Every heal that lands on an ally on the field, the holder included, restores that much more, for as long as the holder is standing on the field. The amount is at the level ceiling, and a lower holder adds its share of it. |

A status made more effective by one of the three `marks ... hit` effects moves
every stat it changes by that much more, deals and heals that much more each
time it goes off, and has any multiplier it applies moved that much further from
1, so x0.8 at half again as effective reads x0.7. They are read every time a
status is, so they reach statuses already there as well as new ones. They reach
passives too. They pass by a status written `always as written`, which
Hyper-Mode and EZ mode are, and a status carrying one of these effects itself.
Two of them together multiply.

Write `, shown as <status>` after an effect that reaches enemies or allies to
give every Scoba it reaches a sigil for it, other than the holder, which already
shows its own. The status names the sigil, its icon and the line its window
says. Nothing carries it: it is shown for exactly as long as the reach lasts.

```
bad marks on enemies hit x1.15, shown as multiply-enemies-reach
```

The stat words are `hp`, `strength`, `defense`, `resistance`, `magic` and
`speed`. Changes to stats apply in a fixed order, whatever order the lines are
written in: sets, then adds, then power, then shares, then multipliers, then
`after scaling` adds and shares of base. Every stat is rounded down at the end.

## Triggers

A `when` block names one trigger.

| Trigger | When it happens |
| --- | --- |
| `when the battle starts:` | Once as the battle opens, for everyone on both teams, bench included. |
| `when it takes the field:` | The holder is sent out, walks on to replace a Scoba that fell, or enters Hyper-Mode. |
| `when a turn starts:` | At the start of every turn, for everyone on the field. |
| `when a turn ends:` | At the end of every turn, for everyone on the field, after mana comes back. |
| `when it makes a basic attack:` | The holder makes a basic attack. `other` is the Scoba it swung at. |
| `when it casts:` | The holder casts a move. `other` is the first Scoba the move was aimed at. |
| `when it blocks:` | The holder blocks. |
| `when hit:` | An attack or damage that sets off hits lands on the holder. |
| `when hit by magic:` | The same, for magical damage. |
| `when hit by physical:` | The same, for physical damage. |
| `when hit by <element>:` | The same, for damage of that element. |
| `when it lands a hit:` | The holder's attack, or its damage that sets off hits, lands on someone. |
| `when it lands magic:` | The same, for magical damage. |
| `when it lands physical:` | The same, for physical damage. |
| `when it lands a spell:` | The same, for a `hit` step in a move rather than a basic attack. |
| `when it lands <element>:` | The same, for damage of that element. Add `physical` or `magic` for only that category of it, like `when it lands firework physical:`. |
| `when it kills:` | The holder's attack makes a Scoba faint. |
| `when it faints:` | The holder faints. |
| `when an ally faints:` | A Scoba on the holder's team faints. |
| `when an enemy faints:` | A Scoba on the other team faints. |
| `when anyone faints:` | A Scoba on either team faints. The holder's own fall is `when it faints:` instead. |
| `when below <share> hp:` | The holder takes damage and is left at or below that share of its HP bar, like `when below 50% hp:`. |

A trigger that runs steps which set off more triggers can chain four deep, and no
further.

## How a cast plays

A cast runs in this order:

1. The caster pays the mana, the move goes on cooldown, and the log says the move was cast.
2. Every `aim` group resolves to its Scobas.
3. The `cast:` steps run in order.
4. The caster's `when it casts:` triggers run.

The scene plays the battle back one event at a time, in the order the battle ran
them. A step that only changes what is drawn and heard is an event of its own and
takes its place in that order, which is why a script can put a sound before a
throw, a status before an attack, or a pause between two hits. When an attack
reaches several Scobas, their hits flash and shake together.

A basic attack is not written in move script. It lunges and lands a Plain
physical blow, unless a passive the Scoba carries says `basic attack is <move>`,
and then it is aimed and cast the way that move is.

The blow is 10, plus the attacker's level, plus 90% of its Strength, and from
there it is a Plain hit like any other: a Plain Scoba lands it for half again,
the chart reads Plain against whoever it hits, and anything the attacker
carries that powers Plain powers it too. The target's Defense reduces it.

## Written text

A move's or a passive's `text` line is what a player reads. The Words boxes in
the cosmetics editor edit this same line. Words in brackets become highlighted
words with the numbers behind them in a hover window.

| Token | What it shows |
| --- | --- |
| `[damage]` | What the move's first `hit` step deals, with its scaling on hover. |
| `[damage:<n>]` | What the move's nth damage deals. A `hit` step counts, and so does the payout of a `deal drawn card` step, in the order the cast runs them. `[damage:2]` is the second. |
| `[damage:<status>]` | What a status's damage step deals each time it runs. |
| `[heal]` | What the move's first `heal` step restores. |
| `[heal:<n>]` | What the move's nth `heal` step restores. |
| `[heal:<status>]` | What a status's heal step restores each time it runs. |
| `[heal:<status>:<n>]` | What a status's or a passive's nth heal step restores, counted through every `when` block in the order they are written. `[damage:<status>:<n>]` does the same for damage. |
| `[power:<status>]` | What a status's `power` takes from or adds to a stat, like the Speed `in-the-black` takes. |
| `[scaling:<n>]` | The move's nth scaled number of any kind, in the order the cast runs them. Each `hit`, `heal` and card payout counts, and each status an `inflict` step leaves counts its `power`, then its damage step, then its heal step, then the numbers of any status its own `inflict` steps leave. Each status counts once. On Black, `[scaling:2]` is what `in-the-black` takes off Speed, and on Cold Wave it is what the `chill` that `cold` leaves takes off Speed. |
| `[status:<id>]` | A status or a field, named, with what it does on hover. |
| `[status:<id>\|<word>]` | The same, shown as a word of your own, like `[status:cold\|chills]`. |

A bracket the game does not recognise is shown exactly as it was typed.

## When something is wrong

The game refuses to start with a mistake in a script file, and says which file,
which line and what is wrong. Every message names the line, says what the game
expected, and guesses the word you meant where it can:

```
moves.txt line 42: "hitt" does not start a step. Did you mean "hit"?
moves.txt line 57: "enemy" is not who it reaches. Did you mean "enemies"?
```

The cosmetics editor checks a record as you type, shows its problems under its box
with line numbers counted from the top of the box, and applies a record only once
it has none. Save refuses to write a file with a mistake in it.

An id that names a record that does not exist, such as `inflict frozen-solid on
target`, is found once every file is read. The game tests (`npm test`) report it,
and so does the editor.

## Adding to the language

A new step, standing effect or trigger touches these places. The type checker
and the tests catch a missed one.

1. Add its shape to `Step`, `Standing` or `StatusTrigger` in `src/sim/status.ts`.
2. Read it in `src/sim/script/read.ts`, and add any new fixed words to `src/sim/script/words.ts`.
3. Write it back in `src/sim/script/write.ts`. `tests/script.test.ts` writes every shipped record and reads it back, so a step read one way and written another fails there.
4. Run a step in `runStep` in `src/sim/battle.ts`. Read a standing effect where the number it changes is worked out. Fire a trigger from wherever the thing it waits for happens.
5. Describe it in `src/sim/describe.ts`, for the sentence a record with no written text shows.
6. Play a step that only changes what is drawn and heard in `queueVisual` in `src/game/battlestage.ts`.
7. Document it here.

## Worked examples

A status that is its own sigil and leaves another status every turn:

```
status cold "Cold"
  bad
  icon cold
  lasts 3 turns
  when a turn ends:
    inflict chill on holder

status chill "Chill"
  bad
  icon cold
  stacks up to 10
  lost on switching out
  power 10% of source magic
  while carried:
    speed - power
```

A passive that fires once, as its Scoba takes the field:

```
passive sticky-mess "Sticky Mess"
  text "Taking the field leaves everyone else [status:sticky|stuck] for two turns, once a battle."
  once per battle
  when it takes the field:
    inflict sticky on others, for 2 turns
```

A move that refunds itself on a kill:

```
move tantalizing-sweets "Tantalizing Sweets"
  type sugar
  costs 100 mana
  cooldown 5
  aim any enemy
  cast:
    caster rear
    throw "tantalizing sweet" as drop to target
    hit target 140% magic, sound tantalizingsweet
    if target fell:
      refund
```

A new passive built from the move-rewriting steps. It hands its Scoba an expensive
move from anywhere in the game, turned into a Moon spell off Magic:

```
passive moon-wheel "Moon Wheel"
  text "Taking the field hands it one expensive spell, rewritten as Moon off Magic."
  once per battle
  when it takes the field:
    show spin as wheel over holder, pointer spintop
    pick a random move, costing at least 60, skip once per battle
    change picked move:
      set type moon
      set damage magic
      scale off magic
    give holder picked move as extra
    say "{self} draws {picked} out of the moonlight."
```
