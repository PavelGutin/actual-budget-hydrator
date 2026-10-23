import csv
import datetime
import decimal
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from actual.queries import create_split, get_transactions

from .amazon_fetch import Charge, SessionExpiredError, get_charges_for_order, get_order, get_refund_breakdown
from .distribute import (
    AmbiguousSplitError,
    ReconciliationError,
    compute_item_splits,
    compute_item_splits_from_breakdown,
)
from .match import extract_order_number_from_notes, match_transactions


def _reconciliation_reason(e: ReconciliationError) -> str:
    return "ambiguous_item_match" if isinstance(e, AmbiguousSplitError) else "reconciliation_failed"

ORDER_NOTE_PREFIX = "AMZN-ORDER:"  # legacy format, still recognized for idempotency
ORDER_NOTE_URL_TEMPLATE = "https://www.amazon.com/gp/your-account/order-details?orderID={order_number}"
DEFAULT_PAYEE_SUBSTRINGS = ("amazon", "amzn")


@dataclass
class SyncStats:
    processed: int = 0
    skipped_already_done: int = 0
    unmatched: list = None
    ambiguous: list = None
    reconciliation_failed: list = None

    def __post_init__(self):
        self.unmatched = self.unmatched or []
        self.ambiguous = self.ambiguous or []
        self.reconciliation_failed = self.reconciliation_failed or []


def _is_amazon_payee(name: Optional[str], substrings) -> bool:
    if not name:
        return False
    lowered = name.lower()
    return any(s in lowered for s in substrings)


def _already_processed(txn) -> bool:
    if getattr(txn, "is_parent", 0) == 1:
        return True
    if getattr(txn, "is_child", 0) == 1:
        return True
    notes = txn.notes or ""
    return ORDER_NOTE_PREFIX in notes or "amazon.com/gp/your-account/order-details" in notes


def get_amazon_transactions(
    session,
    year: int,
    payee_substrings=DEFAULT_PAYEE_SUBSTRINGS,
    account_ids: Optional[set] = None,
    uncategorized_only: bool = True,
):
    result = []
    for txn in get_transactions(session):
        if txn.get_date().year != year:
            continue
        if account_ids is not None and txn.account.id not in account_ids:
            continue
        payee_name = txn.payee.name if txn.payee else None
        if not _is_amazon_payee(payee_name, payee_substrings):
            continue
        if _already_processed(txn):
            continue
        if uncategorized_only and txn.category_id is not None:
            continue
        result.append(txn)
    return result


def resolve_item_splits(amazon_session, order, txn_amount_cents: int, refund_event_counts: dict):
    """Compute the item splits for a matched order/transaction, falling back to a
    scraped refund breakdown (ground truth) when the order-level proportional split
    doesn't reconcile and this is the order's only refund event this run."""
    try:
        return compute_item_splits(order, txn_amount_cents)
    except ReconciliationError:
        is_refund = txn_amount_cents > 0
        if not (is_refund and refund_event_counts.get(order.order_number, 0) == 1):
            raise
        breakdown = get_refund_breakdown(amazon_session, order.order_number)
        if breakdown is None:
            raise
        return compute_item_splits_from_breakdown(order, breakdown, txn_amount_cents)


def apply_split(amazon_session, actual_session, txn, order, refund_event_counts: dict, review_rows: list) -> bool:
    txn_amount_cents = round(txn.get_amount() * 100)
    try:
        splits = resolve_item_splits(amazon_session, order, txn_amount_cents, refund_event_counts)
    except ReconciliationError as e:
        review_rows.append(
            {
                "reason": _reconciliation_reason(e),
                "transaction_id": txn.id,
                "date": str(txn.get_date()),
                "amount": str(txn.get_amount()),
                "order_number": order.order_number,
                "detail": str(e),
            }
        )
        return False

    txn.is_parent = 1
    txn.is_child = 0
    txn.category_id = None
    txn.notes = ORDER_NOTE_URL_TEMPLATE.format(order_number=order.order_number)

    for split in splits:
        amount = decimal.Decimal(split.amount_cents) / 100
        child = create_split(actual_session, txn, amount)
        child.notes = split.title
        child.category_id = None

    return True


