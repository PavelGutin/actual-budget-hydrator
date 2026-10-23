import math
from dataclasses import dataclass
from typing import List, Optional


class ReconciliationError(Exception):
    """Raised when an order's items + adjustments can't be reconciled to the matched
    transaction amount within tolerance. These orders should be queued for manual
    review rather than guessed at."""


class AmbiguousSplitError(ReconciliationError):
    """Raised when more than one distinct combination of items matches the target
    amount equally well (e.g. two items happen to share the same price). Which
    item(s) were actually involved can't be determined, so this must not be guessed
    at -- it's queued for manual review instead."""

    def __init__(self, message: str, candidate_combos: List[List[str]]):
        super().__init__(message)
        self.candidate_combos = candidate_combos


@dataclass
class ItemSplit:
    title: str
    amount_cents: int


RECONCILIATION_TOLERANCE_CENTS = 2


def _to_cents(amount) -> int:
    if amount is None:
        return 0
    return round(amount * 100)


def _allocate_proportional(weights: List[int], total_cents: int) -> List[int]:
    """Allocate integer `total_cents` across entries proportional to `weights`
    (all non-negative), using the largest-remainder method. `total_cents` may be
    negative (e.g. a discount); the sign is applied uniformly to the result."""
    n = len(weights)
    if n == 0:
        return []

    sign = -1 if total_cents < 0 else 1
    magnitude = abs(total_cents)
    weight_sum = sum(weights)

    if weight_sum == 0:
        base = magnitude // n
        remainder = magnitude - base * n
        return [sign * (base + (1 if i < remainder else 0)) for i in range(n)]

    raw = [magnitude * w / weight_sum for w in weights]
    floors = [math.floor(r) for r in raw]
    remainder = magnitude - sum(floors)

    order_by_frac = sorted(range(n), key=lambda i: raw[i] - floors[i], reverse=True)
    shares = floors[:]
    for i in range(remainder):
        shares[order_by_frac[i]] += 1

    return [sign * s for s in shares]


ADDITION_FIELDS = ("estimated_tax", "shipping_total", "gift_wrap")
REDUCTION_FIELDS = (
    "free_shipping",
    "promotion_applied",
    "coupon_savings",
    "subscription_discount",
    "multibuy_discount",
    "amazon_discount",
    "reward_points",
    "gift_card",
)

MAX_ITEMS_FOR_SUBSET_SEARCH = 25


def _compute_full_order_splits(order, sign: int) -> List[ItemSplit]:
    """Distribute an Amazon order's items + order-level adjustments (tax, shipping,
    coupons, discounts, gift cards, gift wrap) across the order's line items, using
    the order's own total (not any particular matched transaction). `sign` is -1 for
    a charge, 1 for a refund; returned amounts carry that sign."""
    items = [item for item in order.items if item.price is not None]
    if not items:
        raise ReconciliationError(f"Order {order.order_number} has no priced items")

    base_cents = [_to_cents(item.price) * (item.quantity or 1) for item in items]

    adjustment_cents = 0
    for field in ADDITION_FIELDS + REDUCTION_FIELDS:
        adjustment_cents += _to_cents(getattr(order, field, None))

    signed_base_cents = [sign * c for c in base_cents]
    adjustment_shares = _allocate_proportional(base_cents, adjustment_cents * sign)

    final_cents = [b + a for b, a in zip(signed_base_cents, adjustment_shares)]

    return [
        ItemSplit(title=item.title, amount_cents=amount)
        for item, amount in zip(items, final_cents)
    ]


def _find_item_subset(
    full_splits: List[ItemSplit], target_cents: int, tolerance: int
) -> Optional[List[ItemSplit]]:
    """Find the subset of `full_splits` whose amounts sum to `target_cents` within
    `tolerance` -- for a transaction that only covers some of an order's items (e.g.
    a per-item partial refund). Returns None if no subset matches, or the order has
    too many items to search. Assumes every amount shares `target_cents`'s sign.

    Raises `AmbiguousSplitError` if more than one distinct combination of items
    matches equally well (e.g. two items share the same price) -- which one was
    actually involved can't be determined, so this isn't guessed at."""
    n = len(full_splits)
    if n == 0 or n > MAX_ITEMS_FOR_SUBSET_SEARCH:
        return None

    amounts = [abs(s.amount_cents) for s in full_splits]
    target_abs = abs(target_cents)

    # Each achievable sum keeps up to 2 distinct combos reaching it -- enough to
    # detect a tie without the cost of tracking every combination.
    achievable: dict = {0: [()]}
    for idx, amt in enumerate(amounts):
        for s in list(achievable.keys()):
            new_sum = s + amt
            if new_sum > target_abs + tolerance:
                continue
            new_combo = achievable[s][0] + (idx,)
            combos = achievable.setdefault(new_sum, [])
            if len(combos) < 2 and not any(set(new_combo) == set(c) for c in combos):
                combos.append(new_combo)

    best = None
    for s, combos in achievable.items():
        first = combos[0]
        if not first or len(first) == n:
            continue
        if abs(s - target_abs) <= tolerance:
            if best is None or abs(s - target_abs) < abs(best[0] - target_abs):
                best = (s, combos)

    if best is None:
        return None

    _, combos = best
    if len(combos) > 1:
        raise AmbiguousSplitError(
            f"multiple distinct item combinations match amount {target_cents/100:.2f}: "
            + " vs ".join(
                "+".join(full_splits[i].title for i in combo) for combo in combos
            ),
            candidate_combos=[[full_splits[i].title for i in combo] for combo in combos],
        )

    return [full_splits[i] for i in combos[0]]


