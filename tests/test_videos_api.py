"""API tests for the offline video replay endpoints (/videos*).

Covers: raw-body upload (no python-multipart dependency), the activate/
deactivate .env CAMERA_SOURCES round-trip (only the CAMERA_SOURCES= line is
touched, everything else in .env is preserved verbatim), and delete.

Run from ibvap/: python -m unittest tests.test_videos_api
"""
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import integration.api as api_module

TOKEN = "videos-test-token-not-a-real-secret"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class TestVideosApi(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.uploads_dir = os.path.join(self.tmp, "uploads", "videos")
        self.env_path = os.path.join(self.tmp, ".env")
        with open(self.env_path, "w") as f:
            f.write("LOG_LEVEL=INFO\nCAMERA_SOURCES=cam0=0\nBRIGHTNESS_THRESHOLD=90\n")

        for p in (
            patch.object(api_module, "IBVAP_API_TOKEN", TOKEN),
            patch.object(api_module, "UPLOADS_DIR", self.uploads_dir),
            patch.object(api_module, "ENV_FILE", self.env_path),
            patch.object(api_module, "_pipeline_owns", lambda cam_id: False),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(api_module.app)

    def _upload(self, filename="clip.mp4", body=b"fake-video-bytes"):
        return self.client.post(
            "/api/v1/videos/upload",
            headers=AUTH,
            params={"filename": filename},
            content=body,
        )

    def test_upload_writes_the_file_and_lists_it(self):
        resp = self._upload()
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["id"], "clip.mp4")
        self.assertEqual(data["cameraId"], "replay_clip")
        self.assertEqual(data["sizeBytes"], len(b"fake-video-bytes"))
        self.assertTrue(os.path.isfile(os.path.join(self.uploads_dir, "clip.mp4")))

        listed = self.client.get("/api/v1/videos", headers=AUTH).json()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], "clip.mp4")
        self.assertFalse(listed[0]["isActive"])

    def test_upload_rejects_a_disallowed_extension(self):
        resp = self._upload(filename="malware.exe")
        self.assertEqual(resp.status_code, 400)

    def test_upload_sanitises_the_filename(self):
        resp = self._upload(filename="../../etc/passwd.mp4")
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("..", resp.json()["id"])
        self.assertNotIn("/", resp.json()["id"])

    def test_duplicate_filename_gets_suffixed_not_overwritten(self):
        self._upload(filename="clip.mp4", body=b"first")
        resp = self._upload(filename="clip.mp4", body=b"second")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["id"], "clip_1.mp4")
        listed = self.client.get("/api/v1/videos", headers=AUTH).json()
        self.assertEqual(len(listed), 2)

    def test_activate_adds_camera_source_and_preserves_the_rest_of_env(self):
        self._upload()
        resp = self.client.post("/api/v1/videos/clip.mp4/activate", headers=AUTH)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["cameraId"], "replay_clip")
        self.assertTrue(resp.json()["needsRestart"])

        with open(self.env_path) as f:
            content = f.read()
        self.assertIn("LOG_LEVEL=INFO", content)
        self.assertIn("BRIGHTNESS_THRESHOLD=90", content)
        self.assertIn("CAMERA_SOURCES=", content)
        camera_line = [l for l in content.splitlines() if l.startswith("CAMERA_SOURCES=")][0]
        self.assertIn("cam0=0", camera_line)
        self.assertIn("replay_clip=", camera_line)

        listed = self.client.get("/api/v1/videos", headers=AUTH).json()
        self.assertTrue(listed[0]["isActive"])
        self.assertTrue(listed[0]["needsRestart"])  # _pipeline_owns patched to False

    def test_activate_missing_video_404s(self):
        resp = self.client.post("/api/v1/videos/nope.mp4/activate", headers=AUTH)
        self.assertEqual(resp.status_code, 404)

    def test_deactivate_removes_only_that_camera_source(self):
        self._upload()
        self.client.post("/api/v1/videos/clip.mp4/activate", headers=AUTH)
        resp = self.client.post("/api/v1/videos/clip.mp4/deactivate", headers=AUTH)
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["needsRestart"])

        with open(self.env_path) as f:
            content = f.read()
        camera_line = [l for l in content.splitlines() if l.startswith("CAMERA_SOURCES=")][0]
        self.assertIn("cam0=0", camera_line)
        self.assertNotIn("replay_clip", camera_line)

    def test_deactivate_when_not_active_is_a_no_op(self):
        self._upload()
        resp = self.client.post("/api/v1/videos/clip.mp4/deactivate", headers=AUTH)
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["needsRestart"])

    def test_delete_removes_file_and_deactivates(self):
        self._upload()
        self.client.post("/api/v1/videos/clip.mp4/activate", headers=AUTH)
        resp = self.client.delete("/api/v1/videos/clip.mp4", headers=AUTH)
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["needsRestart"])
        self.assertFalse(os.path.isfile(os.path.join(self.uploads_dir, "clip.mp4")))

        with open(self.env_path) as f:
            content = f.read()
        self.assertNotIn("replay_clip", content)

    def test_requires_auth(self):
        resp = self.client.get("/api/v1/videos")
        self.assertEqual(resp.status_code, 401)


if __name__ == "__main__":
    unittest.main()
