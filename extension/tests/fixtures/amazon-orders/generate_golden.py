"""
Regenerates golden.json: upstream amazon-orders' own parse results for its US fixtures, which the
TypeScript port is tested against field by field (tests/upstream-golden.test.ts).

    git clone https://github.com/alexdlaird/amazon-orders /tmp/amazon-orders
    pip install beautifulsoup4 python-dateutil requests click pyyaml pillow pyotp
    PYTHONPATH=/tmp/amazon-orders python generate_golden.py /tmp/amazon-orders/tests/resources .
"""
import datetime, glob, json, logging, os, re, sys, tempfile

from bs4 import BeautifulSoup

from amazonorders import util
from amazonorders.conf import AmazonOrdersConfig
from amazonorders.entity.order import Order
from amazonorders.orders import AmazonOrders
from amazonorders.transactions import AmazonTransactions

logging.disable(logging.CRITICAL)
resources, out_dir = sys.argv[1], sys.argv[2]
cfg = AmazonOrdersConfig(config_path=os.path.join(tempfile.mkdtemp(), "c.yml"),
                         data={"warn_on_missing_required_field": True})

def d(v):
    return v.isoformat() if isinstance(v, datetime.date) else v

ORDER_FIELDS = ["order_number", "order_details_link", "order_placed_date", "grand_total", "cancelled", "is_whole_foods",
                "item_count", "subtotal", "shipping_total", "free_shipping", "promotion_applied", "coupon_savings",
                "reward_points", "subscription_discount", "total_before_tax", "estimated_tax", "refund_total",
                "multibuy_discount", "amazon_discount", "gift_card", "gift_wrap"]

def order_json(o, items=True):
    j = {k: d(getattr(o, k)) for k in ORDER_FIELDS}
    if items:
        j["items"] = [{"title": i.title, "price": i.price, "quantity": i.quantity} for i in o.items]
    return j

def err(e):
    return {"error": f"{type(e).__name__}: {e}"[:200]}

golden = {"details": {}, "snippets": {}, "history": {}, "transactions": {}}
orders_dir = os.path.join(resources, "orders")

for f in sorted(glob.glob(os.path.join(orders_dir, "*.html"))):
    name = os.path.basename(f)
    html = open(f, encoding="utf-8").read()
    try:
        if name.startswith("order-history-"):
            golden["history"][name] = [{**order_json(o, items=False), "index": o.index}
                                       for o in AmazonOrders.parse_orders(html, cfg)]
        elif "snippet" in name and name != "order-details-not-found-snippet.html":
            parsed = BeautifulSoup(html, cfg.bs4_parser)
            root = util.select_one(parsed, cfg.selectors.ORDER_DETAILS_ENTITY_SELECTOR) or parsed
            golden["snippets"][name] = order_json(Order(root, cfg, full_details=True))
        elif name.startswith("order-details-"):
            m = re.search(r"(\d{3}-\d{7}-\d{7})", name)
            number = m.group(1) if "fopo" in name and m else None
            golden["details"][name] = order_json(AmazonOrders.parse_order_details(html, cfg, order_number=number))
    except Exception as e:  # recorded: the port should fail the same way
        bucket = "history" if name.startswith("order-history-") else "details"
        golden[bucket][name] = err(e)

for f in sorted(glob.glob(os.path.join(resources, "transactions", "transactions-*.html"))):
    name = os.path.basename(f)
    try:
        golden["transactions"][name] = [
            {"completed_date": d(t.completed_date), "grand_total": t.grand_total, "is_refund": t.is_refund,
             "order_number": t.order_number, "payment_method": t.payment_method,
             "payment_method_last_4": t.payment_method_last_4, "seller": t.seller}
            for t in AmazonTransactions.parse_transactions(open(f, encoding="utf-8").read(), cfg)]
    except Exception as e:
        golden["transactions"][name] = err(e)

with open(os.path.join(out_dir, "golden.json"), "w", encoding="utf-8") as fh:
    json.dump(golden, fh, indent=1, ensure_ascii=False)
print({k: len(v) for k, v in golden.items()})
