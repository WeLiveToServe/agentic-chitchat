"""Device-side transcription helpers."""
from __future__ import annotations

import base64
import json
import os
from urllib import error, request
from pathlib import Path
from typing import Optional, Tuple

try:
    import transcripter_redline
except Exception:  # pragma: no cover - optional dependency
    transcripter_redline = None  # type: ignore


GEMINI_API_KEY = os.getenv("GOOGAISTUDIO_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("WHISP_GEMINI_MODEL", "gemini-2.5-flash").strip()


def _compact_error_message(exc: Exception, provider: str) -> str:
    """Return a short, UI-safe error label without raw provider payloads."""
    text = str(exc or "").lower()
    if "api key" in text or "invalid_api_key" in text or "api_key_invalid" in text:
        return f"[Transcript unavailable: {provider} API key invalid]"
    if "permission_denied" in text or "service_disabled" in text or "forbidden" in text:
        return f"[Transcript unavailable: {provider} access denied]"
    if "timed out" in text or "timeout" in text:
        return f"[Transcript unavailable: {provider} timeout]"
    if "file not found" in text:
        return "[Transcript unavailable: audio file missing]"
    return f"[Transcript unavailable: {provider} error]"


def _transcribe_with_gemini(audio_path: str, prompt_text: Optional[str] = None) -> str:
    """Transcribe audio with Gemini generateContent using inline audio bytes."""
    if not GEMINI_API_KEY:
        raise RuntimeError("GOOGAISTUDIO_API_KEY is not configured")
    path = Path(audio_path)
    if not path.exists():
        raise FileNotFoundError(f"Audio path not found: {audio_path}")

    mime_type = "audio/wav"
    suffix = path.suffix.lower()
    if suffix == ".mp3":
        mime_type = "audio/mpeg"

    instruction = (
        "Transcribe this audio exactly. Return only transcript text with no explanation."
    )
    if prompt_text:
        instruction = f"{instruction}\n\nContext hint:\n{prompt_text.strip()}"

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": instruction},
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": base64.b64encode(path.read_bytes()).decode("ascii"),
                        }
                    },
                ],
            }
        ],
        "generationConfig": {"temperature": 0},
    }

    endpoint = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
        f"?key={GEMINI_API_KEY}"
    )
    req = request.Request(
        endpoint,
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with request.urlopen(req, timeout=45) as response:
            body = response.read().decode("utf-8")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        try:
            parsed_err = json.loads(detail)
            err = parsed_err.get("error") or {}
            status = err.get("status") or "HTTP_ERROR"
            message = err.get("message") or "request failed"
            raise RuntimeError(f"Gemini {status}: {message}") from exc
        except json.JSONDecodeError:
            raise RuntimeError(f"Gemini HTTP {exc.code}") from exc
    except Exception as exc:
        raise RuntimeError(f"Gemini transcription failed: {exc}") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Gemini response was not valid JSON: {exc}") from exc

    candidates = parsed.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")
    parts = (((candidates[0] or {}).get("content") or {}).get("parts")) or []
    text = " ".join(str(part.get("text", "")).strip() for part in parts if part.get("text"))
    return text.strip()


def transcribe(audio_path: str) -> Tuple[str, bool]:
    """Transcribe audio locally, falling back to mock text if unavailable."""
    if GEMINI_API_KEY:
        try:
            gemini_text = _transcribe_with_gemini(audio_path)
            if gemini_text:
                return gemini_text, False
            return "[Empty transcript]", True
        except Exception as exc:
            return _compact_error_message(exc, "Gemini"), True

    if transcripter_redline is None:
        filename = Path(audio_path).name
        return f"[Transcript unavailable for {filename}]", True

    try:
        raw_text, enhanced_text = transcripter_redline.transcribe_and_enhance(audio_path)
    except Exception as exc:  # pragma: no cover - network/auth/service failure
        return _compact_error_message(exc, "OpenAI"), True
    transcript = (enhanced_text or raw_text or "").strip()
    mocked = False
    if not transcript:
        transcript = "[Empty transcript]"
        mocked = True
    return transcript, mocked


def transcribe_live_chunk(audio_path: str, prompt_text: Optional[str] = None) -> Tuple[str, bool]:
    """Transcribe a short audio chunk via OpenAI Whisper."""
    if GEMINI_API_KEY:
        try:
            text = _transcribe_with_gemini(audio_path, prompt_text)
        except Exception as exc:  # pragma: no cover - network failure or auth issues
            return _compact_error_message(exc, "Gemini"), True
        transcript = (text or "").strip()
        if not transcript:
            return "[Empty transcript]", True
        return transcript, False

    if transcripter_redline is None:
        filename = Path(audio_path).name
        return f"[Transcript unavailable for {filename}]", True

    try:
        raw_text = transcripter_redline.transcribe_whisper_file(audio_path, prompt_text)
    except Exception as exc:  # pragma: no cover - network failure or client issues
        return f"[transcription error: {exc}]", True

    transcript = (raw_text or "").strip()
    if not transcript:
        return "[Empty transcript]", True
    return transcript, False

