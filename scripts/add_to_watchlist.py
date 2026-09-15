"""Seeds the watchlist with a known face from a photo.
Run from ibvap/: python scripts/add_to_watchlist.py "<name>" <image_path>
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cv2

from face.face_recognizer import FaceRecognizer
from face.watchlist import WatchlistDB


def main() -> None:
    if len(sys.argv) != 3:
        print('Usage: python scripts/add_to_watchlist.py "<name>" <image_path>')
        sys.exit(1)

    name, image_path = sys.argv[1], sys.argv[2]

    frame = cv2.imread(image_path)
    if frame is None:
        print(f"Could not read image: {image_path}")
        sys.exit(1)

    print("Loading face recognizer (first run downloads model weights)...")
    recognizer = FaceRecognizer()

    embedding = recognizer.embed_portrait(frame)
    if embedding is None:
        print("No face detected in that image — try a clearer, more frontal photo.")
        sys.exit(1)

    watchlist = WatchlistDB()
    watchlist.add_person(name, embedding)
    watchlist.close()
    print(f"Added '{name}' to the watchlist.")


if __name__ == "__main__":
    main()
