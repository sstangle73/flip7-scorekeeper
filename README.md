# Flip 7 Scorekeeper

> ### Flip 7 is a game by **Eric Olsen**
>
> Published by **The Op** (USAopoly, Inc.), © 2025. Ruleset edition 3.1.
> **[Read the official rules (PDF)](https://cdn.shopify.com/s/files/1/0611/3958/3198/files/25_FLIP_7_TB_RULES_C_Rev_9_2_25_ND.pdf?v=1756935535)**
>
> This repository is an **unofficial, fan-made scorekeeping tool**. It is not affiliated
> with, endorsed by, licensed by, or connected to Eric Olsen, The Op, or USAopoly in any
> way. It contains no game assets and is not a substitute for owning the game —
> **please support the designer and publisher by buying a copy.**
> "Flip 7" and "The Op" are trademarks of their respective owners, used here only to
> describe what this tool keeps score for.

A web scorekeeper for Flip 7. At the end of each round you tap the cards sitting in front
of each player, and it works out the score — the ×2 multiplier, the bonus modifiers, the
Flip 7 bonus, and busts — so nobody has to do mental arithmetic between rounds.

**▶ [Open the scorekeeper](https://flip7-scorekeeper-719283.gitlab.io/)**

---

## What it does

- **Tap the cards, not the numbers.** The picker mirrors the table: score modifiers in a
  row above, number cards below, exactly as the rules describe laying them out.
- **Shows its working.** Every line gets a score tape rather than a bare total:
  `3 + 5 + 7 + 10 + 11 = 36 → × 2 = 72 → + 10 = 82`
- **Standings and a full scorecard**, with a race-to-200 bar (the target is editable
  mid-game if your group plays to something else).
- **Undo a round** and re-open it for editing. It warns before discarding a round you've
  already started entering.
- **Autosaves.** Close the tab mid-game and it's still there.
- **Keeps a record.** Finished games are kept on the device: wins, best rounds,
  Flip 7s and how often each of you busts.
- **Installs.** Add it to a home screen and it opens like an app and keeps
  working with no signal.
- **Light and dark**, following your device.

## Three ways to score a round

Open the app and pick **Just this device** or **Play together**.

### Just this device

Works offline, nothing leaves the phone. Two layouts, switchable mid-round:

| Mode | For |
| --- | --- |
| **Whole table** | One scorekeeper. Every player's picker is open at once; fold each one away as you enter it. |
| **Pass the phone** | One player on screen at a time, with a seat strip showing who's done and what they scored, and a hand-off button naming who's next. |

### Play together

Everyone on their own phone. One person starts a room, reads out the four-letter
code (or shares a link that carries it), and everyone else joins and takes a seat.
From then on each player enters their own cards, and the leaderboard, scorecard
and presence dots update for the whole table at once.

**This deployed copy ships with a relay already configured** — join a room and it
just works. Clone it and you get a standalone build with no relay; point it at
your own by putting the URL in [`relay.config`](relay.config) and rebuilding, or
by pasting it into the app once (it is remembered on the device).

Behind the scenes it needs a relay — a small Cloudflare Worker you deploy yourself, in
[`server/`](server/). Paste its address into the app once and it is remembered.
**Without a relay the app is exactly the standalone scorekeeper it was before**;
the networked half is entirely opt-in.

Who may do what is enforced on the server, not merely hidden in the interface:

- The **first phone in the room hosts**. Only the host starts the game, commits or
  undoes a round, changes the target, or adds and removes players.
- A **seated player** may edit only their own line.
- Anyone else spectates.
- Joining late, or after a phone dies, is fine: reconnecting keeps your seat, and
  the host keeps the host role.

Each player taps **Submit** when their line is final. That locks it, ticks them
off in the standings, and tells the host who is still out — so nobody scores
the round while someone is halfway through entering. Changing a line withdraws
it again, and the host gets a confirmation naming whoever hasn't submitted if
they score early anyway.

**Share a room** by holding up the QR code, reading out the four letters, or
sending the link. **Rejoin** without any of them: the homepage offers your
ongoing room back when you return, keyed on a random id in your own browser —
not your IP, which the whole table shares.

**The host** scores the rounds. It can be handed over deliberately, and if a
host's phone drops out for good the table promotes someone else after about a
minute, so a dead battery can't strand a game.

The relay caps room creation and joins per IP to keep the public one from being
abused. Cloudflare's limiter is deliberately permissive and eventually
consistent, so it damps sustained abuse rather than gating precisely.

## What it checks for you

The rules make some entries impossible, and the app refuses them at the point of entry
rather than silently scoring nonsense:

- **Seven unique number cards is a Flip 7**, so the line stops there.
- **A busted line stops at six** — a seventh unique card would have ended the round before
  a duplicate could turn up.
- **Only one player can Flip 7 per round**, because it ends the round the instant it
  happens. Once one player has it, everyone else caps at six, and the app says who and why.
- **Deck legality across the table.** The deck holds exactly one `0`, one `1`, and one of
  each modifier, and cards in front of players are never reshuffled mid-round — so if two
  players are both credited with the `×2`, that's a typo. It warns, naming the card.

## Scoring

Following the rulebook's own order:

1. Add the value of the number cards.
2. If the `×2` card is out, **double the number-card total** — modifiers are not doubled.
3. Add any `+2`…`+10` bonus cards.
4. Seven unique number cards scores an **additional 15**.

Busting scores nothing for the round, whatever is in front of you. The `0` card adds no
points but does count toward the seven. A modifier on its own still scores — except a lone
`×2`, which doubles a number-card total that isn't there. Freeze, Flip Three and Second
Chance carry no points and aren't entered.

Verified against every worked example printed in the rulebook (36 / 72 / 46 / 64, and the
+4 example at 32).

> On **Flip 7 combined with ×2** the app scores `(sum × 2) + bonuses + 15` — the 15 is
> added at step 4, after the doubling at step 2, and the rules state that `×2` doubles
> *number cards*. Worth knowing which way it rules if your table disputes it.

## Running it locally

No build tooling, no dependencies, no package manager. Open the file:

```sh
git clone https://gitlab.com/sstangle73/flip7-scorekeeper.git
cd flip7-scorekeeper
```

Then open `index.html` in a browser. That's it.

## Project layout

| Path | What it is |
| --- | --- |
| `src/page.html` | Title, styles and markup |
| `src/game.js` | The rules core: scoring, validation, and the reducer. No DOM, no clock, no randomness |
| `src/net.js` | WebSocket client: connects, reconnects, reports status |
| `src/qr.js` | A small QR encoder for the join code |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | What makes it installable and offline-capable |
| `tools/make-icons.mjs` | Draws the icons. Re-run it and commit if you change the mark |
| `src/app.js` | The interface |
| `server/` | The relay: a Worker with one Durable Object per room |
| `build.sh` | Concatenates the sources into the outputs below |
| `index.html` | **Built** — standalone page, open it directly |
| `app.html` | **Built** — same page as a fragment, for embedding in a host that supplies its own `<head>` |
| `relay.config` | The relay baked into the build. Blank = standalone only |
| `.gitlab-ci.yml` | Rebuilds, runs the tests, checks the committed build isn't stale, deploys Pages |

Edit the files in `src/`, never the built output, then:

```sh
./build.sh
```

To build against a different relay without editing anything:

```sh
RELAY_URL=https://flip7-relay.your-name.workers.dev ./build.sh
```

CI fails the build if `index.html` doesn't match what `src/` produces, so a stale commit
can't ship.

## Privacy

Played on one device, scores live in your browser's `localStorage` and are never
transmitted anywhere. There is no analytics and no tracking. The page makes one
third-party request — fonts from Google Fonts — and the rules link points at
the publisher's own PDF.

**Play together** sends the scorecard to whichever relay you point it at, and
nothing else: names, cards, scores. No accounts, no email, and no identifier
beyond a random per-device string used to remember which seat is yours. You host
the relay, so the data stays with you, and rooms delete themselves a week after
their last action.

The relay keeps four aggregate counters — rooms created, rounds scored, games
finished, and rooms active in the last half hour — readable at
[`/api/stats`](https://flip7-relay.sstangle73.workers.dev/api/stats). They record
how much the relay is used and nothing about who uses it: no names, no scores, and
no room codes, since publishing live codes would hand out a list of games to walk
into. Playing on one device increments nothing and contacts no server at all.

## Accessibility

Built with a red-green colour-blind reader in mind: the four card states use hue-distinct
colours *and* carry a glyph or word, so colour is never the only signal — `✓` on selected
cards, `✗ BUST`, `★ FLIP 7`, `▲ LEAD`. Every control is keyboard reachable, focus survives
the re-render after each tap, dialogs trap focus and mark the page behind them inert, and
motion respects `prefers-reduced-motion`.

## License

The scorekeeper code is [MIT licensed](LICENSE) — © 2026 Steven Storie.

**That licence covers this code only.** It grants no rights in Flip 7, its rules, its card
designs, or the "Flip 7" and "The Op" trademarks, all of which belong to their respective
owners.

## Support

This is free and unaffiliated, and staying that way. If it has earned its keep at
your table, you can [buy me a coffee](https://buymeacoffee.com/stevenstorie).

Buy the game first, though — Eric Olsen designed it and The Op publish it.
All this does is the arithmetic.

## Credits

- **Eric Olsen** — designer of Flip 7
- **The Op / USAopoly, Inc.** — publisher
- This scorekeeper — built by [Steven Storie](https://gitlab.com/sstangle73)
  ([buy me a coffee](https://buymeacoffee.com/stevenstorie))
