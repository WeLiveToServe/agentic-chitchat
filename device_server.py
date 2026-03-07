"""Device server orchestrating recording, local transcription, threads, and agent stubs."""
from __future__ import annotations

import logging
import os
import re
import json
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

from agent_factory import AgentRegistry
from agents import Runner
from device.database import (
    ChitRecord,
    LiveSegment,
    SnippetRecord,
    ThreadRecord,
    db_session,
    init_db,
)

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


def _load_local_env_file(path: Path = Path(".env.local")) -> None:
    """Load local env values for dev runs without overriding existing environment."""
    if not path.exists():
        return
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            row = line.strip()
            if not row or row.startswith("#") or "=" not in row:
                continue
            key, value = row.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                os.environ[key] = value
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Could not load %s: %s", path, exc)


_load_local_env_file()

from device.recorder_service import RecorderBusyError, RecorderIdleError, recorder_service
from device.transcription import transcribe


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    with db_session() as session:
        _get_active_thread(session, create_if_missing=True)
    yield


app = FastAPI(title="WhisPTT Device Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChitResponse(BaseModel):
    id: str
    recording_id: str | None
    audio_path: str
    transcript: str
    mocked: bool
    created_at: str


class RecordStopResponse(BaseModel):
    id: str
    recording_id: str | None
    audio_path: str
    transcript: str
    mocked: bool
    created_at: str
    thread_id: str
    snippet_id: str
    snippet_position: int


class StatusResponse(BaseModel):
    status: str
    recording_id: str | None = None
    last_error: str | None = None


class LiveSegmentResponse(BaseModel):
    recording_id: str
    chunk_index: int
    start_ms: float
    end_ms: float
    text: str
    mocked: bool
    finalized: bool


class LiveStatusResponse(BaseModel):
    status: str
    recording_id: str | None
    segments: List[LiveSegmentResponse]


class ThreadSummaryResponse(BaseModel):
    id: str
    title: str
    is_active: bool
    snippet_count: int
    latest_snippet_preview: str
    created_at: str
    updated_at: str


class SnippetResponse(BaseModel):
    id: str
    thread_id: str
    position: int
    source: str
    audio_path: str | None = None
    transcript: str
    created_at: str
    updated_at: str


class ThreadDetailResponse(BaseModel):
    thread: ThreadSummaryResponse
    snippets: List[SnippetResponse]


class CreateThreadRequest(BaseModel):
    title: str | None = None


class UpdateThreadRequest(BaseModel):
    title: str


class CreateSnippetRequest(BaseModel):
    transcript: str
    source: str = "text"


class UpdateSnippetRequest(BaseModel):
    transcript: str


class AgentOptionResponse(BaseModel):
    id: str
    name: str
    description: str
    featured: bool = False


class AgentRequest(BaseModel):
    agent_id: str = "vanilla"
    input_mode: str = "thread"
    thread_id: str | None = None
    snippet_id: str | None = None
    text: str | None = None
    response_mode: str = "text_only"
    session_id: str | None = None


class AgentResponse(BaseModel):
    agent_id: str
    input_mode: str
    response_mode: str
    input_text: str
    output_text: str
    output_voice_text: str | None = None
    mocked: bool = True
    session_id: str | None = None


try:
    _agent_registry = AgentRegistry.from_file("agents_config.yaml")
except Exception as exc:  # pragma: no cover - defensive
    logger.warning("Agent registry unavailable: %s", exc)
    _agent_registry = None

MONEYPENNY_ID = "moneypenny"


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc).isoformat()
    return value.astimezone(timezone.utc).isoformat()


def _preview(text: str, limit: int = 84) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def _default_thread_title(now: datetime | None = None) -> str:
    stamp = (now or datetime.now(timezone.utc)).strftime("%H%M")
    return f"STACK {stamp}"


def _touch_thread(thread: ThreadRecord) -> None:
    thread.updated_at = datetime.now(timezone.utc)


def _activate_thread(session, thread: ThreadRecord) -> None:
    session.query(ThreadRecord).filter(ThreadRecord.is_active.is_(True)).update({"is_active": False})
    thread.is_active = True
    _touch_thread(thread)
    session.add(thread)
    session.flush()


def _get_active_thread(session, create_if_missing: bool = True) -> ThreadRecord:
    thread = (
        session.query(ThreadRecord)
        .filter(ThreadRecord.is_active.is_(True))
        .order_by(ThreadRecord.updated_at.desc())
        .first()
    )
    if thread is None and create_if_missing:
        thread = ThreadRecord(title=_default_thread_title(), is_active=True)
        session.add(thread)
        session.flush()
    if thread is None:
        raise HTTPException(status_code=404, detail="No active thread")
    return thread


