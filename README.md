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
Inside `worker/`, `node test/relay.test.mjs` and `node test/reminders.test.mjs`
run against a `wrangler dev` you already have going; `node test/push.test.mjs`
needs nothing running, since it checks the push encryption against the worked
example in RFC 8291.

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

## Deploying to GitHub Pages

Push to `main`. The workflow in `.github/workflows/deploy.yml` builds the site and publishes it to Pages. In the repo settings, set Pages > Source to "GitHub Actions" once.

## Art

Every sprite in the game is original and lives in `assets/`: character doll layers, Scoba portraits, and the island tileset. Nothing is drawn from an outside pack.
