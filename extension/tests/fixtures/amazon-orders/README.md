Fixtures in this folder are copied from the [amazon-orders](https://github.com/alexdlaird/amazon-orders)
test suite (MIT licensed, see `LICENSE-amazon-orders.txt`; synced with upstream as of 2026-10-23), used
to validate our TypeScript port against real (anonymized) Amazon HTML without hitting the live site.

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
