import logging
import os
import queue
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

import keyboard
import sounddevice as sd
import soundfile as sf
import numpy as np

import ui

logger = logging.getLogger(__name__)

DEFAULT_SAMPLE_RATE = 16000
DEFAULT_CHANNELS = 1
BUFFER_FLUSH_SECONDS = 0.05
POLL_SLEEP_SECONDS = 0.05
RECORDER_DIR = Path("sessions")
FILE_PREFIX = "snippet"


def _ensure_output_dir(path: Path) -> None:
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)


def _next_output_path(base_dir: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = base_dir / f"{FILE_PREFIX}-{timestamp}.wav"
    counter = 1
    while candidate.exists():
        candidate = base_dir / f"{FILE_PREFIX}-{timestamp}-{counter}.wav"
        counter += 1
    return candidate


def _resolve_input_device(channels: int) -> int | str | None:
    """Resolve a usable input device, falling back when OS default is invalid."""
    requested = os.getenv("WHISP_INPUT_DEVICE", "").strip()
    if requested:
        if requested.isdigit():
            return int(requested)
        devices = sd.query_devices()
        requested_lower = requested.lower()
        for index, device in enumerate(devices):
            name = str(device.get("name", ""))
            if requested_lower in name.lower() and int(device.get("max_input_channels", 0)) >= channels:
                logger.info("Using requested input device name match %s: %s", index, name)
                return index
        # Return raw requested value as a last resort for sounddevice-native lookup.
        return requested

    try:
        default_input = sd.default.device[0] if sd.default.device else None
    except Exception:
        default_input = None

    if isinstance(default_input, int) and default_input >= 0:
        try:
            info = sd.query_devices(default_input)
            if int(info.get("max_input_channels", 0)) >= channels:
                return default_input
        except Exception:
            logger.warning("Default input device %s is unavailable; searching fallback.", default_input)

    devices = sd.query_devices()
    for index, device in enumerate(devices):
        if int(device.get("max_input_channels", 0)) >= channels:
            logger.info("Using fallback input device %s: %s", index, device.get("name", "unknown"))
            return index
    return None


def _resolve_sample_rate(device: int | str | None, requested_sample_rate: int, channels: int) -> int:
    """Validate sample rate for selected input device and fall back to device default."""
    try:
        sd.check_input_settings(device=device, channels=channels, samplerate=requested_sample_rate)
        return requested_sample_rate
    except Exception as exc:
        logger.warning(
            "Sample rate %s invalid for input device %s (%s); using device default.",
            requested_sample_rate,
            device,
            exc,
        )
        if isinstance(device, int):
            info = sd.query_devices(device)
            fallback = int(float(info.get("default_samplerate", requested_sample_rate)))
        else:
            fallback = 44100
        sd.check_input_settings(device=device, channels=channels, samplerate=fallback)
        return fallback


def record_push_to_talk(
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    channels: int = DEFAULT_CHANNELS,
    output_dir: Path | str = RECORDER_DIR,
    frame_consumer: Optional[Callable[[np.ndarray], None]] = None,
) -> str:
    """Record while the space bar is pressed and persist audio to disk."""

    base_dir = Path(output_dir)
    _ensure_output_dir(base_dir)
    target_path = _next_output_path(base_dir)
    input_device = _resolve_input_device(channels=channels)
    if input_device is None:
        raise RuntimeError("No usable input device found. Plug in a mic and set WHISP_INPUT_DEVICE if needed.")
    effective_sample_rate = _resolve_sample_rate(device=input_device, requested_sample_rate=sample_rate, channels=channels)

    audio_queue: "queue.Queue[object]" = queue.Queue()
    indicator_flag = [True]

    def callback(indata, _frames, _time_info, status):
        if status:
            logger.warning("Input stream status: %s", status)
        audio_queue.put(indata.copy())

    indicator_thread = threading.Thread(
        target=ui.record_indicator,
        args=(indicator_flag,),
        daemon=True,
    )

    logger.info("Waiting for push-to-talk gesture")
    while not keyboard.is_pressed("space"):
        time.sleep(POLL_SLEEP_SECONDS)

    indicator_thread.start()

    logger.info("Recording started -> %s", target_path)
    stop_requested = False

    with sf.SoundFile(
        target_path,
        mode="w",
        samplerate=effective_sample_rate,
        channels=channels,
    ) as wav_file:
        with sd.InputStream(
            samplerate=effective_sample_rate,
            channels=channels,
            device=input_device,
            callback=callback,
        ):
            while True:
                if not stop_requested:
                    if keyboard.is_pressed("backspace") or not keyboard.is_pressed("space"):
                        stop_requested = True

                try:
                    chunk = audio_queue.get(timeout=BUFFER_FLUSH_SECONDS)
                except queue.Empty:
                    if stop_requested:
                        break
                    continue


                if channels == 1 and getattr(chunk, "ndim", 1) > 1:
                    # Downmix extra channels to mono if the driver delivers more than requested
                    chunk = chunk.mean(axis=1)

                if frame_consumer is not None:
                    frame_consumer(chunk)

                wav_file.write(chunk)

                if stop_requested and audio_queue.empty():
                    break


            while not audio_queue.empty():
                chunk = audio_queue.get()
                if channels == 1 and getattr(chunk, "ndim", 1) > 1:
                    chunk = chunk.mean(axis=1)
                if frame_consumer is not None:
                    frame_consumer(chunk)
                wav_file.write(chunk)


    indicator_flag[0] = False
    indicator_thread.join(timeout=1)
    logger.info("Recording finished -> %s", target_path)

    return str(target_path)
