# Scoba Relica

A two-player monster-catching adventure that runs entirely in the browser. Built for phones first, hosted on GitHub Pages. Two players share one story as characters A and B, raise a special Scoba together, and battle side by side.

## Run it

```
npm install
npm run dev
```

`npm test` runs the simulation tests (breeding, battle, legality, care). `npm run build` produces the static site in `dist/`.

## World editor

Press F2 in a running game (dev server, or any build with `?dev=1` on the URL) to open the world editor: a tileset palette with paint, fill and rectangle tools across four draw layers (so a wall can sort against you at its foot and cover you at its top), collision painted nine subcells to a tile, terrain, props, encounter zones, NPCs with dialogue and trainer teams, quest chains, and as many maps as you want, joined by teleport tiles.

Edits live in the browser until you export. To make them permanent, hit Export in the World tab, then **drag the downloaded `world.json` onto `import-world.cmd`** in this folder. It writes the file into `src/game/content/world.json` (keeping a `.bak` of the old one) and prints what it imported. Commit that file and the world ships with the game.

## Two ways to start

A save belongs to one adventure, and which one is settled when it is made.
"Start new adventure" makes you character A and mints the room code there and
then, so you are hosting from the moment the save exists. "Join someone's
adventure" takes their code, fetches their world, and makes you character B.

The join is a handshake before anything is built, because the world seed drives
the procedural world: a save created with its own seed would put you on a
different map wearing the same name as your friend's. The knock also brings
back who you are joining, so their name and their starter are known before you
pick yours.

The old flow let each player choose A or B for themselves, which meant two
people setting up separately could both pick A. Two clients claiming one slot
spent the evening quietly evicting each other, and neither ever saw a partner.
Which character you are now comes with how you started, so that cannot be set
up any more, and the relay refuses it as well by telling the two devices apart.

Starting a new adventure asks who is playing. On your own, you make both
characters and somebody can still join later; they arrive after the beginning.
With a friend, a waiting room goes up with the code, and neither of you makes
anybody until they arrive. Then you both make characters at once, each seeing
what the other has taken, and you walk into the world on the same beat, which
is what an opening scene needs.

A guest whose host has not started yet is routed into that waiting room rather
than being told nobody is home: `knock` can tell the difference, because a host
still setting up answers with a lobby message and one already playing answers
with a profile.

Connect is a status screen from then on. There is nothing to type into it: it
shows the code to read out, and whether the other player is currently there.

## The relay

Two players share one campaign through a small Cloudflare Worker in `worker/`:
one durable object per room code, relaying messages and keeping the shared
Relica's condition. All game rules stay in the browser, so the relay never
simulates a battle.

```
cd worker
npm install
npx wrangler dev        # relay on :8787
npx wrangler deploy     # once you have a Cloudflare account
```

With the relay running locally, open the game with `?relay=ws://localhost:8787`
to point it there; the setting is remembered until you clear it with `?relay=`.
Inside `worker/`, `npm run smoke` checks the deployed relay is up and has its
reminder keys, which takes a few seconds and is the first thing to run when a
phone says something is wrong. `node test/relay.test.mjs` is the thorough suite
and runs against either a local `wrangler dev` or the deployed relay with
`RELAY=https://... node test/relay.test.mjs`. `node test/reminders.test.mjs`
needs a local `wrangler dev`, since it stands up a stand-in push service on
localhost that a deployed worker could not reach. `npm test` checks the push
encryption against the worked example in RFC 8291 and needs nothing running.

## Versions

Two separate numbers, on purpose.

`PROTOCOL_VERSION` in `src/net/protocol.ts` is the wire format. Bump it when you
add, remove or change a message. Two clients on different wire versions are
refused a shared room and told why, because one of them would otherwise send
messages the other has never heard of and fail in confusing ways. The relay
reports its own too, so a client can say "the relay is out of date" instead of
watching every new message come back as unknown.

The build shown on the title screen comes from the git commit and moves on
every push by itself. A trailing `+` means the build had uncommitted changes.
It is only for saying which build somebody is running: a new sprite should not
stop two people playing together, which is why it is not what the gate uses.

Remember that the relay deploys separately from the game. Pushing to `main`
updates the site through Actions; the relay needs `npx wrangler deploy` from
`worker/`. If you change a message, both have to go out.

## Diagnostics

Settings has a Diagnostics panel listing whether the game is installed, whether
the save is safe from eviction, which build is running, the worker and relay
state, and whether reminders could be delivered. Anything that will stop a
feature working is marked. It exists because iOS cannot be inspected without a
Mac, so a tester there can screenshot one panel instead of guessing.

### Care reminders

The relay can wake both players when the Relica needs feeding, washing or
playing with. It needs a VAPID keypair:

```
node tools/make-vapid.mjs
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT      # mailto:you@example.com
```

Put the printed public key in `VITE_VAPID_PUBLIC_KEY` when building the client.
Without it the game does not offer reminders at all, and `GET /health` on the
relay says whether the worker has its half. For local work, put all three in
`worker/.dev.vars`, which is gitignored.

On iOS reminders only work once the game is on the Home Screen: Safari will not
grant notification permission to a tab.

A local `wrangler dev` normally has its own throwaway keypair in
`worker/.dev.vars`, which will not be the deployed one. That is fine, but the
two halves have to agree: a subscription is made against the public key in the
client build and can only be pushed to by the matching private key on the relay
it is talking to. So when testing reminders locally, build the client with
`VITE_VAPID_PUBLIC_KEY` set to the public key in `.dev.vars`. Pointing a client
built for production at a local relay gets you a subscription the local relay
cannot push to, which fails quietly and looks like a phone that never buzzed.

## Deploying to GitHub Pages

Push to `main`. The workflow in `.github/workflows/deploy.yml` builds the site and publishes it to Pages. In the repo settings, set Pages > Source to "GitHub Actions" once.

## Art

Every sprite in the game is original and lives in `assets/`: character doll layers, Scoba portraits, and the island tileset. Nothing is drawn from an outside pack.
