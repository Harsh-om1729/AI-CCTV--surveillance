import cv2
import os

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|timeout;5000000|stimeout;5000000"
cap = cv2.VideoCapture("rtsp://10.154.81.114:8080/h264_ulaw.sdp")
if cap.isOpened():
    print("TCP connection SUCCESS")
    for i in range(25):
        ok, frame = cap.read()
        if ok and frame is not None and frame.size > 0:
            print("Successfully read a frame!")
            break
    else:
        print("Failed to read any frames!")
else:
    print("TCP connection FAILED")
cap.release()

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "timeout;5000000|stimeout;5000000"
cap = cv2.VideoCapture("rtsp://10.154.81.114:8080/h264_ulaw.sdp")
if cap.isOpened():
    print("UDP connection SUCCESS")
    for i in range(25):
        ok, frame = cap.read()
        if ok and frame is not None and frame.size > 0:
            print("Successfully read a frame!")
            break
    else:
        print("Failed to read any frames!")
else:
    print("UDP connection FAILED")
cap.release()
