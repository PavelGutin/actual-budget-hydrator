# actual-budget-hydrator

Hydrates [Actual Budget](https://actualbudget.org/) transactions with item-level data from retail
order history, starting with Amazon.

Two tools, same goal, different tradeoffs:

- **[`cli/`](cli/)** -- a Python CLI (`amazon-actual-sync`) that talks to a self-hosted Actual
  server directly, authenticating to Amazon via a saved `amazon-orders` session. Working today.
- **[`extension/`](extension/)** -- a browser extension (early spike, not yet installable) that
  instead runs in-browser, reusing your already-authenticated Amazon session and writing to Actual
  through its own in-page API, with a review step before anything is applied. Targets Firefox
  first; Chrome support is a nice-to-have.

The extension's retailer-parsing and matching/splitting logic is being built and proven against
real (anonymized) HTML fixtures and unit tests before it ever touches live Amazon -- see
`extension/tests/`. Ported so far: order-detail parsing, transaction-history parsing (modern
Next.js page shape), order-history parsing, order/transaction matching (`src/matching/`), and
proportional item-split computation (`src/splitting/`) -- the full decision logic of the Python
CLI, minus the network/session layer that actually talks to Amazon. That's the next, and first
live-Amazon-touching, piece.
