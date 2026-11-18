# makefun-token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aliceskyfahriz-cyber/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aliceskyfahriz-cyber/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Launch Radar — a dashboard that ranks every pre-token protocol DefiLlama tracks by what its token launch would be worth. Built for make.fun's “Build the best token launch radar” bounty ($1,325 in USDC, 10 places paid; entries close 14 Dec 2026, 17:00 WIB).

## Run it

```sh
./run.sh
# or directly:
node main.ts
```

Requirements: Node.js 22.18 or later (this machine runs Node 24). No dependencies, no network, no API keys. `main.ts` uses only the Node standard library and runs as `node main.ts` (Node 22 type stripping), exactly as the grader runs `node /bot/main.ts`.

Environment variables (all optional):

- `MAKEFUN_INPUT_DIR` — directory holding `snapshot.json` (default: `./input` next to `main.ts`; also falls back to `./input/snapshot.json`, then `./snapshot.json`).
- `MAKEFUN_OUTPUT_DIR` — where the output goes (default: `./out` next to `main.ts`).
- `MAKEFUN_BOT_DIR` — repository root, used to locate `dashboard/` for the screenshots (default: the directory of `main.ts`).

## Reproduce out/

```sh
rm -rf out && ./run.sh
```

`main.ts` reads `input/snapshot.json` (dev snapshot, see below) and writes:

- `out/index.html` — the dashboard (also kept at `dashboard/index.html`).
- `out/board.json` — the 200-row board with implied values and farm plans.
- `out/dossier.json` — counts, top 10, model and filter summaries.
- `out/board.png`, `out/detail.png`, `out/filtered.png` — copies of the three screenshots from `dashboard/` (taken during development from the real dashboard; `main.ts` reproduces `out/` deterministically, including these PNGs, by copying them — it never generates images itself).

Run it twice and the outputs are byte-identical (no clock, no randomness, sorted iteration).

## How to read the dashboard

Open `dashboard/index.html` (or `out/index.html`) from disk — no server, no network; all CSS and JavaScript are inline and the page requests nothing external.

- **Board:** the table, ranked by implied launch value (not TVL). Columns: rank, protocol, category, chains, TVL, TVL change 1d / 7d / 30d, implied value. “W” marks a watchlist protocol (one of the 40 largest pre-token protocols by TVL).
- **Detail view:** click any row. It shows the protocol's TVL history, the model breakdown (floored TVL, category multiple, momentum, chain diversity, final value) and a farm plan — generic steps to position for a potential launch. Deep link: `index.html#detail=<slug>`.
- **Filtered view:** pick a category or a chain in the bar above the table, or type in the search box — the table narrows and the heading counts the rows. Deep link: `index.html#filter=category:<name>`, `#filter=chain:<name>`, `#filter=q:<text>`.

## How the screenshots were taken

With a headless Chromium (Playwright) at 1600×1000, from the real built dashboard (`dashboard/index.html`):

- `board.png` — the board at the top: `index.html`
- `detail.png` — detail view of the #1 protocol: `index.html#detail=base-bridge`
- `filtered.png` — the board filtered to that protocol's category: `index.html#filter=category:Canonical%20Bridge`

Each PNG is under 5 MB. Copies live in `dashboard/` and in `screenshots/`.

## How the model value is derived

Implied value = `max(TVL, $50M) × category multiple × momentum × chain diversity`. Every input is a snapshot number — no protocol names are hardcoded into the model.

- **Floor:** a protocol with TVL below $50M is modelled as if its TVL were $50M, so small but fast-growing protocols stay on the radar.
- **Category multiple:** the median circulating-market-cap / TVL of live (tokenized) protocols in that category, computed from the public DefiLlama `/protocols` endpoint on 2026-11-19 (111 protocols with usable mcap and TVL; ratios outside [0.01, 50] dropped as bad data). Categories with fewer than 3 live samples use the global median 0.279x. Multiples are clamped to 0.2x–10x. FDV is not published by the free endpoint, so circulating market cap is the observable proxy for FDV; FDV ≥ mcap, so these multiples are conservative (a lower bound on FDV/TVL). Raw medians for categories with n≥3: Basis Trading 0.605 (n=7), Bridge 0.978 (n=5), CEX 0.067 (n=7) → clamped 0.200, Canonical Bridge 0.754 (n=6), Cross Chain Bridge 1.311 (n=4), Dexs 0.326 (n=11), Indexes 0.157 (n=3) → 0.200, Lending 0.155 (n=14) → 0.200, Liquid Staking 0.055 (n=8) → 0.200, Privacy 0.932 (n=3), RWA 0.384 (n=8), Yield 0.239 (n=6), Yield Aggregator 0.148 (n=4) → 0.200.
- **Momentum:** `1 + 0.25×1d growth + 0.25×7d growth + 0.5×30d growth`, each growth clamped to ±100%, the factor clamped to 0.5x–2.0x. Rewards sustained TVL growth, penalises decline.
- **Chain diversity:** `1 + 0.05` per extra chain, capped at 1.5x (11+ chains).

The board is the top 200 pre-token protocols by implied value, with the whole 40-protocol watchlist (largest pre-token by TVL) always covered. On the dev snapshot (737 protocols ≥ $5M TVL, 2026-11-19) the filter finds 210 pre-token protocols, so the board is exactly 200 rows.

## Pre-token filter

A protocol counts as pre-token when all of these hold:

1. `gecko_id` and `symbol` are both empty (`"-"` counts as empty).
2. Category is not Bridge, Wrapped Token, Liquid Staking or Restaking.
3. The name does not end with a version marker (`v2`, `2.0`, `(v3)`, …).
4. The name contains no whole word `wrapped` / `staked` / `staking`.
5. The name does not start with an exchange brand name (Binance, Coinbase, Kraken, Robinhood, Bybit, … — the full list is in `main.ts`).

Filter notes: categories “Canonical Bridge” and “Cross Chain Bridge” pass rule 2 because the spec names only “Bridge” — they are included as the filter's letter dictates, so the board's #1 row on the dev snapshot is Base Bridge (a canonical bridge). Centralised exchanges are caught by rule 5. Farm plans are generic guidance for positioning, not a promise of a token or an airdrop.

## Dev snapshot

`input/snapshot.json` is a development snapshot only and is **not** part of the entry (never commit it). It was built from the public DefiLlama API (`https://api.llama.fi/protocols`, no key) on 2026-11-19, shaped to the competition's 10-field schema (`slug, name, symbol, category, chains, tvl, tvlPrevDay, tvlPrevWeek, tvlPrevMonth, gecko_id`), protocols with TVL ≥ $5M only, with `as_of` and `source` recorded. Two derivations to know about:

- The free endpoint returns no `tvlPrevDay/Week/Month` fields, so `tvlPrevDay` and `tvlPrevWeek` are derived exactly from `change_1d` / `change_7d` (`prev = tvl / (1 + change/100)`), and `tvlPrevMonth` is approximated by compounding the 7-day change (~4.3 weeks). The sealed snapshot the grader uses carries the real fields; `main.ts` reads whatever the snapshot holds.
- The endpoint writes `"-"` for a missing symbol; that is mapped to `null` so the both-empty rule works.

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
