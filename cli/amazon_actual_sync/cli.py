import argparse
import os
import shutil
import sys
from pathlib import Path

from actual import Actual
from actual.queries import get_accounts

from . import amazon_fetch
from .amazon_fetch import SessionExpiredError
from .sync import run_sync


def _prompt_pick_one(items, label_fn, prompt):
    for i, item in enumerate(items, start=1):
        print(f"  {i}. {label_fn(item)}")
    while True:
        choice = input(prompt).strip()
        if choice.isdigit() and 1 <= int(choice) <= len(items):
            return items[int(choice) - 1]
        print("Invalid choice, try again.")


def _prompt_pick_accounts(accounts):
    for i, account in enumerate(accounts, start=1):
        print(f"  {i}. {account.name}")
    print("Enter account numbers separated by commas, or 'all'.")
    while True:
        choice = input("Accounts to use for Amazon matching: ").strip().lower()
        if choice == "all":
            return list(accounts)
        try:
            indices = [int(x.strip()) for x in choice.split(",") if x.strip()]
            if all(1 <= i <= len(accounts) for i in indices) and indices:
                return [accounts[i - 1] for i in indices]
        except ValueError:
            pass
        print("Invalid choice, try again.")


def main():
    parser = argparse.ArgumentParser(description="Split Amazon charges in Actual Budget by line item")
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--server-url", default=os.environ.get("ACTUAL_SERVER_URL"))
    parser.add_argument("--password", default=os.environ.get("ACTUAL_PASSWORD"))
    parser.add_argument("--budget", default=os.environ.get("ACTUAL_BUDGET"), help="Budget name or id; skips the picker if given")
    parser.add_argument("--accounts", default=None, help="Comma-separated account names to restrict to; skips the picker if given")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--review-csv", default="needs_review.csv")
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Skip TLS certificate verification (needed for a self-signed local server)",
    )
    parser.add_argument(
        "--cache-dir",
        default=".cache",
        help="Directory to cache Amazon charges/order data between runs (avoids re-hitting Amazon)",
    )
    parser.add_argument(
        "--refresh-cache",
        action="store_true",
        help="Ignore any cached Amazon data and re-fetch everything",
    )
    parser.add_argument(
        "--include-closed-accounts",
        action="store_true",
        help="Include closed accounts in the account picker (default: open accounts only)",
    )
    parser.add_argument(
        "--include-categorized",
        action="store_true",
        help="Also process transactions that already have a category (default: only uncategorized ones)",
    )
    args = parser.parse_args()

    if not (args.server_url and args.password):
        print("Missing --server-url/--password (or ACTUAL_SERVER_URL/ACTUAL_PASSWORD env vars)")
        sys.exit(1)

    cache_dir = Path(args.cache_dir)
    if args.refresh_cache and cache_dir.exists():
        shutil.rmtree(cache_dir)

    try:
        print("Logging into Amazon (reusing persisted session if available)...")
        amazon_session = amazon_fetch.login()

        print(f"Fetching Amazon charges for {args.year}...")
        charges = amazon_fetch.get_charges_for_year(amazon_session, args.year, cache_dir=cache_dir)
        print(f"Found {len(charges)} charges in {args.year}")
    except SessionExpiredError as e:
        print(f"\n{e}\n")
        sys.exit(1)

    with Actual(base_url=args.server_url, password=args.password, cert=not args.insecure) as actual:
        if args.budget:
            actual.set_file(args.budget)
        else:
            files = actual.list_user_files().data
            if not files:
                print("No budgets found on this server.")
                sys.exit(1)
            chosen = _prompt_pick_one(files, lambda f: f.name, "Pick a budget: ")
            actual.set_file(chosen.file_id)

        actual.download_budget()

        accounts = get_accounts(actual.session, closed=None if args.include_closed_accounts else False)
        if args.accounts:
            wanted_names = {n.strip().lower() for n in args.accounts.split(",")}
            selected_accounts = [a for a in accounts if a.name.lower() in wanted_names]
            if not selected_accounts:
                print(f"No accounts matched: {args.accounts}")
                sys.exit(1)
        else:
            selected_accounts = _prompt_pick_accounts(accounts)

        print("Using accounts:", ", ".join(a.name for a in selected_accounts))
        account_ids = {a.id for a in selected_accounts}

        try:
            stats = run_sync(
                actual,
                amazon_session,
                args.year,
                charges,
                dry_run=args.dry_run,
                review_csv_path=args.review_csv,
                cache_dir=cache_dir,
                account_ids=account_ids,
                uncategorized_only=not args.include_categorized,
            )
        except SessionExpiredError as e:
            print(f"\n{e}\n")
            print("Nothing was written to Actual yet (commit only happens at the end of a full run).")
            sys.exit(1)

    print(f"Processed: {stats.processed}")
    print(f"Unmatched: {len(stats.unmatched)}")
    print(f"Reconciliation failed: {len(stats.reconciliation_failed)}")
    if stats.unmatched or stats.reconciliation_failed:
        print(f"See {args.review_csv} for details")


if __name__ == "__main__":
    main()