def run_sync(
    actual,
    amazon_session,
    year: int,
    charges: List[Charge],
    dry_run: bool = False,
    review_csv_path: Optional[str] = None,
    payee_substrings=DEFAULT_PAYEE_SUBSTRINGS,
    cache_dir: Optional[Path] = None,
    account_ids: Optional[set] = None,
    uncategorized_only: bool = True,
) -> SyncStats:
    """`actual` is the `Actual` context object (not just its `.session`) -- committing
    through `actual.commit()` is what actually pushes changes to the server; the raw
    SQLAlchemy session's own `.commit()` only persists to the local sqlite replica."""
    actual_session = actual.session
    stats = SyncStats()
    review_rows: list = []

    print("Scanning transactions...")
    candidate_txns = get_amazon_transactions(
        actual_session, year, payee_substrings, account_ids, uncategorized_only
    )
    print(f"Found {len(candidate_txns)} candidate Amazon transactions to process.")

    # Keyed by (order, sign, amount) -- an order can have several charges of the
    # same sign (e.g. a recurring order reused across billing cycles, or several
    # per-item refunds), so "this order has *a* refund" isn't enough to know we
    # have the *right* one for a given transaction's amount.
    known_order_sign_amount = {(c.order_number, c.is_refund, round(c.grand_total, 2)) for c in charges}
    noted_order_sign_amount = {
        (order_num, txn.get_amount() > 0, round(float(txn.get_amount()), 2))
        for txn in candidate_txns
        if (order_num := extract_order_number_from_notes(getattr(txn, "notes", None))) is not None
    }
    existing_fingerprints = {(c.order_number, c.completed_date, round(c.grand_total, 2), c.is_refund) for c in charges}
    fetched_orders = set()
    for order_num, _is_refund, _amount in noted_order_sign_amount - known_order_sign_amount:
        if order_num in fetched_orders:
            continue
        fetched_orders.add(order_num)
        print(f"Note names order {order_num}, missing a matching charge in cache -- fetching it directly...")
        for c in get_charges_for_order(amazon_session, order_num, cache_dir=cache_dir):
            fingerprint = (c.order_number, c.completed_date, round(c.grand_total, 2), c.is_refund)
            if fingerprint not in existing_fingerprints:
                existing_fingerprints.add(fingerprint)
                charges = charges + [c]

    match_results = match_transactions(candidate_txns, charges)

    refund_event_counts: dict = {}
    for result in match_results:
        if result.charge is not None and result.charge.is_refund:
            order_num = result.charge.order_number
            refund_event_counts[order_num] = refund_event_counts.get(order_num, 0) + 1

    total = len(match_results)
    idx_width = len(str(total))
    for i, result in enumerate(match_results, start=1):
        txn = result.transaction
        prefix = f"[{i:>{idx_width}}/{total}] {txn.get_date()} {txn.get_amount():>10.2f}  "
        print(prefix, end="", flush=True)

        if result.charge is None:
            if result.ambiguous_candidates:
                review_rows.append(
                    {
                        "reason": "ambiguous_match",
                        "transaction_id": txn.id,
                        "date": str(txn.get_date()),
                        "amount": str(txn.get_amount()),
                        "order_number": "",
                        "detail": f"{len(result.ambiguous_candidates)} charges matched equally well",
                    }
                )
            else:
                review_rows.append(
                    {
                        "reason": "no_charge_match",
                        "transaction_id": txn.id,
                        "date": str(txn.get_date()),
                        "amount": str(txn.get_amount()),
                        "order_number": "",
                        "detail": "no Amazon charge found within tolerance",
                    }
                )
            stats.unmatched.append(txn.id)
            print("unmatched")
            continue

        try:
            order = get_order(amazon_session, result.charge.order_number, cache_dir=cache_dir)
        except SessionExpiredError:
            raise
        except Exception as e:
            review_rows.append(
                {
                    "reason": "order_fetch_failed",
                    "transaction_id": txn.id,
                    "date": str(txn.get_date()),
                    "amount": str(txn.get_amount()),
                    "order_number": result.charge.order_number,
                    "detail": f"{type(e).__name__}: {e}",
                }
            )
            stats.unmatched.append(txn.id)
            print("order fetch failed")
            continue

        if dry_run:
            txn_amount_cents = round(txn.get_amount() * 100)
            try:
                splits = resolve_item_splits(amazon_session, order, txn_amount_cents, refund_event_counts)
            except ReconciliationError as e:
                review_rows.append(
                    {
                        "reason": _reconciliation_reason(e),
                        "transaction_id": txn.id,
                        "date": str(txn.get_date()),
                        "amount": str(txn.get_amount()),
                        "order_number": order.order_number,
                        "detail": str(e),
                    }
                )
                stats.reconciliation_failed.append(txn.id)
                label = "AMBIGUOUS ITEM MATCH" if isinstance(e, AmbiguousSplitError) else "RECONCILIATION FAILED"
                print(f"order {order.order_number} {label}: {e}")
                continue
            stats.processed += 1
            print(f"order {order.order_number} (dry run)")
            for j, split in enumerate(splits, start=1):
                branch = "└─" if j == len(splits) else "├─"
                amount = split.amount_cents / 100
                title = split.title if len(split.title) <= 30 else split.title[:29] + "…"
                print(f"    {branch} {amount:>10.2f}  {title}")
            continue

        if apply_split(amazon_session, actual_session, txn, order, refund_event_counts, review_rows):
            stats.processed += 1
            print(f"order {order.order_number} split")
        else:
            stats.reconciliation_failed.append(txn.id)
            print("reconciliation failed")

    if not dry_run:
        actual.commit()

    if review_csv_path and review_rows:
        with open(review_csv_path, "w", newline="") as f:
            writer = csv.DictWriter(
                f, fieldnames=["reason", "transaction_id", "date", "amount", "order_number", "detail"]
            )
            writer.writeheader()
            writer.writerows(review_rows)

    return stats
