"""Register the Telegram webhook and the bot's command menu.

Run from your own machine (never in the browser or CI logs):

    python scripts/telegram_setup.py secret      # print a new random webhook secret
    python scripts/telegram_setup.py webhook     # setWebhook + setMyCommands
    python scripts/telegram_setup.py info        # show the current webhook status

Environment variables (see .env.example):
    TELEGRAM_BOT_TOKEN        from @BotFather
    TELEGRAM_WEBHOOK_SECRET   same value as the Supabase Edge Function secret
    SUPABASE_PROJECT_REF      e.g. sywmicrngyvojjdayhhc
The token is only sent to api.telegram.org and is never printed.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import urllib.error
import urllib.request

COMMANDS = [
    {"command": "sale", "description": "Record a sale"},
    {"command": "stock_add", "description": "Add new stock (purchase batch)"},
    {"command": "stock_adjust", "description": "Receive, stock check or correct quantity"},
    {"command": "stock", "description": "Look up stock levels: /stock <code or name>"},
    {"command": "whoami", "description": "Show the linked account"},
    {"command": "cancel", "description": "Cancel the current action"},
    {"command": "help", "description": "Show help"},
]


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is not set (see .env.example).")
    return value


def telegram(method: str, payload: dict | None = None) -> dict:
    token = env("TELEGRAM_BOT_TOKEN")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(payload or {}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:  # do not print the URL (it contains the token)
        body = json.loads(exc.read() or b"{}")
        raise SystemExit(f"Telegram {method} failed: {body.get('description', exc.code)}") from None


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "secret":
        print(secrets.token_urlsafe(32))
        return 0
    if command == "webhook":
        secret = env("TELEGRAM_WEBHOOK_SECRET")
        if len(secret) < 16:
            raise SystemExit("TELEGRAM_WEBHOOK_SECRET must be at least 16 characters (use: telegram_setup.py secret).")
        url = f"https://{env('SUPABASE_PROJECT_REF')}.supabase.co/functions/v1/telegram-webhook"
        result = telegram("setWebhook", {
            "url": url,
            "secret_token": secret,
            "allowed_updates": ["message", "callback_query"],
            "drop_pending_updates": True,
            "max_connections": 10,
        })
        print(f"setWebhook: {result.get('description', result.get('ok'))} → {url}")
        result = telegram("setMyCommands", {"commands": COMMANDS, "scope": {"type": "all_private_chats"}})
        print(f"setMyCommands: {result.get('ok')}")
        return 0
    if command == "info":
        info = telegram("getWebhookInfo").get("result", {})
        for key in ("url", "pending_update_count", "last_error_date", "last_error_message", "allowed_updates"):
            print(f"{key}: {info.get(key)}")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
