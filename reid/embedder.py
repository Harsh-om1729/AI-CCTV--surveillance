import logging
import os

import cv2
import numpy as np
import onnxruntime as ort

from config.providers import select_providers

log = logging.getLogger("ibvap.reid")

# torchreid's preprocessing convention for OSNet: RGB, scaled to 0-1, then
# ImageNet mean/std. The weights were trained under exactly this pipeline, so
# it has to match or the embeddings land off-distribution.
_MEAN = np.array([0.485, 0.456, 0.406], np.float32).reshape(3, 1, 1)
_STD = np.array([0.229, 0.224, 0.225], np.float32).reshape(3, 1, 1)

# Person Re-ID convention: a 1:2 portrait input, not a square. Squashing a
# ~60x160 person box into a square distorts every body proportion, and the
# distortion varies with how far away the person is standing — so the same
# person at two distances lands in two different places in feature space.
_INPUT_WIDTH, _INPUT_HEIGHT = 128, 256

DEFAULT_MODEL_PATH = "models/osnet_x0_25_msmt17.onnx"


def _normalize_illumination(crop: np.ndarray) -> np.ndarray:
    """Flattens out ambient-lighting differences on the crop itself, always,
    regardless of what the caller's frame-level pipeline already did.

    Why this exists: app.py's per-camera Preprocessor (preprocessing/enhance.py)
    only applies CLAHE + gamma correction to a WHOLE FRAME when THAT camera's
    OWN measured brightness drops below its threshold — and it feeds that same
    conditionally-processed frame into this embedder. Two cameras watching the
    same person a few seconds apart routinely disagree on whether their own
    scene counted as "dark enough" to boost, so the same person's crop can
    reach OSNet raw from one camera and gamma/CLAHE-corrected from another.
    That is a real shift in feature space having nothing to do with identity,
    and it is exactly the kind of gap a similarity threshold can fall into.
    Applying a mild, ALWAYS-ON illumination normalization here — after the
    frame-level pipeline, on the crop specifically — means every embedding
    this class ever produces went through the same normalization, so ambient
    brightness stops being a variable the Re-ID match has to survive.
    """
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    # Mild by design: this always runs, including on crops the frame-level
    # boost already corrected, so a strong clip limit would double-correct an
    # already-boosted crop. 2.0/(4x4) is gentler than enhance.py's 3.0/(8x8),
    # which only ever runs once per frame on genuinely dark scenes.
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4))
    l_channel = clahe.apply(l_channel)
    lab = cv2.merge((l_channel, a_channel, b_channel))
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


class OSNetEmbedder:
    """Person Re-ID appearance embedding: OSNet x0.25 trained on MSMT17.

    Replaces the ImageNet-pretrained ResNet-18 this used to run. ResNet-18 was
    trained to answer "is this a bus or a dog", so its features describe generic
    texture and shape and barely encode *which person* this is — measured on
    real pedestrian crops, unrelated people scored up to 0.795 cosine, above the
    0.70 threshold that was configured, so strangers were merged onto one
    person_id. OSNet is trained for person Re-ID specifically; on the same
    crops unrelated people top out at 0.501 while the same person under box
    jitter stays above 0.872 — a separation gap of 0.371 vs ResNet-18's 0.139.

    Runs through onnxruntime (already used for the YOLO detector), so no extra
    runtime dependency. The weights ship in `models/` and are never fetched at
    runtime, which keeps Phase 14's air-gapped operation intact.

    Provenance: exported from the OSNet author's released MSMT17 weights
    (huggingface.co/kaiyangzhou/osnet); the ONNX is byte-identical across the
    kornia/osnet and anriha/osnet_x0_25_msmt17 mirrors. Only change made was
    marking the batch dimension dynamic (the published file was fixed at 16),
    verified bit-exact against the original at batch 16 and batch 1.
    """

    def __init__(self, model_path: str = DEFAULT_MODEL_PATH):
        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"Re-ID model not found: {model_path}. Without it there is no "
                "person embedding, and falling back to a generic ImageNet "
                "backbone silently reintroduces cross-person ID merging — so "
                "this is a hard failure rather than a degraded mode."
            )
        log.info("Loading OSNet Re-ID model: %s", model_path)
        self._session = ort.InferenceSession(model_path, providers=select_providers())
        self._input_name = self._session.get_inputs()[0].name

    def embed(self, frame: np.ndarray, box: tuple) -> "np.ndarray | None":
        x1, y1, x2, y2 = box
        width, height = x2 - x1, y2 - y1
        if width < 40 or height < 60:
            return None

        x1, y1 = max(x1, 0), max(y1, 0)
        crop = frame[y1:y2, x1:x2]
        if crop.size == 0:
            return None

        resized = cv2.resize(crop, (_INPUT_WIDTH, _INPUT_HEIGHT))
        resized = _normalize_illumination(resized)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
        tensor = (rgb.transpose(2, 0, 1).astype(np.float32) / 255.0 - _MEAN) / _STD

        features = self._session.run(None, {self._input_name: tensor[None]})[0][0]

        norm = float(np.linalg.norm(features))
        if norm == 0.0:
            return None
        return (features / norm).astype(np.float32)