def _get_thread(session, thread_id: str) -> ThreadRecord:
    thread = session.query(ThreadRecord).filter(ThreadRecord.id == thread_id).one_or_none()
    if thread is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    return thread


def _get_snippet(session, snippet_id: str) -> SnippetRecord:
    snippet = session.query(SnippetRecord).filter(SnippetRecord.id == snippet_id).one_or_none()
    if snippet is None:
        raise HTTPException(status_code=404, detail="Snippet not found")
    return snippet


def _list_thread_snippets(session, thread_id: str) -> List[SnippetRecord]:
    return (
        session.query(SnippetRecord)
        .filter(SnippetRecord.thread_id == thread_id)
        .order_by(SnippetRecord.position.asc(), SnippetRecord.created_at.asc())
        .all()
    )


def _next_snippet_position(session, thread_id: str) -> int:
    count = session.query(SnippetRecord).filter(SnippetRecord.thread_id == thread_id).count()
    return count + 1


def _snippet_payload(snippet: SnippetRecord) -> SnippetResponse:
    return SnippetResponse(
        id=snippet.id,
        thread_id=snippet.thread_id,
        position=snippet.position,
        source=snippet.source,
        audio_path=snippet.audio_path,
        transcript=snippet.transcript,
        created_at=_iso(snippet.created_at),
        updated_at=_iso(snippet.updated_at),
    )


def _thread_payload(session, thread: ThreadRecord) -> ThreadSummaryResponse:
    snippets = _list_thread_snippets(session, thread.id)
    latest_text = snippets[-1].transcript if snippets else ""
    return ThreadSummaryResponse(
        id=thread.id,
        title=thread.title,
        is_active=thread.is_active,
        snippet_count=len(snippets),
        latest_snippet_preview=_preview(latest_text),
        created_at=_iso(thread.created_at),
        updated_at=_iso(thread.updated_at),
    )


def _thread_detail_payload(session, thread: ThreadRecord) -> ThreadDetailResponse:
    snippets = _list_thread_snippets(session, thread.id)
    return ThreadDetailResponse(
        thread=_thread_payload(session, thread),
        snippets=[_snippet_payload(snippet) for snippet in snippets],
    )


def _combined_thread_text(session, thread_id: str) -> str:
    snippets = _list_thread_snippets(session, thread_id)
    return "\n\n".join(snippet.transcript.strip() for snippet in snippets if snippet.transcript.strip())


