import datetime
import re
from dataclasses import dataclass
from typing import List, Optional

from .amazon_fetch import Charge

DATE_TOLERANCE_DAYS = 5
AMOUNT_TOLERANCE_CENTS = 1

# Matches an Amazon order number embedded in an existing note, e.g. from an older
# tool's "Item Title | (123-4567890-1234567)" format. Treated as ground truth: if a
# transaction already names its order, we trust that over guessing by amount/date.
ORDER_NUMBER_IN_NOTES = re.compile(r"\(([0-9]{3}-[0-9]{7}-[0-9]{7}|[A-Z][0-9]{2}-[0-9]{7}-[0-9]{7})\)")


def extract_order_number_from_notes(notes: Optional[str]) -> Optional[str]:
    if not notes:
        return None
    m = ORDER_NUMBER_IN_NOTES.search(notes)
    return m.group(1) if m else None


@dataclass
class MatchResult:
    transaction: object
    charge: Optional[Charge]
    ambiguous_candidates: List[Charge]


def _amount_matches(txn_amount_cents: int, charge: Charge) -> bool:
    charge_cents = round(charge.grand_total * 100)
    return abs(txn_amount_cents - charge_cents) <= AMOUNT_TOLERANCE_CENTS


def _date_matches(txn_date: datetime.date, charge: Charge) -> bool:
    return abs((txn_date - charge.completed_date).days) <= DATE_TOLERANCE_DAYS


def _pick_best(txn, pool_idx: List[int], charges: List[Charge]) -> tuple:
    """Among `pool_idx` (indices already filtered to a sign/eligibility pool), pick
    the one closest in date, or flag ambiguous if there isn't a single best.
    Returns (chosen_idx_or_None, MatchResult)."""
    if not pool_idx:
        return None, MatchResult(transaction=txn, charge=None, ambiguous_candidates=[])

    if len(pool_idx) == 1:
        return pool_idx[0], MatchResult(transaction=txn, charge=charges[pool_idx[0]], ambiguous_candidates=[])

    txn_date = txn.get_date()
    pool_idx = sorted(pool_idx, key=lambda i: abs((txn_date - charges[i].completed_date).days))
    best, second = pool_idx[0], pool_idx[1]
    if abs((txn_date - charges[best].completed_date).days) < abs((txn_date - charges[second].completed_date).days):
        return best, MatchResult(transaction=txn, charge=charges[best], ambiguous_candidates=[])

    return None, MatchResult(
        transaction=txn, charge=None, ambiguous_candidates=[charges[i] for i in pool_idx]
    )


def match_transactions(transactions, charges: List[Charge]) -> List[MatchResult]:
    used: set = set()
    charges_by_order: dict = {}
    for i, c in enumerate(charges):
        charges_by_order.setdefault(c.order_number, []).append(i)

    results = {}
    deferred = []

    # Phase 1: trust an order number already embedded in the transaction's notes.
    for txn in transactions:
        txn_amount_cents = round(txn.get_amount() * 100)
        note_order = extract_order_number_from_notes(getattr(txn, "notes", None))
        if not note_order:
            deferred.append(txn)
            continue

        order_pool_idx = [
            i
            for i in charges_by_order.get(note_order, [])
            if i not in used and charges[i].is_refund == (txn_amount_cents > 0)
        ]
        # The note tells us which order, but an order can have several charges of
        # the same sign (e.g. two separate per-item refunds) -- amount still picks
        # out which specific one this transaction is.
        pool_idx = [i for i in order_pool_idx if _amount_matches(txn_amount_cents, charges[i])]
        if not pool_idx:
            # The note names an order, but nothing in it (at this sign) matches the
            # transaction's amount -- stale/wrong note, or a genuinely different
            # situation. Fall back to the ordinary amount/date heuristic.
            deferred.append(txn)
            continue

        chosen_idx, result = _pick_best(txn, pool_idx, charges)
        if chosen_idx is not None:
            used.add(chosen_idx)
        results[id(txn)] = result

    # Phase 2: ordinary amount/date matching for everything left.
    for txn in deferred:
        txn_amount_cents = round(txn.get_amount() * 100)
        txn_date = txn.get_date()
        pool_idx = [
            i
            for i, c in enumerate(charges)
            if i not in used
            and c.is_refund == (txn_amount_cents > 0)
            and _amount_matches(txn_amount_cents, c)
            and _date_matches(txn_date, c)
        ]
        chosen_idx, result = _pick_best(txn, pool_idx, charges)
        if chosen_idx is not None:
            used.add(chosen_idx)
        results[id(txn)] = result

    return [results[id(txn)] for txn in transactions]
