Fixtures in this folder are copied from the [amazon-orders](https://github.com/alexdlaird/amazon-orders)
test suite (MIT licensed, see `LICENSE-amazon-orders.txt`; synced with upstream as of 2026-11-01), used
to validate our TypeScript port against real (anonymized) Amazon HTML without hitting the live site.
**Every file here should be byte-identical to upstream's own `tests/resources/` tree** -- verify with
a diff against a fresh clone before adding or editing anything, since this folder has held a stray
non-upstream capture before (see below) without anyone noticing until it was diffed directly.

`golden.json` is upstream's own parse output for every US order/transaction fixture here, produced by
running upstream's parser (`generate_golden.py`, instructions inside). `tests/upstream-golden.test.ts`
checks our port against it field by field: order number, details link, placed date, grand total,
cancelled / Whole Foods flags, item count, every subtotal row (subtotal, shipping, free shipping,
promotion, coupon, reward points, Subscribe & Save, total before tax, tax, refund total, multibuy,
Amazon discount, gift card, gift wrap), and each item's title, price and quantity. Regenerate it when
re-syncing selectors with upstream.

Intentional differences from upstream:
- History cards: we also accept the live (Oct 2026) plain `a[href*='/your-orders/order-details']`
  link, and read the order number from the card's `data-csa-c-slot-id` when a card stays encrypted.
- Item quantity: we also read the live `[data-component='quantity']` slot.
- Refund breakdown (`#a-popover-orderRefundBreakdown` / `data-a-popover` `inlineContent`) comes from
  the Python CLI's `refund_scrape.py`, not upstream.

**Not ported:** the legacy server-rendered Transactions page (no `script#__NEXT_DATA__`; e.g.
`transactions-refunded.html`), order-history pagination (page 1 only -- transactions drive the scan),
recipients/shipments/sellers/payment method on orders, non-US sites and currency formats.

**2026-11-01 resync notes:**
- `order-history-2024-0.html` is gone -- the file that lived here under that name was a stray
  6889-line raw capture (a real session, not upstream's content: upstream's actual file by that
  name is an 899-line UK-locale (`lang="en-gb"`) snippet). Confirmed via byte-diff against upstream
  that this was the *only* file in this folder that didn't match; every other file here (including
  the other `AUAUY1LDHBTER`-containing snippets, which are upstream's own long-public test data, not
  ours) is a verified exact copy. Dropped rather than kept, since it's non-US anyway and out of
  scope per the line above.
- Added two new upstream snippets added since the last sync: `order-history-entire-family-snippet.html`,
  `order-history-household-members-snippet.html`.
- We previously tried adding our own real-capture-derived (sanitized) fixtures here for extra
  coverage upstream doesn't have. Abandoned: sanitizing real personal data thoroughly enough to
  trust in a public repo turned out to be harder than it looked -- five rounds of independent
  review each found a new leak category the previous round missed. Don't retry this without a
  very good reason; prefer asking upstream to add the case, or finding/crafting synthetic markup
  (see `tests/amazon-live-markup.test.ts` for the pattern) instead.
