# actual-budget-hydrator

A browser extension that hydrates [Actual Budget](https://actualbudget.org/) transactions with
item-level data from retail order history, starting with Amazon.

Companion project to [amazon-actual-sync](https://github.com/PavelGutin/amazon-actual-sync) (a
Python CLI that does the same thing via a self-hosted Actual server) — this one runs as a browser
extension, reusing the browser's already-authenticated retailer session and talking to Actual
directly through its own in-page API, with a review step before anything is written.

Targets Firefox first (easier permanent self-install for a personal tool); Chrome support is a
nice-to-have.

## Status

Early spike, not yet an extension. Currently validating that Amazon's order-detail HTML can be
parsed in TypeScript (`src/retailers/amazon/`) with the same accuracy as the Python
[amazon-orders](https://github.com/alexdlaird/amazon-orders) library, which the Python-side tool
depends on, tested against fixtures borrowed from that project's (MIT-licensed) test suite — see
`tests/fixtures/amazon-orders/README.md`.

```
npm install
npm test
```
