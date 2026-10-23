import datetime
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List, Optional

from amazonorders.exception import AmazonOrdersError, AmazonOrdersNotFoundError
from amazonorders.session import AmazonSession
from amazonorders.orders import AmazonOrders
from amazonorders.transactions import AmazonTransactions

from . import cache
from . import refund_scrape
from .refund_scrape import RefundBreakdown

MAX_RETRIES = 6
INITIAL_BACKOFF_SECONDS = 30
PAGE_DELAY_SECONDS = 3


class SessionExpiredError(Exception):
    """Raised when Amazon has invalidated the current session (e.g. after flagging request
    volume as suspicious). Retrying won't help -- re-run `amazon-orders login --browser`."""


def _with_retry(fn, *args, **kwargs):
    delay = INITIAL_BACKOFF_SECONDS
    for attempt in range(MAX_RETRIES):
        try:
            return fn(*args, **kwargs)
        except AmazonOrdersNotFoundError:
            # Permanent (e.g. an order type get_order() doesn't support, like Whole
            # Foods/Fresh) -- retrying won't change that, so fail immediately.
            raise
        except AmazonOrdersError as e:
            if "returned 401" in str(e):
                raise SessionExpiredError(
                    "Amazon rejected the request as unauthenticated (401), even though login "
                    "succeeded at the start of this run. Your session has likely been revoked "
                    "server-side. Run `amazon-orders login --browser` again, then re-run this."
                ) from e
            if attempt == MAX_RETRIES - 1:
                raise
            print(f"Amazon request failed ({e}), retrying in {delay}s...")
            time.sleep(delay)
            delay *= 2


@dataclass
class Charge:
    completed_date: datetime.date
    grand_total: float
    order_number: Optional[str]
    payment_method_last_4: Optional[str]
    is_refund: bool

    def to_json(self) -> dict:
        d = asdict(self)
        d["completed_date"] = self.completed_date.isoformat()
        return d

    @classmethod
    def from_json(cls, d: dict) -> "Charge":
        d = dict(d)
        d["completed_date"] = datetime.date.fromisoformat(d["completed_date"])
        return cls(**d)


@dataclass
class ItemData:
    title: str
    price: Optional[float]
    quantity: Optional[int]


ADJUSTMENT_FIELDS = (
    "estimated_tax",
    "shipping_total",
    "gift_wrap",
    "free_shipping",
    "promotion_applied",
    "coupon_savings",
    "subscription_discount",
    "multibuy_discount",
    "amazon_discount",
    "reward_points",
    "gift_card",
)


@dataclass
class OrderData:
    order_number: str
    items: List[ItemData]
    estimated_tax: Optional[float] = None
    shipping_total: Optional[float] = None
    gift_wrap: Optional[float] = None
    free_shipping: Optional[float] = None
    promotion_applied: Optional[float] = None
    coupon_savings: Optional[float] = None
    subscription_discount: Optional[float] = None
    multibuy_discount: Optional[float] = None
    amazon_discount: Optional[float] = None
    reward_points: Optional[float] = None
    gift_card: Optional[float] = None

    @classmethod
    def from_order(cls, order) -> "OrderData":
        items = [
            ItemData(title=item.title, price=item.price, quantity=item.quantity)
            for item in order.items
        ]
        kwargs = {field: getattr(order, field, None) for field in ADJUSTMENT_FIELDS}
        return cls(order_number=order.order_number, items=items, **kwargs)

    def to_json(self) -> dict:
        d = asdict(self)
        return d

    @classmethod
    def from_json(cls, d: dict) -> "OrderData":
        items = [ItemData(**item) for item in d["items"]]
        kwargs = {field: d.get(field) for field in ADJUSTMENT_FIELDS}
        return cls(order_number=d["order_number"], items=items, **kwargs)


def login() -> AmazonSession:
    session = AmazonSession()
    session.login()
    if not session.is_authenticated:
        raise SessionExpiredError(
            "Amazon session is not authenticated. Run `amazon-orders login --browser` again."
        )
    return session


