import json
import logging
import os
import sqlite3
import time

import numpy as np
from cryptography.fernet import Fernet, InvalidToken

from config.settings import WATCHLIST_KEY_PATH
from database.keys import load_or_create_key
from face.face_recognizer import cosine_similarity

log = logging.getLogger("ibvap.face")


class WatchlistDB:
    """Local, offline watchlist of known-person face embeddings (SQLite).
    In a real deployment this would be updated via the same encrypted-USB
    transfer mechanism as threat_rules.db — no cloud, no network dependency,
    matching the air-gapped requirement.

    Face embeddings are personal biometric data, so they are encrypted at
    rest (Fernet — the same mechanism the evidence store uses, via
    `database.keys`) rather than sitting in the DB file as readable JSON.
    Losing the key makes existing rows unreadable, the same tradeoff as every
    other local-key store in this build.

    NOTE for the SIH report: any real deployment of a watchlist database
    needs authorized data-handling procedures under India's DPDP Act — this
    is genuine personal biometric data, not a detail to gloss over.
    """

    def __init__(
        self,
        db_path: str = "database/watchlist.db",
        key_path: str | None = None,
        photo_dir: str = "snapshots/watchlist_photos",
    ):
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        if key_path is None:
            key_path = WATCHLIST_KEY_PATH
        self._fernet = Fernet(load_or_create_key(key_path, purpose="watchlist"))
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._photo_dir = photo_dir
        os.makedirs(self._photo_dir, exist_ok=True)
        self._create_table()

    def _encrypt_embedding(self, embedding: np.ndarray) -> str:
        """Serialises and encrypts an embedding for storage. The plaintext
        vector is never logged."""
        plaintext = json.dumps(embedding.tolist()).encode("utf-8")
        return self._fernet.encrypt(plaintext).decode("ascii")

    def _decrypt_embedding(self, stored: str) -> np.ndarray:
        """Inverse of `_encrypt_embedding`, tolerating pre-encryption rows.

        Rows written before embeddings were encrypted are plain JSON. Those
        still decode, so an existing watchlist.db keeps working; anything
        written from now on is encrypted. Neither branch logs the vector.
        """
        try:
            plaintext = self._fernet.decrypt(stored.encode("ascii"))
        except (InvalidToken, UnicodeEncodeError):
            # Legacy plaintext row (or a row encrypted under a different key).
            # json.loads distinguishes the two: a legacy row parses, a
            # wrong-key row does not and raises for the caller to see.
            return np.array(json.loads(stored), dtype=np.float32)
        return np.array(json.loads(plaintext.decode("utf-8")), dtype=np.float32)

    def _create_table(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                embedding TEXT NOT NULL
            )
            """
        )
        # Operator-facing columns (integration/api.py's _watchlist_meta adds
        # the same ones on the API side) — ensured here too so record_match
        # below works even when the pipeline runs before the API ever has.
        cur = self._conn.execute("PRAGMA table_info(watchlist)")
        existing = {row[1] for row in cur.fetchall()}
        for col, ddl in (
            ("notes", "TEXT"),
            ("added_at", "REAL"),
            ("last_matched_at", "REAL"),
            ("match_count", "INTEGER NOT NULL DEFAULT 0"),
            ("photo_path", "TEXT"),
        ):
            if col not in existing:
                self._conn.execute(f"ALTER TABLE watchlist ADD COLUMN {col} {ddl}")
        self._conn.commit()

    def add_person(self, name: str, embedding: np.ndarray) -> int:
        cur = self._conn.execute(
            "INSERT INTO watchlist (name, embedding) VALUES (?, ?)",
            (name, self._encrypt_embedding(embedding)),
        )
        self._conn.commit()
        log.info("Added '%s' to watchlist (id=%d)", name, cur.lastrowid)
        return cur.lastrowid

    def all_entries(self) -> list:
        cur = self._conn.execute("SELECT id, name, embedding FROM watchlist")
        return [
            (row[0], row[1], self._decrypt_embedding(row[2])) for row in cur.fetchall()
        ]

    def save_photo(self, person_id: int, jpeg_bytes: bytes) -> str:
        """Encrypts and stores the enrollment photo the operator uploaded,
        so the watchlist UI (and a live-feed match banner) can show the
        actual reference photo instead of a generated placeholder. Encrypted
        at rest with the same key as the embeddings, for the same reason —
        this is still biometric-identifying material once linked to a name.
        """
        path = os.path.join(self._photo_dir, f"{person_id}.jpg.enc")
        with open(path, "wb") as f:
            f.write(self._fernet.encrypt(jpeg_bytes))
        self._conn.execute("UPDATE watchlist SET photo_path = ? WHERE id = ?", (path, person_id))
        self._conn.commit()
        return path

    def get_photo_bytes(self, person_id: int) -> "bytes | None":
        cur = self._conn.execute("SELECT photo_path FROM watchlist WHERE id = ?", (person_id,))
        row = cur.fetchone()
        if row is None or not row[0] or not os.path.exists(row[0]):
            return None
        with open(row[0], "rb") as f:
            encrypted = f.read()
        try:
            return self._fernet.decrypt(encrypted)
        except InvalidToken:
            return None

    def delete_person(self, person_id: int) -> None:
        cur = self._conn.execute("SELECT photo_path FROM watchlist WHERE id = ?", (person_id,))
        row = cur.fetchone()
        self._conn.execute("DELETE FROM watchlist WHERE id = ?", (person_id,))
        self._conn.commit()
        if row and row[0] and os.path.exists(row[0]):
            os.remove(row[0])

    def record_match(self, name: str, timestamp: "float | None" = None) -> None:
        """Bumps match_count/last_matched_at for every watchlist row with
        this name — called once per recorded incident (see AlertManager),
        not once per frame, so the count reflects actual sightings rather
        than how many times a track happened to be re-checked."""
        self._conn.execute(
            "UPDATE watchlist SET match_count = match_count + 1, last_matched_at = ? WHERE name = ?",
            (timestamp if timestamp is not None else time.time(), name),
        )
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()


class WatchlistMatcher:
    """Cosine-similarity match against the watchlist. A match instantly
    escalates the track to Red tier regardless of zone score (applied by the
    caller) — false positives here are a real operational risk, so this
    returns the matched name and similarity for transparency, never a bare
    yes/no, per the roadmap's testing checklist.
    """

    def __init__(self, watchlist: WatchlistDB, similarity_threshold: float = 0.5):
        self.watchlist = watchlist
        self.similarity_threshold = similarity_threshold

    def match(self, embedding: np.ndarray):
        best_name = None
        best_similarity = 0.0
        for _id, name, entry_embedding in self.watchlist.all_entries():
            similarity = cosine_similarity(embedding, entry_embedding)
            if similarity > best_similarity:
                best_similarity = similarity
                best_name = name

        if best_name is not None and best_similarity >= self.similarity_threshold:
            return best_name, best_similarity
        return None, best_similarity
