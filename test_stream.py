import urllib.request, time
tok = open('frontend/.env').read().split('VITE_API_TOKEN=')[1].split('\n')[0]
req = urllib.request.Request(f'http://127.0.0.1:8000/api/v1/cameras/cam0/stream?token={tok}')
try:
    resp = urllib.request.urlopen(req, timeout=5)
    print("Connected to cam0")
    for _ in range(5):
        line = resp.readline()
        print(line)
except Exception as e:
    print("Error:", e)
