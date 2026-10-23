# amazon-actual-sync

Splits Amazon charges in Actual Budget into one subtransaction per item, with the
order number in the parent transaction's notes and each item's title in its split's
notes. Categories are left blank intentionally (triage manually in Actual's UI).

Tax, shipping, coupons, discounts, gift cards, and gift wrap are distributed
proportionally across the items in the order so each split's amount reflects a
fair share of the real cost, and the splits always sum exactly to the bank
transaction amount.

## Setup

```
cd amazon-actual-sync
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

One-time interactive Amazon login (handles 2FA via a real browser, then persists
the session so the script itself never needs credentials):

```
amazon-orders login --browser
```

## Running

First, duplicate your Actual budget in the Actual UI (File menu -> Duplicate
Budget) and run against that copy first:

```
set ACTUAL_SERVER_URL=http://192.168.1.168:5006
set ACTUAL_PASSWORD=your-actual-password
set ACTUAL_BUDGET=My Budget (copy)
python -m amazon_actual_sync.cli --year 2026 --dry-run
```

Drop `--dry-run` once you've checked the dry run looks right. Transactions this
script can't confidently handle (no matching charge, ambiguous match, or an
order whose items+adjustments don't reconcile to the charge amount -- e.g. a
multi-shipment order billed in separate charges) are written to
`needs_review.csv` instead of being guessed at.

Transactions that are already split (including ones correctly split via YNAB
before import) or already carry an `AMZN-ORDER:` note are skipped automatically,
so the script can be re-run safely.

Once you've verified the copy looks right, point `ACTUAL_BUDGET` at the real
budget and run again.
