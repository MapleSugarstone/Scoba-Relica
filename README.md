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