def get_charges_for_year(
    session: AmazonSession, year: int, cache_dir: Optional[Path] = None
) -> List[Charge]:
    cache_key = f"charges_{year}"

    if cache_dir is not None:
        cached = cache.read_json(cache_dir, cache_key)
        if cached is not None:
            return _dedupe_charges([Charge.from_json(c) for c in cached])

    txn_client = AmazonTransactions(session)
    today = datetime.date.today()
    days = (today - datetime.date(year, 1, 1)).days + 1

    raw = []
    page = _with_retry(txn_client.get_transactions_page, days=days, limit=1)
    raw.extend(page.items)
    print(f"  fetched page, {len(raw)} transactions so far...")
    while page.has_more:
        time.sleep(PAGE_DELAY_SECONDS)
        page = _with_retry(txn_client.get_transactions_page, cursor=page.cursor, limit=1)
        raw.extend(page.items)
        print(f"  fetched page, {len(raw)} transactions so far...")

    charges = [
        Charge(
            completed_date=t.completed_date,
            grand_total=t.grand_total,
            order_number=t.order_number,
            payment_method_last_4=t.payment_method_last_4,
            is_refund=t.is_refund,
        )
        for t in raw
        if t.completed_date.year == year
    ]
    charges = _dedupe_charges(charges)

    if cache_dir is not None:
        cache.write_json(cache_dir, cache_key, [c.to_json() for c in charges])

    return charges


def _dedupe_charges(charges: List["Charge"]) -> List["Charge"]:
    """Amazon's transaction-history pagination can hand back the same transaction
    twice at a page boundary. Collapse exact duplicates (same date, amount, order,
    sign, card) so they don't manufacture false ties downstream."""
    seen = set()
    deduped = []
    for c in charges:
        fingerprint = (c.completed_date, round(c.grand_total, 2), c.order_number, c.is_refund, c.payment_method_last_4)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        deduped.append(c)
    return deduped


def get_refund_breakdown(session: AmazonSession, order_number: str) -> Optional[RefundBreakdown]:
    """Scrape the order summary page's cumulative refund breakdown for an order
    (not cached: cheap, and refund state can change between runs)."""
    breakdown = _with_retry(refund_scrape.fetch_refund_breakdown, session, order_number)
    time.sleep(1)
    return breakdown


def get_charges_for_order(
    session: AmazonSession, order_number: str, cache_dir: Optional[Path] = None
) -> List[Charge]:
    """Fetch every charge/refund transaction tied to one specific order, scoped
    server-side via Amazon's own order filter. Used to recover transactions that a
    bulk `get_charges_for_year` fetch missed (its date-range pagination has gaps),
    when we already know the order number (e.g. from a pre-existing note)."""
    cache_key = f"order_charges_{order_number}"

    if cache_dir is not None:
        cached = cache.read_json(cache_dir, cache_key)
        if cached is not None:
            return [Charge.from_json(c) for c in cached]

    txn_client = AmazonTransactions(session)
    raw = _with_retry(txn_client.get_transactions, order_id=order_number)
    time.sleep(1)

    charges = [
        Charge(
            completed_date=t.completed_date,
            grand_total=t.grand_total,
            order_number=t.order_number,
            payment_method_last_4=t.payment_method_last_4,
            is_refund=t.is_refund,
        )
        for t in raw
    ]

    if cache_dir is not None:
        cache.write_json(cache_dir, cache_key, [c.to_json() for c in charges])

    return charges


def get_order(
    session: AmazonSession, order_number: str, cache_dir: Optional[Path] = None
) -> OrderData:
    cache_key = f"order_{order_number}"

    if cache_dir is not None:
        cached = cache.read_json(cache_dir, cache_key)
        if cached is not None:
            return OrderData.from_json(cached)

    orders_client = AmazonOrders(session)
    order = _with_retry(orders_client.get_order, order_number)
    order_data = OrderData.from_order(order)
    time.sleep(1)

    if cache_dir is not None:
        cache.write_json(cache_dir, cache_key, order_data.to_json())

    return order_data
