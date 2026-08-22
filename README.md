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
- **Light and dark**, following your device.

## Two ways to score a round

| Mode | For |
| --- | --- |
| **Whole table** | One scorekeeper. Every player's picker is open at once; fold each one away as you enter it. |
| **Pass the phone** | One player on screen at a time, with a seat strip showing who's done and what they scored, and a hand-off button naming who's next. |

Entries are shared between the modes, so you can switch mid-round.

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
| `src/app.js` | All the logic |
| `build.sh` | Concatenates the two into the outputs below |
| `index.html` | **Built** — standalone page, open it directly |
| `app.html` | **Built** — same page as a fragment, for embedding in a host that supplies its own `<head>` |
| `.gitlab-ci.yml` | Rebuilds, checks the committed build isn't stale, deploys Pages |

Edit the files in `src/`, never the built output, then:

```sh
./build.sh
```

CI fails the build if `index.html` doesn't match what `src/` produces, so a stale commit
can't ship.

## Privacy

Scores live in your browser's `localStorage` and are never transmitted anywhere. There is
no analytics, no tracking, and no backend. The page makes exactly one third-party request —
fonts from Google Fonts — and the rules link points at the publisher's own PDF; nothing
else leaves your device.

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

## Credits

- **Eric Olsen** — designer of Flip 7
- **The Op / USAopoly, Inc.** — publisher
- This scorekeeper — built by [Steven Storie](https://gitlab.com/sstangle73)
