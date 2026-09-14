# Ledger

Envelope budgeting for instalment loans and credit cards. One static HTML file, no build step,
no build step. Everything you enter is stored in your own browser's `localStorage`; turning on
sync additionally mirrors it to a row in Supabase keyed by a code only you hold.

## What it does

- **Wallets with sections.** A main bank wallet holds named sub-sections ("envelopes") whose money
  the main wallet cannot spend until you move it. Reorderable. One section is marked the allowance
  pool — the place your income lands and every top-up is drawn from.
- **Instalment loans.** Weekly, fortnightly or monthly schedules. Link a loan to a section and the
  section reports how far it stretches: `Covers 12/14 · ₱67.55 more covers all 14`.
- **Credit cards.** Log purchases against a limit. Statements are derived from the purchases and a
  statement/due day pair, so a purchase made after the cut-off correctly rolls to the next cycle.
  Partial payments carry the remainder forward.
- **Fund the envelopes.** Given a window, it computes the per-envelope top-up needed, ordered by
  which loan bites first, and applies the transfers in one click.
- **Payment timeline.** A month calendar with per-loan colour dots and per-day totals. Tap a day
  for its breakdown.
- **Projection chart.** Eight weeks of closing balance as a column chart above the weekly rows.
- **Safe to spend.** Allowance left after every envelope is topped up before the next allowance lands.
- **Weekly outlook.** Eight rolling weeks, each expandable into the payments that make up its
  cost. Week one carries everything already overdue, and an allowance is only counted as
  incoming income while it has not been claimed — a claimed one already sits in the balance.

## Running it

Open `index.html`. That is all — there is no toolchain.

Deployed as a static site it also works offline and installs to a home screen (service worker +
web manifest). On iOS: Share → Add to Home Screen.

## Data

- **Export backup** writes a `ledger-<date>.json` file.
- **Import** reads one back, on any device.
- There is no sync. One device is the source of truth; move the JSON file to the others.
- `*.json` is gitignored so a backup can never be committed by accident.

## Tests

The money and date logic has assertions built in. Open `index.html?test` and read the console —
every line should start with `ok:`. It covers month-end clamping, statement-cycle boundaries,
envelope coverage, rounding, and schema migration.
