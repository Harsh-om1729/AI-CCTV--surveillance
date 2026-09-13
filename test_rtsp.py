import cv2
import os

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "timeout;5000000|stimeout;5000000"
cap = cv2.VideoCapture("rtsp://10.154.81.114:8080/h264_ulaw.sdp")
if cap.isOpened():
    print("UDP connection SUCCESS")
else:
    print("UDP connection FAILED")
cap.release()

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|timeout;5000000|stimeout;5000000"
cap = cv2.VideoCapture("rtsp://10.154.81.114:8080/h264_ulaw.sdp")
if cap.isOpened():
    print("TCP connection SUCCESS")
else:
    print("TCP connection FAILED")
cap.release()
