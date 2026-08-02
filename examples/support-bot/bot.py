#!/usr/bin/env python3
"""Support bot — a small, real CLI that remembers each customer separately.

Every customer is a sub-tenant of ONE API key. That is the whole point of the
`user_id` parameter: your key is your account, and each of your end users gets
an isolated memory space inside it. Nothing a customer says can reach another
customer's memory, and memory survives across runs of this process.

    export ITSUKI_API_KEY=itsuki_live_...

    python bot.py --customer alice tell "My order 4471 shipped to the Porto office."
    python bot.py --customer alice ask  "Where is my order going?"
    python bot.py --customer alice chat          # interactive
    python bot.py customers                      # who this bot has talked to

Requires the published package:  pip install itsuki
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from itsuki import MemoryClient, MemoryAPIError
except ImportError:  # pragma: no cover - guidance, not logic
    sys.exit("The itsuki package is not installed. Run:  pip install itsuki")

# The bot's own tiny roster. Memory itself lives in Itsuki; this is only so
# `customers` can list who we have met.
ROSTER = Path(__file__).with_name(".customers.json")
BASE_URL = os.environ.get("ITSUKI_BASE_URL", "https://itsuki.app")


def client(customer: str) -> MemoryClient:
    """One client per customer. `user_id` is the isolation boundary."""
    key = os.environ.get("ITSUKI_API_KEY")
    if not key:
        sys.exit(
            "ITSUKI_API_KEY is not set.\n"
            "  Create a key at https://itsuki.app -> API keys, then:\n"
            "  export ITSUKI_API_KEY=itsuki_live_..."
        )
    return MemoryClient(api_key=key, base_url=BASE_URL, user_id=customer, timeout=45.0)


def remember_customer(customer: str) -> None:
    try:
        seen = json.loads(ROSTER.read_text()) if ROSTER.exists() else []
    except (OSError, ValueError):
        seen = []
    if customer not in seen:
        seen.append(customer)
        try:
            ROSTER.write_text(json.dumps(sorted(seen), indent=1))
        except OSError:
            pass  # a roster we cannot write is cosmetic, never fatal


def friendly(err: MemoryAPIError) -> str:
    """Turn an API error into something a support agent can act on."""
    if err.status == 401:
        return f"Itsuki rejected the API key: {err}"
    if err.status == 429:
        return "Too many requests just now — wait a few seconds and try again."
    if err.status == 400:
        return f"Itsuki refused that request: {err}"
    if err.status == 0:
        return f"Could not reach Itsuki at {BASE_URL}: {err}"
    return f"Itsuki returned an error ({err.status}): {err}"


def cmd_tell(customer: str, text: str) -> int:
    if not text.strip():
        print("Nothing to remember — give me a sentence.", file=sys.stderr)
        return 2
    try:
        with client(customer) as memory:
            receipt = memory.add(text, idempotency_key=MemoryClient.new_idempotency_key())
    except MemoryAPIError as err:
        print(friendly(err), file=sys.stderr)
        return 1
    remember_customer(customer)
    print(receipt.get("summary") or "Noted.")
    return 0


def cmd_ask(customer: str, question: str) -> int:
    try:
        with client(customer) as memory:
            found = memory.search(question)
    except MemoryAPIError as err:
        print(friendly(err), file=sys.stderr)
        return 1
    context = (found.get("context") or "").strip()
    if not context:
        print(f"I don't have anything on file for {customer} about that.")
        return 0
    print(f"What I know about {customer}:\n{context}")
    return 0


def cmd_chat(customer: str) -> int:
    print(f"Support bot — talking to {customer}. Type a message, or /ask <question>, or /quit.")
    while True:
        try:
            line = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not line:
            continue
        if line in ("/quit", "/exit"):
            return 0
        if line.startswith("/ask "):
            cmd_ask(customer, line[5:])
        else:
            cmd_tell(customer, line)


def cmd_customers() -> int:
    if not ROSTER.exists():
        print("No customers yet.")
        return 0
    for name in json.loads(ROSTER.read_text()):
        print(name)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="A support bot that remembers each customer separately.")
    parser.add_argument("--customer", help="the end user this conversation belongs to")
    sub = parser.add_subparsers(dest="command", required=True)
    tell = sub.add_parser("tell", help="save something about this customer")
    tell.add_argument("text", nargs="+")
    ask = sub.add_parser("ask", help="ask what we know about this customer")
    ask.add_argument("question", nargs="+")
    sub.add_parser("chat", help="interactive session")
    sub.add_parser("customers", help="list customers this bot has met")

    args = parser.parse_args(argv)
    if args.command == "customers":
        return cmd_customers()
    if not args.customer:
        print("--customer is required (it is the isolation boundary).", file=sys.stderr)
        return 2
    if args.command == "tell":
        return cmd_tell(args.customer, " ".join(args.text))
    if args.command == "ask":
        return cmd_ask(args.customer, " ".join(args.question))
    return cmd_chat(args.customer)


if __name__ == "__main__":
    raise SystemExit(main())
