import logging

from ultralytics import YOLO

log = logging.getLogger("ibvap.detection")

# COCO class ids relevant to border surveillance (person / vehicle / animal)
PERSON_CLASS_IDS = {0}
VEHICLE_CLASS_IDS = {1, 2, 3, 5, 7}  # bicycle, car, motorcycle, bus, truck
ANIMAL_CLASS_IDS = {15, 16, 17, 18, 19, 20, 21, 22, 23}
RELEVANT_CLASS_IDS = PERSON_CLASS_IDS | VEHICLE_CLASS_IDS | ANIMAL_CLASS_IDS


class Detection:
    __slots__ = (
        "class_id",
        "class_name",
        "confidence",
        "box",
        "track_id",
        "direction",
        "speed",
        "person_id",
        "zone_tier",
        "current_zone",
        "zone_direction",
        "watchlist_match",
        "watchlist_similarity",
        "camera_name",
        "previous_zone",
        "threat_score",
        "threat_level",
        "threat_reasons",
        "status",
        "first_seen",
        "last_seen",
        "last_update",
        "__dict__",
    )

    def __init__(self, class_id: int, class_name: str, confidence: float, box: tuple):
        self.class_id = class_id
        self.class_name = class_name
        self.confidence = confidence
        self.box = box  # (x1, y1, x2, y2) in pixel coords
        self.track_id: int | None = None  # raw ByteTrack id; churns on re-appearance
        self.direction: tuple[float, float] | None = None  # (dx, dy) over recent history
        self.speed: float = 0.0  # pixels/frame over recent history
        self.person_id: int | None = None  # persistent identity from the Re-ID gallery
        self.zone_tier: str | None = None  # "red" | "yellow" | "green" | "none"
        self.current_zone: str | None = None

        self.zone_direction: str | None = None  # "inward" | "outward" | "parallel" | None
        self.watchlist_match: str | None = None  # matched name, if any
        self.watchlist_similarity: float = 0.0
        # Which camera produced this detection. Set by app.py, which is the
        # only place that knows; the incident store persists it so an alert
        # can be traced back to a location. None outside the live pipeline.
        self.camera_name: str | None = None
        # Canonical state tracking
        self.previous_zone: str | None = None
        self.threat_score: float = 0.0
        self.threat_level: str = "LOW"
        self.threat_reasons: list[str] = []
        self.status: str = "DETECTED"
        self.first_seen: float | None = None
        self.last_seen: float | None = None
        self.last_update: float | None = None

    @property
    def ground_point(self) -> tuple[float, float]:
        """Bottom-center reference point (x, y) on the ground."""
        x1, y1, x2, y2 = self.box
        return ((x1 + x2) / 2.0, float(y2))

    def category(self) -> str:
        if self.class_id in PERSON_CLASS_IDS:
            return "person"
        if self.class_id in VEHICLE_CLASS_IDS:
            return "vehicle"
        return "animal"



def model_input_size(model_path: str) -> "int | None":
    """The square input size baked into a fixed-shape ONNX export, or None.

    Ultralytics predicts at 640 unless told otherwise, and a 416/320 export
    rejects a 640 tensor outright ("Got invalid dimensions for input: images
    ... Got: 640 Expected: 416"), so callers must pass the real size.
    """
    if not model_path.endswith(".onnx"):
        return None
    import onnx

    dims = onnx.load(model_path, load_external_data=False).graph.input[0].type.tensor_type.shape.dim
    return (dims[2].dim_value or None) if len(dims) == 4 else None


class Detector:
    """Wraps a YOLOv8 model, filtered down to person/vehicle/animal classes."""

    def __init__(self, model_path: str = "models/yolov8n.onnx", confidence: float = 0.4):
        log.info("Loading YOLO model: %s", model_path)
        self._model = YOLO(model_path, task="detect")
        self.confidence = confidence
        size = model_input_size(model_path)
        self._size_kwargs = {"imgsz": size} if size else {}

    def detect(self, frame) -> list[Detection]:
        results = self._model.predict(
            frame, conf=self.confidence, verbose=False, **self._size_kwargs
        )[0]
        detections = []
        for box in results.boxes:
            class_id = int(box.cls[0])
            if class_id not in RELEVANT_CLASS_IDS:
                continue
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            detections.append(
                Detection(
                    class_id=class_id,
                    class_name=results.names[class_id],
                    confidence=float(box.conf[0]),
                    box=(x1, y1, x2, y2),
                )
            )
        return detections
