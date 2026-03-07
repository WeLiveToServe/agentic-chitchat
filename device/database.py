"""Device-side database setup using SQLAlchemy on top of SQLite."""
from __future__ import annotations

import os
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String, Text, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

DB_PATH = Path(os.getenv("WHISP_DEVICE_DB_PATH", str(Path("sessions") / "device.db")))
DB_URL = f"sqlite:///{DB_PATH}"

Base = declarative_base()
engine = create_engine(DB_URL, echo=False, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ChitRecord(Base):
    __tablename__ = "chits"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    recording_id = Column(String, nullable=True)
    audio_path = Column(String, nullable=False)
    transcript = Column(String, nullable=False)
    mocked = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)


class LiveSegment(Base):
    __tablename__ = "live_segments"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    recording_id = Column(String, nullable=False)
    chunk_index = Column(Integer, nullable=False)
    start_ms = Column(Float, nullable=False)
    end_ms = Column(Float, nullable=False)
    text = Column(String, nullable=False)
    mocked = Column(Boolean, default=False, nullable=False)
    finalized = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)


class ThreadRecord(Base):
    __tablename__ = "threads"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    title = Column(String, nullable=False)
    is_active = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, nullable=False)


class SnippetRecord(Base):
    __tablename__ = "snippets"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    thread_id = Column(String, nullable=False, index=True)
    position = Column(Integer, nullable=False)
    source = Column(String, default="voice", nullable=False)
    audio_path = Column(String, nullable=True)
    transcript = Column(Text, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, nullable=False)


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)


@contextmanager
def db_session():
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
