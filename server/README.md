# Flip 7 relay

A Cloudflare Worker with one Durable Object per room. It holds the authoritative
scorecard so a table of phones can share it.

The scoring rules are **not** written here. `src/rules.js` is generated from
`../src/game.js` by the top-level `build.sh`, so the server validates rounds with
exactly the code the browser scores them with, and the two cannot drift.

## Deploy

```sh
cd server
npm install
npx wrangler login      # opens a browser once
npx wrangler deploy
```

Wrangler prints a URL like `https://flip7-relay.<your-subdomain>.workers.dev`.
Paste that into the scorekeeper's **Play together → relay server** field, or bake
it into the build by putting it in `../relay.config` and re-running `../build.sh`.

Do not edit `RELAY_URL` in `../src/app.js` directly: the build substitutes that
line, so an edited one stops matching and both `relay.config` and the
`RELAY_URL=` environment override silently stop working.

Durable Objects need a paid Workers plan; everything else here fits the free tier.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness check |
| `POST /api/rooms` | Allocate an unused 4-character room code |
| `GET /api/rooms/:code/ws` | WebSocket into that room |

## Protocol

Client sends `hello` → server replies `welcome` with the full state, then
broadcasts `state` to everyone on every change. Clients send `claimSeat`,
`releaseSeat` and `action`; a rejected action comes back as `reject` carrying the
authoritative state so the sender can roll back.

The first client to say hello becomes host. Only the host may start a game,
commit or undo a round, change the target, or add and remove players. A seated
player may edit only their own line. Anyone else is a spectator.

Rooms self-delete a week after their last action.
