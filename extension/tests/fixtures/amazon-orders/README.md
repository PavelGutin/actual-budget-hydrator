Fixtures in this folder are copied from the [amazon-orders](https://github.com/alexdlaird/amazon-orders)
test suite (MIT licensed, see `LICENSE-amazon-orders.txt`), used here only to validate our own
TypeScript port of its order-detail parsing against real (anonymized) Amazon HTML, without hitting
the live site. Ground-truth values for each fixture come from that project's test assertions
(`tests/testcase.py`), not from us re-deriving them.
