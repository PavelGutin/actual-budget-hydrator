import json
from dataclasses import dataclass, field
from typing import Dict, Optional

from bs4 import BeautifulSoup

from amazonorders.exception import AmazonOrdersError

ORDER_SUMMARY_URL = "https://www.amazon.com/gp/css/summary/edit.html"


@dataclass
class RefundBreakdown:
    """The order summary page's cumulative refund breakdown for an order, as of now.
    If an order has had more than one refund event, this is their sum -- it cannot
    distinguish which event contributed which part."""

    total_cents: int
    item_refund_cents: int
    other_cents: Dict[str, int] = field(default_factory=dict)


def _to_cents(text: str) -> int:
    value = text.strip().lstrip("$").replace(",", "")
    return round(float(value) * 100)


def _parse_popover_rows(inline_html: str) -> Dict[str, int]:
    soup = BeautifulSoup(inline_html, "html.parser")
    rows: Dict[str, int] = {}
    for row in soup.select("div.od-line-item-row"):
        label_el = row.select_one(".od-line-item-row-label")
        content_el = row.select_one(".od-line-item-row-content")
        if not label_el or not content_el:
            continue
        label = label_el.get_text(strip=True)
        amount_text = content_el.get_text(strip=True)
        if not label or not amount_text.startswith("$"):
            continue
        try:
            rows[label] = _to_cents(amount_text)
        except ValueError:
            continue
    return rows


def fetch_refund_breakdown(amazon_session, order_number: str) -> Optional[RefundBreakdown]:
    """Scrape the order summary page's cumulative refund breakdown (Item(s) refund,
    Tax refund, etc. -> Refund Total) for an order. Returns None if the page shows no
    refund breakdown (e.g. the order was never refunded)."""
    resp = amazon_session.get(f"{ORDER_SUMMARY_URL}?orderID={order_number}")
    if resp.response.status_code != 200:
        raise AmazonOrdersError(
            f"The page {resp.response.url} returned {resp.response.status_code}."
        )
    soup = BeautifulSoup(resp.response.text, "html.parser")

    for tag in soup.select("[data-a-popover]"):
        raw = tag.get("data-a-popover")
        if not raw or "Refund Total" not in raw:
            continue
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        inline = data.get("inlineContent", "")
        if "Refund Total" not in inline:
            continue
        rows = _parse_popover_rows(inline)
        if "Refund Total" not in rows:
            continue
        total_cents = rows.pop("Refund Total")
        item_refund_cents = rows.pop("Item(s) refund", 0)
        return RefundBreakdown(total_cents=total_cents, item_refund_cents=item_refund_cents, other_cents=rows)

    return None
