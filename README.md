# Ironfield

A cooperative factory-automation game for the browser, built for iPhone Safari and desktop.
Mine, smelt, belt, research, refine oil and launch a rocket together.

**Play:** https://tkfx-0.github.io/ironfield/

- One big world cut into 47 equal plots, one per prefecture, laid out like a tile map of Japan (`src/plots.js`). You build in your own prefecture's plot together with the other players from that prefecture. Each plot is an open room (`plotRoom(p)` in `src/net/session.js`): whoever is inside hosts it; when the host leaves, a remaining player takes over automatically, and a retained copy on the broker (plus a copy on every player's device) lets the next visitor resume it when nobody is inside.
- There is no single player, no self-hosted world and no room codes: every factory lives in a plot.
- Multiplayer is deterministic lockstep over public MQTT brokers: only player commands travel; every peer runs the same simulation.
- All art and sound are generated procedurally at load time. No build step: plain ES modules.
- Prefecture territory battle (陣取り, design in `docs/陣取り設計.md`): flags made in the factory are placed on a 10 km grid of Japan, 3 per day. For now the map and the other prefectures are simulated on the device (`src/jintori/`).

## Run locally

```
npx http-server . -p 8140 -c-1
```

Then open http://localhost:8140/. Headless checks: `node tools/simtest.mjs`, `node tools/stress.mjs`, `node tools/jintori-test.mjs`.

## Layout

- `src/sim/` deterministic simulation (belts, inserters, machines, power and fluid networks, research)
- `src/render/` WebGL2 renderer, procedural sprite atlas, terrain shader
- `src/ui/`, `src/input.js` touch-first HUD and panels
- `src/net/session.js` lockstep multiplayer over MQTT
- `src/audio.js` synthesized sound