def compute_item_splits(order, transaction_amount_cents: int) -> List[ItemSplit]:
    """Distribute an Amazon order's items + order-level adjustments across the
    items covered by the matched Actual transaction, so the resulting per-item
    amounts sum exactly to `transaction_amount_cents`.

    If the transaction covers the whole order, every item is returned. If it only
    covers some of the order (e.g. a per-item partial refund), the subset of items
    whose proportional share matches the transaction amount is returned instead.

    `transaction_amount_cents` carries the sign convention of the matched Actual
    transaction (negative for an expense). Returned amounts carry the same sign.
    """
    sign = -1 if transaction_amount_cents < 0 else 1
    full_splits = _compute_full_order_splits(order, sign)

    target = transaction_amount_cents

    # With exactly one item, there's nothing to allocate between items -- whatever
    # the amount is (a full charge, a prorated partial refund, anything), it's all
    # that one item's. No subset search or whole-order check is meaningful here.
    if len(full_splits) == 1:
        return [ItemSplit(title=full_splits[0].title, amount_cents=target)]

    full_total = sum(s.amount_cents for s in full_splits)

    # Whether this transaction covers the *whole* order is decided against the
    # order's own authoritative total (order.grand_total), not our reconstruction
    # of it from named adjustment fields -- Amazon sometimes applies a discount or
    # adjustment the library doesn't expose as a named field, so our reconstructed
    # total can be off even for a genuine whole-order event. When that happens, any
    # gap between the two is real but unlabeled, and gets absorbed into the largest
    # item rather than misread as a partial/per-item transaction.
    order_grand_total = getattr(order, "grand_total", None)
    is_whole_order = abs(target - full_total) <= RECONCILIATION_TOLERANCE_CENTS
    if not is_whole_order and order_grand_total is not None:
        is_whole_order = abs(target - sign * _to_cents(order_grand_total)) <= RECONCILIATION_TOLERANCE_CENTS

    if is_whole_order:
        diff = target - full_total
        final_splits = full_splits
        if diff != 0:
            largest_idx = max(range(len(final_splits)), key=lambda i: abs(final_splits[i].amount_cents))
            final_splits = list(final_splits)
            final_splits[largest_idx] = ItemSplit(
                title=final_splits[largest_idx].title,
                amount_cents=final_splits[largest_idx].amount_cents + diff,
            )
        return final_splits

    diff = target - full_total

    subset = _find_item_subset(full_splits, target, RECONCILIATION_TOLERANCE_CENTS)
    if subset is not None:
        subset_diff = target - sum(s.amount_cents for s in subset)
        if subset_diff != 0:
            largest_idx = max(range(len(subset)), key=lambda i: abs(subset[i].amount_cents))
            subset = list(subset)
            subset[largest_idx] = ItemSplit(
                title=subset[largest_idx].title,
                amount_cents=subset[largest_idx].amount_cents + subset_diff,
            )
        return subset

    raise ReconciliationError(
        f"Order {order.order_number}: items+adjustments total "
        f"{full_total/100:.2f} but matched transaction is "
        f"{target/100:.2f} (diff {diff/100:.2f}); no subset of items matches either; "
        f"needs manual review"
    )


def compute_item_splits_from_breakdown(order, breakdown, transaction_amount_cents: int) -> List[ItemSplit]:
    """Like `compute_item_splits`, but for a partial refund whose order-level
    proportional split didn't reconcile. Uses a scraped `RefundBreakdown` (the order
    summary page's "Item(s) refund" / "Tax refund" / etc. figures, which are ground
    truth rather than a guess) to find exactly which items this refund covers, then
    distributes the breakdown's other components (tax, etc.) across just those items.

    Only correct when the order has had exactly one refund event (the breakdown is a
    cumulative total across all of an order's refunds, so it can't disambiguate more
    than one) -- callers are responsible for checking that.
    """
    items = [item for item in order.items if item.price is not None]
    if not items:
        raise ReconciliationError(f"Order {order.order_number} has no priced items")

    base_cents = [_to_cents(item.price) * (item.quantity or 1) for item in items]
    item_splits = [ItemSplit(title=item.title, amount_cents=c) for item, c in zip(items, base_cents)]

    subset = _find_item_subset(item_splits, breakdown.item_refund_cents, RECONCILIATION_TOLERANCE_CENTS)
    if subset is None and breakdown.item_refund_cents == sum(base_cents):
        subset = item_splits
    if subset is None:
        raise ReconciliationError(
            f"Order {order.order_number}: scraped refund breakdown's item total "
            f"{breakdown.item_refund_cents/100:.2f} doesn't match any subset of item prices; "
            f"needs manual review"
        )

    subset_weights = [s.amount_cents for s in subset]
    other_total_cents = sum(breakdown.other_cents.values())
    other_shares = _allocate_proportional(subset_weights, other_total_cents)

    sign = -1 if transaction_amount_cents < 0 else 1
    final_cents = [sign * (w + a) for w, a in zip(subset_weights, other_shares)]

    target = transaction_amount_cents
    diff = target - sum(final_cents)
    if abs(diff) > RECONCILIATION_TOLERANCE_CENTS:
        raise ReconciliationError(
            f"Order {order.order_number}: scraped refund breakdown total "
            f"{breakdown.total_cents/100:.2f} doesn't match matched transaction "
            f"{target/100:.2f}; needs manual review"
        )
    if diff != 0:
        largest_idx = max(range(len(final_cents)), key=lambda i: abs(final_cents[i]))
        final_cents[largest_idx] += diff

    return [ItemSplit(title=s.title, amount_cents=amount) for s, amount in zip(subset, final_cents)]
