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

The extension's retailer-parsing logic is being built and proven against real (anonymized) HTML
fixtures before it ever touches live Amazon -- see `extension/tests/fixtures/amazon-orders/`.
