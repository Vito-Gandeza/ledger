# Ledger

Envelope budgeting for instalment loans and credit cards. One static HTML file, no build step,
no build step. Everything you enter is stored in your own browser's `localStorage`; turning on
sync additionally mirrors it to a row in Supabase keyed by a code only you hold.

## What it does

- **Brand colour and logo.** Every wallet and card takes a colour and an optional image, set
  from its edit dialog. Logos are downscaled to 96px before they are stored, so they sync with
  everything else. Unset providers get a suggested colour, or a stable one derived from the name.
- **Wallets with sections.** A main bank wallet holds named sub-sections ("envelopes") whose money
  the main wallet cannot spend until you move it. Reorderable. One section is marked the allowance
  pool — the place your income lands and every top-up is drawn from.
- **Instalment loans.** Weekly, fortnightly or monthly schedules. Link a loan to a section and the
  section reports how far it stretches: `Covers 12/14 · ₱67.55 more covers all 14`.
- **Credit cards.** Drawn as an actual card in the issuer's colour, with your own logo if you
  add one. Log purchases against a limit. Statements are derived from the purchases and a
  statement/due day pair, so a purchase made after the cut-off correctly rolls to the next cycle.
  Partial payments carry the remainder forward.
- **Fund the envelopes.** Given a window, it computes the per-envelope top-up needed, ordered by
  which loan bites first, and applies the transfers in one click.
- **Owed to you.** Debts other people owe you, grouped under a profile per person so several
  debts from the same person stay together. A debt can be linked to the card purchase you
  fronted it on, in which case its amount and description come from that purchase and follow
  any edit to it. Because a card-backed debt is already counted as a liability, the section
  shows your position now against what it becomes once everyone pays — the headline number
  never moves until the money is actually in a wallet.
- **Assume settled.** A switch in the header recomputes every stock of money in the app — net
  position, assets, the weekly projection's opening balance, the pot a wish is measured
  against — as if the debts owed to you had been paid. Off by default, because a figure
  counting money you have not been given yet is a figure that lies. Rates are never touched:
  a repayment is a one-off, not income that arrives every week.
- **Wishlist.** Things you are saving for, each with a progress ring and a date you can
  afford it by. Progress is measured against the total across every wallet, and the rate
  comes from your allowance minus what the schedule already claims, averaged over the
  projection and excluding the overdue backlog, which is a one-off debt rather than a
  weekly cost.
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
