"""Telegram/OpenClaw transport helpers."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass


def _compact_preview(text: str, limit: int = 320) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3].rstrip() + "..."


@dataclass
class TelegramDispatchResult:
    output_text: str
    mocked: bool
    delivered: bool
    transport_state: str


class TelegramBridge:
    """Small wrapper around Telegram Bot API with a local stub fallback."""

    def __init__(self) -> None:
        self.token = os.getenv("WHISP_TELEGRAM_BOT_TOKEN", "").strip()
        self.chat_id = (
            os.getenv("WHISP_TELEGRAM_OPENCLAW_CHAT_ID", "").strip()
            or os.getenv("WHISP_TELEGRAM_CHAT_ID", "").strip()
        )
        self.bot_name = os.getenv("WHISP_TELEGRAM_BOT_NAME", "@openclaw_bot").strip() or "@openclaw_bot"

    def status(self) -> dict:
        return {
            "configured": bool(self.token and self.chat_id),
            "token_present": bool(self.token),
            "chat_id_present": bool(self.chat_id),
            "bot_name": self.bot_name,
        }

    def send_openclaw(self, text: str, conversation_title: str | None = None) -> TelegramDispatchResult:
        payload_text = (text or "").strip()
        if not payload_text:
            return TelegramDispatchResult(
                output_text="OPENCLAW // TELEGRAM ROUTE\n\nNothing to send.",
                mocked=True,
                delivered=False,
                transport_state="empty",
            )

        if not (self.token and self.chat_id):
            title = conversation_title or "OpenClaw channel"
            return TelegramDispatchResult(
                output_text=(
                    "OPENCLAW // TELEGRAM STUB\n\n"
                    f"Channel: {title}\n"
                    f"Bot: {self.bot_name}\n\n"
                    "Telegram is not configured yet, so this was stored locally and routed through the stub.\n\n"
                    "Queued payload:\n"
                    f"{_compact_preview(payload_text)}"
                ),
                mocked=True,
                delivered=False,
                transport_state="stubbed",
            )

        body = {
            "chat_id": self.chat_id,
            "text": payload_text,
        }
        endpoint = f"https://api.telegram.org/bot{self.token}/sendMessage"
        request_obj = urllib.request.Request(
            endpoint,
            method="POST",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request_obj, timeout=20) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            return TelegramDispatchResult(
                output_text=(
                    "OPENCLAW // TELEGRAM ROUTE\n\n"
                    f"Telegram rejected the request: HTTP {exc.code}\n"
                    f"{_compact_preview(detail, 220)}"
                ),
                mocked=False,
                delivered=False,
                transport_state="rejected",
            )
        except Exception as exc:
            return TelegramDispatchResult(
                output_text=(
                    "OPENCLAW // TELEGRAM ROUTE\n\n"
                    f"Transport error: {exc}"
                ),
                mocked=False,
                delivered=False,
                transport_state="error",
            )

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {}
        message_id = ((parsed.get("result") or {}).get("message_id"))
        return TelegramDispatchResult(
            output_text=(
                "OPENCLAW // TELEGRAM ROUTE\n\n"
                f"Delivered to {self.bot_name}.\n"
                f"Telegram message id: {message_id or 'unknown'}"
            ),
            mocked=False,
            delivered=True,
            transport_state="delivered",
        )


telegram_bridge = TelegramBridge()
