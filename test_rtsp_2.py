import cv2
import time
import os

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|timeout;5000000|stimeout;5000000"
url = "rtsp://10.154.81.114:8080/h264_ulaw.sdp"

print("Opening first connection...")
cap1 = cv2.VideoCapture(url)
if cap1.isOpened():
    print("Cap1 SUCCESS")
else:
    print("Cap1 FAILED")

print("Opening second connection...")
cap2 = cv2.VideoCapture(url)
if cap2.isOpened():
    print("Cap2 SUCCESS")
else:
    print("Cap2 FAILED")

cap1.release()
cap2.release()
