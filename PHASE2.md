# Phase 2 — readable hostnames

Not implemented. This is a costed design for replacing the random hostname
suffix with readable words, kept so the analysis does not have to be redone.

## Current behaviour

```
linky-k4d8vn.example.com
```

Six characters from `abcdefghijkmnpqrstuvwxyz23456789` — 32 symbols, with `l`,
`o`, `0` and `1` excluded because they are ambiguous read aloud or from a
screenshot. That gives 32⁶ = **1,073,741,824** combinations.

## Proposed

```
linky-the-beefy-blue-comely-crane-7.example.com
```

`HOSTNAME_PREFIX` becomes `linky-the`, followed by four words from disjoint
categories and a single digit:

| Slot | Category | Size | Examples |
| --- | --- | --- | --- |
| 1 | size, shape, build | 96 | `big`, `beefy`, `craggy`, `knobbly`, `towering`, `spindly` |
| 2 | colour | 65 | `crimson`, `teal`, `azure`, `ochre`, `mauve`, `apricot` |
| 3 | manner, character | 110 | `leaping`, `dapper`, `wily`, `plucky`, `sprightly` |
| 4 | animal | 265 | `aardvark`, `capybara`, `kookaburra`, `pangolin`, `quokka` |
| 5 | digit | 10 | `0`–`9` |

96 × 65 × 110 × 265 × 10 = **1,818,960,000**

## Why the digit matters

Words alone fall well short of the current entropy. The digit is what makes the
scheme a net improvement rather than a trade.

| Scheme | Combinations | vs current | Full sweep at 1k req/s |
| --- | --- | --- | --- |
| Words only | 181,896,000 | 0.17× | 2 days |
| **Words + 1 digit** | **1,818,960,000** | **1.69×** | **21 days** |
| Words + 2 digits | 18,189,600,000 | 16.9× | 211 days |
| Current, 6 chars | 1,073,741,824 | 1.00× | 12 days |

Enumeration is the property that matters, not collisions. Static assets are
served without a password and bypass paths are fully public, so the hostname is
the only thing protecting them — a namespace someone can sweep in two days is a
real regression, and one they cannot is not.

Collisions are a non-issue either way: with a digit, a 50% chance of the first
collision arrives at roughly 50,000 sites.

A digit is preferred over a letter-or-digit (which would give 5.42×) for the same
reason `l` and `o` are excluded today: a digit is unambiguous read aloud.
`-7` rather than `crane7`, because a digit glued to a word reads like a typo.

## Length

DNS labels are limited to 63 characters.

```
linky-the-  +  4 words  +  3 dashes  +  -7   =  15 chars of overhead
```

So the four words may total 48 characters, and the worst case has to hold even
though all four longest words landing together is rare.

| Word cap | Worst-case label | Margin |
| --- | --- | --- |
| 10 | 55 | 8 |
| 11 | 59 | 4 |
| 12 | 63 | 0 |
| 13 | 67 | **exceeds** |

**A 10-character cap is the recommendation**, and it costs almost nothing.
Relaxing it to 12 admits only 10 more words across all four categories
(`cylindrical`, `industrious`, `hippopotamus`, `grasshopper` and similar) for a
**1.07×** entropy gain, in exchange for all the length margin. These categories
are naturally short.

Note that colour is the ceiling on the whole scheme: 65 is about as far as
one-word colours go before reaching paint-chart names nobody recognises. Animals
are the only slot with real headroom — 265 could reach 400+ without getting
obscure, which alone would take the total past 2.7 billion.

## What it touches

| File | Change |
| --- | --- |
| `src/util.js` | Replace three lines in `randomSlug`, add four wordlists (~80 lines of data) |
| `src/index.js` | Nothing — it already calls `randomSlug(prefix)` |
| `wrangler.example.toml` | `HOSTNAME_PREFIX = "linky-the"`, reword the comment |
| `test/util.test.mjs` | One assertion: `/^linky-[a-z0-9]{6}$/` becomes the new shape |
| `README.md`, `SETUP.md` | Example hostnames |

Roughly an hour, most of it curating wordlists.

## Tests it would need

Three properties would otherwise rot silently:

- **Disjointness.** `sturdy` legitimately belongs in both adjective categories,
  and `salmon` and `coral` are both colours and animals. Overlaps have to be
  removed by a deliberate, tested ordering, or the generator will eventually emit
  `linky-the-big-salmon-sly-salmon`.
- **The length cap.** Every word ≤ 10 characters, asserted over the lists rather
  than trusted, so the worst case cannot drift past 63.
- **No repeated word** within one hostname, for the same reason as disjointness.

The existing generator needs none of these, which is the honest cost of the
change: more vocabulary means more invariants to hold.

## Not needed

A collision-retry loop. With a digit the collision point is far beyond any
plausible number of sites, so provisioning can keep assuming a fresh name — as
it does today.

## Open questions

- Whether `linky-the-` is worth ten characters of every hostname, or whether
  `linky-` reads well enough with word suffixes.
- Whether the digit should be excluded from `0` and `1`, for consistency with the
  current alphabet's reasoning. It would cost 20% of the entropy and is probably
  unnecessary, since a lone digit in a known position is not easily confused.