def _normalize_input_text(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", (text or "").strip())


def _extract_focus_lines(text: str, limit: int = 3) -> List[str]:
    lines = [line.strip(" -*\t") for line in text.splitlines() if line.strip()]
    if not lines:
        segments = [segment.strip() for segment in re.split(r"(?<=[.!?])\s+", text) if segment.strip()]
        lines = segments
    return lines[:limit]


def _dummy_agent_output(agent_id: str, input_mode: str, text: str) -> str:
    normalized = _normalize_input_text(text)
    if not normalized:
        return "No transcript available to process."

    focus_lines = _extract_focus_lines(normalized)
    bullets = "\n".join(f"- {line}" for line in focus_lines) if focus_lines else "- Review transcript"

    if agent_id == "openclaw":
        return (
            "OPENCLAW // FEATURED ROBOT FACTORY PRESET\n\n"
            f"Scope: {input_mode}\n"
            f"Payload size: {len(normalized.split())} words\n\n"
            "Core signal:\n"
            f"{bullets}\n\n"
            "Recommended next move:\n"
            "Convert this thread into a tighter operator brief, then dispatch to a specialist agent."
        )

    return (
        "VANILLA AGENT // LOCAL TEST HARNESS\n\n"
        f"Scope: {input_mode}\n"
        "What I heard:\n"
        f"{bullets}\n\n"
        "Refined response:\n"
        f"{_preview(normalized, 420)}"
    )


def _run_gemini_flash(text: str, input_mode: str) -> str:
    key = os.getenv("GOOGAISTUDIO_API_KEY", "").strip()
    if not key:
        raise RuntimeError("Gemini key not configured")
    model = os.getenv("WHISP_GEMINI_MODEL", "gemini-2.5-flash").strip()
    prompt = (
        "You are a concise assistant. Answer the user based on the provided transcript. "
        "If transcript is rough, infer intent carefully.\n\n"
        f"Input mode: {input_mode}\n\n"
        f"Transcript:\n{text.strip()}"
    )
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.4},
    }
    endpoint = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        f"?key={key}"
    )
    req = urllib.request.Request(
        endpoint,
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Gemini request failed: HTTP {exc.code} {detail}") from exc
    except Exception as exc:
        raise RuntimeError(f"Gemini request failed: {exc}") from exc

    parsed = json.loads(body)
    candidates = parsed.get("candidates") or []
    if not candidates:
        return "No response from Gemini."
    parts = (((candidates[0] or {}).get("content") or {}).get("parts")) or []
    text_out = " ".join(str(part.get("text", "")).strip() for part in parts if part.get("text"))
    return text_out.strip() or "No response from Gemini."


def _resolve_agent_input(session, payload: AgentRequest) -> tuple[str, str]:
    direct_text = _normalize_input_text(payload.text or "")
    if direct_text:
        return "text", direct_text

    if payload.input_mode == "snippet":
        snippet = _get_snippet(session, payload.snippet_id or "")
        return "snippet", _normalize_input_text(snippet.transcript)

    if payload.input_mode == "thread":
        target_thread = _get_thread(session, payload.thread_id) if payload.thread_id else _get_active_thread(session)
        return "thread", _combined_thread_text(session, target_thread.id)

    raise HTTPException(status_code=400, detail="Unsupported agent input mode")


@app.post("/api/record/start", response_model=StatusResponse)
async def api_record_start() -> StatusResponse:
    try:
        recording_id = recorder_service.start()
    except RecorderBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive guard
        logger.exception("Failed to start recording")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return StatusResponse(status="recording", recording_id=recording_id, last_error=None)


@app.post("/api/record/stop", response_model=RecordStopResponse)
async def api_record_stop(thread_id: str | None = None) -> RecordStopResponse:
    try:
        result = recorder_service.stop()
    except RecorderIdleError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to stop recording")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    audio_path = result.get("audio_path")
    if not audio_path:
        raise HTTPException(status_code=500, detail="Recorder did not provide audio path")

    transcript_text, mocked = transcribe(audio_path)
    recording_id = result.get("recording_id")

    with db_session() as session:
        thread = _get_thread(session, thread_id) if thread_id else _get_active_thread(session)
        _activate_thread(session, thread)

        snippet = SnippetRecord(
            thread_id=thread.id,
            position=_next_snippet_position(session, thread.id),
            source="voice",
            audio_path=audio_path,
            transcript=transcript_text,
        )
        session.add(snippet)

        record = ChitRecord(
            recording_id=recording_id,
            audio_path=audio_path,
            transcript=transcript_text,
            mocked=mocked,
        )
        session.add(record)

        _touch_thread(thread)
        session.add(thread)
        session.flush()

        return RecordStopResponse(
            id=snippet.id,
            recording_id=recording_id,
            audio_path=audio_path,
            transcript=transcript_text,
            mocked=mocked,
            created_at=_iso(snippet.created_at),
            thread_id=thread.id,
            snippet_id=snippet.id,
            snippet_position=snippet.position,
        )


@app.get("/api/chits", response_model=List[ChitResponse])
async def api_list_chits() -> List[ChitResponse]:
    with db_session() as session:
        records = session.query(ChitRecord).order_by(ChitRecord.created_at.asc()).all()
        return [
            ChitResponse(
                id=record.id,
                recording_id=record.recording_id,
                audio_path=record.audio_path,
                transcript=record.transcript,
                mocked=record.mocked,
                created_at=_iso(record.created_at),
            )
            for record in records
        ]


@app.get("/api/threads", response_model=List[ThreadSummaryResponse])
async def api_list_threads() -> List[ThreadSummaryResponse]:
    with db_session() as session:
        threads = (
            session.query(ThreadRecord)
            .order_by(ThreadRecord.is_active.desc(), ThreadRecord.updated_at.desc(), ThreadRecord.created_at.desc())
            .all()
        )
        return [_thread_payload(session, thread) for thread in threads]


@app.get("/api/threads/active", response_model=ThreadDetailResponse)
async def api_active_thread() -> ThreadDetailResponse:
    with db_session() as session:
        thread = _get_active_thread(session, create_if_missing=True)
        return _thread_detail_payload(session, thread)


@app.get("/api/threads/{thread_id}", response_model=ThreadDetailResponse)
async def api_thread_detail(thread_id: str) -> ThreadDetailResponse:
    with db_session() as session:
        thread = _get_thread(session, thread_id)
        return _thread_detail_payload(session, thread)


@app.post("/api/threads", response_model=ThreadDetailResponse)
async def api_create_thread(payload: CreateThreadRequest) -> ThreadDetailResponse:
    title = (payload.title or "").strip() or _default_thread_title()
    with db_session() as session:
        thread = ThreadRecord(title=title, is_active=True)
        session.add(thread)
        session.flush()
        _activate_thread(session, thread)
        return _thread_detail_payload(session, thread)


@app.patch("/api/threads/{thread_id}", response_model=ThreadSummaryResponse)
async def api_update_thread(thread_id: str, payload: UpdateThreadRequest) -> ThreadSummaryResponse:
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Thread title cannot be empty")
    with db_session() as session:
        thread = _get_thread(session, thread_id)
        thread.title = title
        _touch_thread(thread)
        session.add(thread)
        session.flush()
        return _thread_payload(session, thread)


@app.post("/api/threads/{thread_id}/activate", response_model=ThreadDetailResponse)
async def api_activate_thread(thread_id: str) -> ThreadDetailResponse:
    with db_session() as session:
        thread = _get_thread(session, thread_id)
        _activate_thread(session, thread)
        return _thread_detail_payload(session, thread)


@app.post("/api/threads/{thread_id}/snippets", response_model=SnippetResponse)
async def api_create_snippet(thread_id: str, payload: CreateSnippetRequest) -> SnippetResponse:
    transcript = _normalize_input_text(payload.transcript)
    if not transcript:
        raise HTTPException(status_code=400, detail="Snippet transcript cannot be empty")

    with db_session() as session:
        thread = _get_thread(session, thread_id)
        _activate_thread(session, thread)
        snippet = SnippetRecord(
            thread_id=thread.id,
            position=_next_snippet_position(session, thread.id),
            source=(payload.source or "text").strip() or "text",
            transcript=transcript,
        )
        session.add(snippet)
        _touch_thread(thread)
        session.add(thread)
        session.flush()
        return _snippet_payload(snippet)


@app.patch("/api/snippets/{snippet_id}", response_model=SnippetResponse)
async def api_update_snippet(snippet_id: str, payload: UpdateSnippetRequest) -> SnippetResponse:
    transcript = _normalize_input_text(payload.transcript)
    if not transcript:
        raise HTTPException(status_code=400, detail="Snippet transcript cannot be empty")

    with db_session() as session:
        snippet = _get_snippet(session, snippet_id)
        snippet.transcript = transcript
        snippet.updated_at = datetime.now(timezone.utc)
        session.add(snippet)

        thread = _get_thread(session, snippet.thread_id)
        _activate_thread(session, thread)
        session.add(thread)
        session.flush()
        return _snippet_payload(snippet)


@app.get("/api/live", response_model=LiveStatusResponse)
async def api_live() -> LiveStatusResponse:
    recording_id = recorder_service.current_recording_id()
    segments: List[LiveSegmentResponse] = []
    with db_session() as session:
        if recording_id:
            records = (
                session.query(LiveSegment)
                .filter(LiveSegment.recording_id == recording_id)
                .order_by(LiveSegment.chunk_index.asc())
                .all()
            )
        else:
            records = []
        for record in records:
            segments.append(
                LiveSegmentResponse(
                    recording_id=record.recording_id,
                    chunk_index=record.chunk_index,
                    start_ms=record.start_ms,
                    end_ms=record.end_ms,
                    text=record.text,
                    mocked=record.mocked,
                    finalized=record.finalized,
                )
            )
    return LiveStatusResponse(
        status=recorder_service.status(),
        recording_id=recording_id,
        segments=segments,
    )


@app.get("/api/status", response_model=StatusResponse)
async def api_status() -> StatusResponse:
    return StatusResponse(
        status=recorder_service.status(),
        recording_id=recorder_service.current_recording_id(),
        last_error=recorder_service.last_error(),
    )


@app.post("/api/session/export")
async def api_export_session(thread_id: str | None = None) -> dict:
    with db_session() as session:
        thread = _get_thread(session, thread_id) if thread_id else _get_active_thread(session, create_if_missing=False)
        snippets = _list_thread_snippets(session, thread.id)
        if not snippets:
            export_path = Path("sessions") / "session-empty.txt"
            export_path.parent.mkdir(parents=True, exist_ok=True)
            export_path.touch(exist_ok=True)
            return {
                "status": "exported",
                "export_path": str(export_path),
                "entries": 0,
                "thread_id": thread.id,
            }

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        export_path = Path("sessions") / f"thread-{thread.id[:8]}-{timestamp}.txt"
        export_lines = [f"# {thread.title}", ""]
        combined_parts = []
        for snippet in snippets:
            export_lines.append(f"[{snippet.position:02d}] {snippet.transcript.strip()}")
            export_lines.append("")
            combined_parts.append(snippet.transcript.strip())
        export_path.parent.mkdir(parents=True, exist_ok=True)
        export_path.write_text("\n".join(export_lines).strip() + "\n", encoding="utf-8")

        return {
            "status": "exported",
            "export_path": str(export_path),
            "entries": len(snippets),
            "thread_id": thread.id,
            "combined_transcript": "\n\n".join(filter(None, combined_parts)),
        }


@app.post("/api/transcript/clear")
async def api_clear_transcripts(thread_id: str | None = None) -> StatusResponse:
    with db_session() as session:
        target_thread = _get_thread(session, thread_id) if thread_id else _get_active_thread(session)
        session.query(SnippetRecord).filter(SnippetRecord.thread_id == target_thread.id).delete()
        session.query(ChitRecord).delete()
        session.query(LiveSegment).delete()
        _touch_thread(target_thread)
        session.add(target_thread)
    return StatusResponse(status="cleared", last_error=None)


@app.get("/api/agents/options", response_model=List[AgentOptionResponse])
async def api_agent_options() -> List[AgentOptionResponse]:
    return [
        AgentOptionResponse(
            id="vanilla",
            name="Vanilla",
            description="Local dummy agent for testing transcript and thread submission.",
            featured=False,
        ),
        AgentOptionResponse(
            id="openclaw",
            name="OpenClaw",
            description="Featured robot factory preset with a more assertive briefing voice.",
            featured=True,
        ),
        AgentOptionResponse(
            id="gemini_flash",
            name="Gemini Flash",
            description="Uses Gemini Flash to answer snippet/thread content.",
            featured=False,
        ),
    ]


@app.post("/api/agent/run", response_model=AgentResponse)
async def api_agent_run(request: AgentRequest) -> AgentResponse:
    with db_session() as session:
        input_mode, input_text = _resolve_agent_input(session, request)

    if not input_text:
        raise HTTPException(status_code=400, detail="Nothing to send to the agent")

    if request.agent_id == "gemini_flash":
        try:
            output_text = _run_gemini_flash(input_text, input_mode)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        mocked = False
    elif request.agent_id in {"vanilla", "openclaw"}:
        output_text = _dummy_agent_output(request.agent_id, input_mode, input_text)
        mocked = True
    else:
        raise HTTPException(status_code=404, detail="Unknown agent")

    voice_text = output_text if request.response_mode == "voice_text" else None
    return AgentResponse(
        agent_id=request.agent_id,
        input_mode=input_mode,
        response_mode=request.response_mode,
        input_text=input_text,
        output_text=output_text,
        output_voice_text=voice_text,
        mocked=mocked,
        session_id=request.session_id,
    )


@app.post("/api/agent/moneypenny", response_model=AgentResponse)
async def api_agent_moneypenny(request: AgentRequest) -> AgentResponse:
    if _agent_registry is None:
        raise HTTPException(status_code=503, detail="Agent registry not available")
    try:
        agent = _agent_registry.build_agent(MONEYPENNY_ID)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Agent '{MONEYPENNY_ID}' not configured") from exc

    session = _agent_registry.build_session(MONEYPENNY_ID, request.session_id)
    input_mode, input_text = "text", _normalize_input_text(request.text or "")
    if not input_text:
        raise HTTPException(status_code=400, detail="Text is required for Money Penny")
    try:
        result = await Runner.run(agent, input_text, session=session)
    except Exception as exc:  # pragma: no cover - defensive guard
        logger.exception("Money Penny agent call failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return AgentResponse(
        agent_id=MONEYPENNY_ID,
        input_mode=input_mode,
        response_mode=request.response_mode,
        input_text=input_text,
        output_text=result.final_output,
        output_voice_text=result.final_output if request.response_mode == "voice_text" else None,
        mocked=False,
        session_id=request.session_id,
    )


if __name__ == "__main__":
    port = 7100
    uvicorn.run("device_server:app", host="127.0.0.1", port=port, reload=False)
