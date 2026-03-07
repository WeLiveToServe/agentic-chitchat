import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


class DeviceServerThreadWorkflowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

        os.environ["WHISP_DEVICE_DB_PATH"] = str(Path(self.temp_dir.name) / "device-test.db")
        self.addCleanup(lambda: os.environ.pop("WHISP_DEVICE_DB_PATH", None))

        if "device.database" in sys.modules:
            importlib.reload(sys.modules["device.database"])
        else:
            import device.database  # noqa: F401

        if "device_server" in sys.modules:
            importlib.reload(sys.modules["device_server"])
        else:
            import device_server  # noqa: F401

        self.db = sys.modules["device.database"]
        self.server = sys.modules["device_server"]
        self.db.init_db()
        self.addCleanup(self.db.engine.dispose)

        with self.db.db_session() as session:
            session.query(self.db.SnippetRecord).delete()
            session.query(self.db.ThreadRecord).delete()
            session.query(self.db.ChitRecord).delete()
            session.query(self.db.LiveSegment).delete()

        self.start_patch = mock.patch.object(self.server.recorder_service, "start", return_value="rec-001")
        self.stop_patch = mock.patch.object(
            self.server.recorder_service,
            "stop",
            return_value={"audio_path": "sessions/fake.wav", "recording_id": "rec-001"},
        )
        self.transcribe_patch = mock.patch.object(self.server, "transcribe", return_value=("voice snippet", True))
        self.start_patch.start()
        self.stop_patch.start()
        self.transcribe_patch.start()
        self.addCleanup(self.start_patch.stop)
        self.addCleanup(self.stop_patch.stop)
        self.addCleanup(self.transcribe_patch.stop)

        self.client = TestClient(self.server.app)
        self.client.__enter__()
        self.addCleanup(lambda: self.client.__exit__(None, None, None))

    def test_thread_and_snippet_workflow(self) -> None:
        active = self.client.get("/api/threads/active")
        self.assertEqual(active.status_code, 200)
        active_payload = active.json()
        self.assertEqual(active_payload["snippets"], [])
        thread_id = active_payload["thread"]["id"]

        start_response = self.client.post("/api/record/start")
        self.assertEqual(start_response.status_code, 200)
        self.assertEqual(start_response.json()["recording_id"], "rec-001")

        stop_response = self.client.post(f"/api/record/stop?thread_id={thread_id}")
        self.assertEqual(stop_response.status_code, 200)
        stop_payload = stop_response.json()
        self.assertEqual(stop_payload["thread_id"], thread_id)
        self.assertEqual(stop_payload["snippet_position"], 1)

        snippet_id = stop_payload["snippet_id"]
        update_response = self.client.patch(
            f"/api/snippets/{snippet_id}",
            json={"transcript": "edited snippet"},
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.json()["transcript"], "edited snippet")

        add_response = self.client.post(
            f"/api/threads/{thread_id}/snippets",
            json={"transcript": "manual follow up", "source": "text"},
        )
        self.assertEqual(add_response.status_code, 200)
        self.assertEqual(add_response.json()["position"], 2)

        detail_response = self.client.get(f"/api/threads/{thread_id}")
        self.assertEqual(detail_response.status_code, 200)
        detail_payload = detail_response.json()
        self.assertEqual(len(detail_payload["snippets"]), 2)
        self.assertEqual(detail_payload["snippets"][0]["transcript"], "edited snippet")
        self.assertEqual(detail_payload["snippets"][1]["transcript"], "manual follow up")

        agent_response = self.client.post(
            "/api/agent/run",
            json={
                "agent_id": "vanilla",
                "input_mode": "thread",
                "thread_id": thread_id,
                "response_mode": "text_only",
            },
        )
        self.assertEqual(agent_response.status_code, 200)
        self.assertIn("VANILLA AGENT", agent_response.json()["output_text"])

        second_thread = self.client.post("/api/threads", json={"title": "SECOND STACK"})
        self.assertEqual(second_thread.status_code, 200)
        second_payload = second_thread.json()
        self.assertEqual(second_payload["thread"]["title"], "SECOND STACK")
        self.assertTrue(second_payload["thread"]["is_active"])

        threads_response = self.client.get("/api/threads")
        self.assertEqual(threads_response.status_code, 200)
        threads_payload = threads_response.json()
        self.assertEqual(len(threads_payload), 2)
        self.assertEqual(threads_payload[0]["title"], "SECOND STACK")


if __name__ == "__main__":
    unittest.main()
