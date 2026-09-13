import time
from integration.api import registry

cam = registry.acquire("ha")
seq = -1
frames = 0
start = time.time()
while time.time() - start < 5:
    jpeg, seq = cam.wait_for_frame(seq, timeout=1.0)
    if jpeg:
        frames += 1
print(f"Read {frames} frames from registry in 5 seconds.")
registry.release("ha")
registry.reap_idle()  # force reaper to run maybe
time.sleep(2) # wait for shutdown
