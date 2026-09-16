"""Offline unit tests for reid/embedder.py's illumination normalization.
Run from ibvap/: python -m unittest tests.test_embedder

No ONNX model or camera required — these test `_normalize_illumination`
directly, the pure-OpenCV step that runs before every crop reaches OSNet.
"""
import unittest

import numpy as np

from reid.embedder import _normalize_illumination


class TestIlluminationNormalization(unittest.TestCase):
    def _textured_crop(self, seed: int = 42) -> np.ndarray:
        # CLAHE normalizes *local contrast*, which needs texture to act on —
        # a flat solid color has none, so a random textured crop stands in
        # for a real person crop's clothing/skin detail.
        rng = np.random.default_rng(seed)
        return rng.integers(80, 180, size=(256, 128, 3)).astype(np.uint8)

    def test_reduces_the_gap_between_a_bright_and_a_dim_capture_of_the_same_scene(self):
        """The core claim behind this fix: two cameras disagreeing on whether
        to apply their own low-light boost must not make the same person's
        crop look more different to the Re-ID model than the person actually
        is. Normalizing both closes most of that brightness-driven gap."""
        base = self._textured_crop()
        bright = np.clip(base.astype(np.int16) + 40, 0, 255).astype(np.uint8)
        dim = np.clip(base.astype(np.int16) - 60, 0, 255).astype(np.uint8)

        raw_gap = float(np.mean(np.abs(bright.astype(np.int16) - dim.astype(np.int16))))
        normalized_gap = float(np.mean(np.abs(
            _normalize_illumination(bright).astype(np.int16)
            - _normalize_illumination(dim).astype(np.int16)
        )))

        self.assertLess(normalized_gap, raw_gap * 0.6)

    def test_output_shape_and_dtype_are_preserved(self):
        crop = self._textured_crop()
        normalized = _normalize_illumination(crop)
        self.assertEqual(normalized.shape, crop.shape)
        self.assertEqual(normalized.dtype, crop.dtype)

    def test_does_not_crash_on_a_uniform_crop(self):
        """A solid-color crop (edge case: a heavily motion-blurred or
        saturated capture) has no local contrast for CLAHE to act on — must
        not raise, since embed() calls this unconditionally on every crop."""
        flat = np.full((256, 128, 3), 128, dtype=np.uint8)
        normalized = _normalize_illumination(flat)
        self.assertEqual(normalized.shape, flat.shape)


if __name__ == "__main__":
    unittest.main()
