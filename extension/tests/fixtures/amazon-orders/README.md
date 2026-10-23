Fixtures in this folder are copied from the [amazon-orders](https://github.com/alexdlaird/amazon-orders)
test suite (MIT licensed, see `LICENSE-amazon-orders.txt`), used here only to validate our own
TypeScript port of its order-detail parsing against real (anonymized) Amazon HTML, without hitting
the live site. Ground-truth values for each fixture come from that project's test assertions
(`tests/testcase.py` and `tests/unit/test_*.py`), not from us re-deriving them.

**Known gaps (not yet ported):** the legacy server-rendered Transactions page (no
`script#__NEXT_DATA__` tag -- see `transactions-refunded.html`, which uses this older shape);
order-history pagination (summary fields for one page are parsed; "next page" link / "fetch more"
isn't wired up yet); the remaining Order discount fields (promotion, gift card, multibuy, free
shipping, `combine_multiple` for repeated rows); the refund-breakdown fallback path
(`compute_item_splits_from_breakdown` in the Python tool, for a partial refund whose order-level
proportional split doesn't reconcile -- depends on `refund_scrape.py`, not ported); non-US currency
formats.
