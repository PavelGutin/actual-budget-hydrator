Fixtures in this folder are copied from the [amazon-orders](https://github.com/alexdlaird/amazon-orders)
test suite (MIT licensed, see `LICENSE-amazon-orders.txt`), used here only to validate our own
TypeScript port of its order-detail parsing against real (anonymized) Amazon HTML, without hitting
the live site. Ground-truth values for each fixture come from that project's test assertions
(`tests/testcase.py` and `tests/unit/test_*.py`), not from us re-deriving them.

**Known gaps (not yet ported):** the legacy server-rendered Transactions page (no
`script#__NEXT_DATA__` tag -- see `transactions-refunded.html`, which uses this older shape);
order-history list parsing/pagination; the remaining Order discount fields (promotion, gift card,
multibuy, free shipping, `combine_multiple` for repeated rows); non-US currency formats.
