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

## Timings, and why they are configurable

Three numbers govern a room's life, and all three are read from the environment
with the shipped values as defaults:

| Var | Default | What it governs |
| --- | --- | --- |
| `HOST_GRACE_MS` | 90 s | How long a vanished host keeps the role before it passes to someone still connected |
| `ROOM_TTL_MS` | 7 days | Idle time before a room deletes itself |
| `UNCLAIMED_TTL_MS` | 1 hour | Lifetime of a code that was allocated but never joined |

They are inputs rather than constants so the tests can compress them. A ninety
second grace period is untestable in practice, and what stood in its place was an
assertion about something cheaper to observe -- which passed happily while a dead
host stranded whole tables. Promotion runs off a stored alarm precisely because a
table waiting on the host to score sends no messages at all, so there is nothing
to piggyback the check on.

```sh
npx wrangler dev --port 8787 --local --var HOST_GRACE_MS:1500
node test-relay.mjs
```

`GET /api/health` reports the effective values, which is how the suite knows what
to wait for and how it can refuse to run against an uncompressed clock.


## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness check, and the effective timings below |
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
