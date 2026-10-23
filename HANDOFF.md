# Handoff: moving to live Amazon work (Claude Desktop + computer use)

Written 2026-10-23 at the end of a Claude Code CLI session, to hand off to a Claude Desktop
session that will use computer-use to drive Firefox against the user's real, logged-in Amazon
session.

## What this project is

Hydrates Actual Budget transactions with item-level data from Amazon order history. Two tools,
same repo (`actual-budget-hydrator`, GitHub: PavelGutin/actual-budget-hydrator, branch `trunk`):

- `cli/` — working Python tool, talks to self-hosted Actual + authenticates to Amazon via the
  `amazon-orders` PyPI package (session cookies + 2FA, has its own anti-bot/WAF handling).
- `extension/` — new browser extension (WXT, Firefox-first, Chrome nice-to-have). Reuses the
  browser's already-authenticated Amazon session instead of its own login/anti-bot code. Will
  write to Actual via `actual-budget-tweaks`'s bridge technique (in-page `CustomEvent`s calling
  Actual's own `window.$q`/`$send` API — see that project for reference, not copied in here).

## What's done (all pure logic, zero live Amazon calls, all tested against static fixtures)

In `extension/src/`:
- `retailers/amazon/` — ported parsers for order-detail pages, order-history list pages, and the
  *modern* (Next.js `__NEXT_DATA__`) transactions page. NOT the legacy transactions page (no
  `__NEXT_DATA__` tag) — unported, logged as a gap.
- `matching/match.ts` — matches Actual transactions to Amazon charges by order-number-in-notes
  first, then amount+date heuristics.
- `splitting/compute-item-splits.ts` — proportionally distributes tax/shipping/discounts across
  line items, handles whole-order vs. partial-subset (refund) cases.

37/37 tests pass (`cd extension && npx vitest run`). Ground truth for fixtures comes from the
upstream `amazon-orders` Python project's own test assertions (see
`extension/tests/fixtures/amazon-orders/README.md` for attribution + the full "known gaps" list).

This is the *entire decision-making core* of the Python CLI, re-implemented in TypeScript, minus
the network/session layer that actually talks to Amazon.

## What's NOT done — this is the next task

The extension has no manifest, no background script, no content script, no UI, and has never
fetched a real page. The next piece is exactly that: fetching live Amazon pages (order history,
order details, transactions) from within the extension context, using the user's real browser
session, and feeding the HTML into the already-ported parsers above to see if they still match
real-world markup (Amazon's HTML may have drifted from the amazon-orders fixtures, which could be
a couple years old).

Suggested first steps for the Desktop/computer-use session:
1. Open Firefox, navigate to `https://www.amazon.com/gp/css/order-history` (or the Transactions
   page) while logged in as the user.
2. Capture the live HTML (e.g. via view-source, or by having the user paste it, or by any
   dev-tools-based extraction computer-use can do) and compare its structure against
   `extension/src/retailers/amazon/selectors.ts` — confirm the selectors still match, especially
   `ORDER_HISTORY_ENTITY_SELECTOR`, `FIELD_ORDER_DETAILS_LINK_SELECTOR`, and the
   `__NEXT_DATA__` transactions shape.
3. Only after confirming real markup matches (or fixing the selectors if it's drifted) should any
   extension scaffolding (manifest.json / WXT entrypoints, background fetch) get built — no point
   wiring up fetch plumbing against selectors that might already be stale.
4. Be mindful of anti-bot risk: this is the user's real account. Avoid rapid/repeated page loads;
   normal human-paced browsing is the point of doing this from a real logged-in browser instead of
   a scripted `requests` session.

## Things to NOT do

- Don't commit anything under `cli/.cache/` or `cli/needs_review.csv` if they ever reappear —
  these contain the user's real personal purchase/transaction history and are gitignored
  deliberately.
- Don't enter the user's Amazon password or 2FA codes yourself — the user is already logged in;
  this work only ever reads pages in their session.
- Legacy (non-Next.js) transactions page, order-history pagination, remaining discount fields,
  refund-breakdown fallback, and Temu support are all explicitly deferred — don't scope-creep into
  them unless asked.

## Repo location

Local clone: `C:\Users\Pasha\python_stuff\actual-budget-hydrator` (Windows machine). If Desktop
computer-use is on the same machine, this path is directly usable. If not, clone from
`https://github.com/PavelGutin/actual-budget-hydrator`.
