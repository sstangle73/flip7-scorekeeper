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
- **Go back and fix any round.** Tap a round in the scorecard to step into it;
  totals update as you correct it, and the round you were part-way through is
  waiting where you left it. Deleting a round is a separate, named action, so
  nothing is thrown away by pressing "back".
- **New game, same table or a different one.** **New game** either deals the same
  players back in or takes you to the roster to change who is playing — the finished
  game is kept in the record either way. Spellings, and who is at the table, can also
  be fixed mid-game under **⋯ More → Players**.
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
| **Live odds** | Cards go in as they're flipped, and every line shows its chance of busting on the next card. See below. |

### Live odds

Switch the round to **Live odds** (it's there in a room too) and tap each card in
as it comes out. A number card cycles *not out → held ✓ → busted ✗*, so the
duplicate someone busts on is recorded as well; with a Second Chance in hand that
tap spends it instead (*♥ saved*), and the Second Chance shows what it was used
on. Freeze, Flip Three (with a count of the flips still owed) and the modifiers go
in the same way. Each line then shows:

- the chance the **next card busts** them: duplicates of what they hold still in
  the deck, over the cards left in it (0% while they hold a Second Chance, with
  the chance it gets used up)
- the chance it's **safe**, the chance it's a **new number**, and the chance of
  reaching **Flip 7** if they keep flipping
- while flipping three, the chance of **getting through** the flips still to come

Every card button also carries its own chance of being the **next card flipped**,
from the deck as it stands (on a held number, that's the chance of busting on it).
The deck panel adds them up by type, and **Every card →** — or **Card odds** under
More — opens the full table for the cards actually left.

The deck count follows the rules: a finished round's cards are set aside, not
shuffled back, until the deck runs out; then the discards are reshuffled, leaving
the cards in front of players out. The app spots the reshuffle itself — a round
that needed more cards than the deck had left. The score still comes from the
cards, and **Fix the score by hand** opens the end-of-round picker on the same
line. The maths is in `src/live.js`, tested against hand-worked cases in
`test-live.mjs`.

### Play together

Everyone on their own phone. One person starts a room, reads out the four-letter
code (or shares a link that carries it), and everyone else joins and takes a seat.
From then on each player enters their own cards, and the leaderboard, scorecard
and presence dots update for the whole table at once.

**This deployed copy ships with a relay already configured** — join a room and it
just works.

> **Forking?** [`relay.config`](relay.config) in this repository holds *my* relay,
> so a clone built as-is would send your players' scorecards to my Worker. Blank
> that file (or set `RELAY_URL=` when building) for a standalone build, and put
> your own relay there once you have deployed one. Nothing is secret about the
> address — it is baked into the published page — but it should be yours.

Behind the scenes it needs a relay — a small Cloudflare Worker you deploy yourself, in
[`server/`](server/). Paste its address into the app once and it is remembered.
**Without a relay the app is exactly the standalone scorekeeper it was before**;
the networked half is entirely opt-in.

Who may do what is enforced on the server, not merely hidden in the interface:

- The **first phone in the room hosts**. Only the host starts the game, scores a
  round, steps back into a scored one to correct it, deletes a round, changes the
  target, or adds and removes players.
- A **seated player** may edit only their own line, in the round being played. A
  round that is already scored is the host's to correct.
- Anyone else spectates.
- Joining late, or after a phone dies, is fine: reconnecting keeps your seat, and
  the host keeps the host role.

**Not everyone needs a phone.** A seat nobody has taken is the host's to enter, so
the host's screen starts each round with those lines open alongside their own —
everyone else's folds away until tapped.

Each player taps **Submit** when their line is final. That locks it, ticks them
off in the standings, and tells the host who is still out — so nobody scores
the round while someone is halfway through entering. Changing a line withdraws
it again, and the host gets a confirmation naming whoever hasn't submitted if
they score early anyway.

**Share a room** by holding up the QR code, reading out the four letters, or
sending the link. **Rejoin** without any of them: the homepage offers your
ongoing room back when you return, keyed on a random id in your own browser —
not your IP, which the whole table shares. Rooms you have been in are also
listed under **Play together** for as long as the relay keeps them, a week, so
leaving one — or closing the app on the night it was made — is never the same as
losing its code. Drawing that list costs no request; only the room you might
still be sitting in is checked with the relay, and only for the first half day.

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
Chance carry no points, so they're only entered in live mode, for the odds.

Verified against every worked example printed in the rulebook (36 / 72 / 46 / 64, and the
+4 example at 32).

> On **Flip 7 combined with ×2** the app scores `(sum × 2) + bonuses + 15` — the 15 is
> added at step 4, after the doubling at step 2, and the rules state that `×2` doubles
> *number cards*. Worth knowing which way it rules if your table disputes it.

## Running it locally

`index.html` is entirely self-contained: markup, styles, fonts and logic in one
file, with no runtime dependencies and nothing to fetch. Copy it to a machine with
no network at all, open it, and it works. The `package.json` here exists only for
the test suites.

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
| `fonts/`, `tools/make-fonts.mjs` | The two woff2 faces and the script that inlines them into the page |
| `src/fonts.css` | **Generated** — the faces as data URIs |
| `src/app.js` | The interface: rendering, events, storage |
| `src/live.js` | Live mode: a tap to the next entry, what has left the deck, and each player's odds. Pure, so it is tested |
| `src/view.js` | What the interface decides -- who may edit a line, which controls appear, who the round is waiting on. Pure, so it is tested |
| `server/` | The relay: a Worker with one Durable Object per room |
| `build.sh` | Concatenates the sources into the outputs below |
| `index.html` | **Built** — standalone page, open it directly |
| `app.html` | **Built** — same page as a fragment, for embedding in a host that supplies its own `<head>` |
| `relay.config` | The relay baked into the build. Blank = standalone only |
| `test-rules.mjs`, `test-view.mjs`, `test-live.mjs`, `test-app.mjs`, `test-qr.mjs`, `test-build.mjs` | Test suites for the rules core, the interface's decisions, live mode and its odds, the screens themselves, the QR encoder, and the built page |
| `server/test-relay.mjs`, `server/test-ratelimit.mjs` | Test suites against a running relay |
| `package.json` | Test-only dependencies. The app ships with none |
| `.gitlab-ci.yml` | Rebuilds, runs the tests, checks the build and icons aren't stale, deploys Pages |

Edit the files in `src/`, never the built output, then:

```sh
./build.sh
```

To build against a different relay without editing anything:

```sh
RELAY_URL=https://flip7-relay.your-name.workers.dev ./build.sh
```

CI fails the build if `index.html` doesn't match what `src/` produces, so a stale
commit can't ship, and the same for the icons against `tools/make-icons.mjs`.

### One rules engine, two runtimes

`build.sh` also emits `server/src/rules.js`: the same `src/game.js` with an ESM
export appended. The browser scores a round with it and the Worker validates that
round with it, so the two cannot drift. It is generated — don't edit it.

### Tests

```sh
npm install        # jsQR and a reference QR encoder, used by the tests only
npm test           # rules, interface decisions, the screens, QR, and the self-containment check
```

`test-rules.mjs` runs every worked example printed in the rulebook, the states the
rules make impossible, the whole permission model, and that player ids stay
attached to the same person across a roster edit. `test-view.mjs` covers what the
interface decides: who may edit a line, whether the submit control appears, who
the round is waiting on, and what the host is asked before scoring early or
scoring a round of zeros.

`test-app.mjs` drives the screens themselves. `src/app.js` is the DOM and so had
no suite at all, which is where the reported bugs kept coming from -- the last
one being a host who typed the final player, hit start, and began a game without
them. The obstacle was never the logic, it was the browser, so the suite brings
about two hundred lines of one: nodes, a selector engine covering the handful of
selectors the app actually uses, and a fake relay socket that answers a hello and
records every frame sent to it. The app itself is the shipping file, loaded the
same way the other suites load theirs. Two rules keep the shim honest -- a
selector it cannot parse throws instead of matching nothing, and a new test is
run against the code as it was *before* the fix, to watch it fail. A test that
cannot do that is only agreeing with whoever wrote it.

`test-qr.mjs` renders each code
to pixels and decodes it with a real reader across all ten supported versions —
a QR nobody can scan is worse than no QR, so it is never eyeballed.
`test-build.mjs` asserts the built page really is self-contained: both typefaces
embedded as data URIs, the licence notice present, and nothing that fetches
itself from the network.

```sh
cd server && npm install && npx wrangler dev --port 8787 --local --var HOST_GRACE_MS:1500
node server/test-relay.mjs
```

Drives a live Worker with simulated phones over real WebSockets: permissions,
seat handover across a drop, submitting, and that probing a room code doesn't
bring a room into existence.

The `--var` is not optional. A room's life is measured in days and its host grace
in minutes, so the relay reads those timings from its environment and the suite
compresses them; without it, the test that waits for a dead host to be replaced
is skipped and says what to run. That is deliberate — it used to assert a weaker thing
it could check quickly, and passed through two code reviews while the behaviour it
stood in for did not work at all.

The suite exits `2` rather than `0` or `1` when it had to skip something — an
uncompressed clock, or room creation hitting its 3/min limit on a quick re-run.
A test that could not run is neither a pass nor a bug.

```sh
node server/test-ratelimit.mjs
```

Abuse limits. Run deliberately — it burns a minute of quota.

## Working on this

Three whole-codebase reviews have run over this repo, and a pattern worth knowing
about showed up in the results: each round's most serious bugs were in code the
previous round had added, and they clustered in whatever the tests could not
reach. The pure rules core, with the most tests, produced none of them. The
relay's timers and the then-untested interface produced all of them.

That is an argument about where to spend effort, not against changing the code.
Two habits came out of it:

**Write the failing test from the symptom, not from the diagnosis.** Once you
believe you know the cause it is very easy to write a test that agrees with you.
One test in this repo asserted that renaming a player released their seat --
tidy, plausible, and precisely the bug a later review found. It had been written
in the same sitting as the fix it was guarding, so a wrong idea got recorded
twice and then defended itself. Start from what someone actually saw: "Bob
renamed himself and lost his row."

**If the behaviour only happens in time, make the clock an input.** Every serious
bug in the relay has been in code that runs on a timer, and none of them were
visible by reading. A grace period you cannot compress is a grace period nothing
tests, and a test that waits on a proxy instead is worse than no test: it reports
success about something it never checked.


## Privacy

Played on one device, scores live in your browser's `localStorage` and are never
transmitted anywhere. There is no analytics, no tracking, and **no third-party
requests of any kind** — the typefaces are embedded in the page rather than
fetched from a font CDN, so nothing about you reaches anyone. The only external
address in the whole build is the link to the publisher's rules PDF, and that is
an ordinary link: it goes nowhere until you tap it.

**Play together** sends the scorecard to whichever relay you point it at, and
nothing else: names, cards, scores. No accounts, no email, and no identifier
beyond a random per-device string used to remember which seat is yours. You host
the relay, so the data stays with you, and rooms delete themselves a week after
their last action.

The relay keeps four aggregate counters — rooms created, rounds scored, games
finished, and rooms active in the last half hour — readable at
[`/api/stats`](https://flip7-relay.sstangle73.workers.dev/api/stats). They record how much the relay is used and
nothing about who uses it: no names and no scores. Room codes are held for half an
hour purely to count how many rooms are active, and are never returned by the
endpoint — publishing live codes would hand out a list of games to walk into. Playing on one device increments nothing and contacts no server at all.

A security problem goes privately, as [SECURITY.md](SECURITY.md) says, not in an issue.

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
