# Ironfield

A cooperative factory-automation game for the browser, built for iPhone Safari and desktop.
Mine, smelt, belt, research, refine oil and launch a rocket together.

**Play:** https://tkfx-0.github.io/ironfield/

- One shared open world ("みんなのワールド", room `PLAZA2`) that anyone can enter. Whoever is inside hosts it; when the host leaves, a remaining player takes over automatically, and a retained copy on the broker (plus a copy on every player's device) lets the next visitor resume it when nobody is inside.
- Single player, or host a world of your own that anyone can join with a link (no account, no server of our own).
- Multiplayer is deterministic lockstep over public MQTT brokers: only player commands travel; every peer runs the same simulation.
- All art and sound are generated procedurally at load time. No build step: plain ES modules.

## Run locally

```
npx http-server . -p 8140 -c-1
```

Then open http://localhost:8140/. Headless checks: `node tools/simtest.mjs`, `node tools/stress.mjs`.

## Layout

- `src/sim/` deterministic simulation (belts, inserters, machines, power and fluid networks, research)
- `src/render/` WebGL2 renderer, procedural sprite atlas, terrain shader
- `src/ui/`, `src/input.js` touch-first HUD and panels
- `src/net/session.js` lockstep multiplayer over MQTT
- `src/audio.js` synthesized sound
