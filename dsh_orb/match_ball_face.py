"""Match the face the ball is wearing against every clip in the pack.

The page cannot be asked what it is showing, but it can be photographed, and the pack is a known set of
candidates. Each candidate is rendered to the same size and compared against the ball's own pixels by mean
absolute difference, so the answer is "which file is this", not "did something change".

The ball's window is frameless with a transparent surround, so only the part of the photograph that is
drawn is compared, and each candidate is compared over its own aspect ratio at that size.

Usage: ``python dsh_orb/match_ball_face.py [--dir <pack>] [--want <file.gif>]``
"""

import ctypes
import ctypes.wintypes as w
import io
import os
import sys

import numpy
from PIL import Image, ImageSequence

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

HOME = os.path.expanduser('~')
PACK = os.path.join(HOME, 'Desktop', 'dsh-orb-cordis', '大肥鱼表情包整合')
want = None
if '--dir' in sys.argv:
    PACK = sys.argv[sys.argv.index('--dir') + 1]
if '--want' in sys.argv:
    want = sys.argv[sys.argv.index('--want') + 1]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', w.DWORD), ('biWidth', ctypes.c_long), ('biHeight', ctypes.c_long),
        ('biPlanes', w.WORD), ('biBitCount', w.WORD), ('biCompression', w.DWORD),
        ('biSizeImage', w.DWORD), ('biXPelsPerMeter', ctypes.c_long), ('biYPelsPerMeter', ctypes.c_long),
        ('biClrUsed', w.DWORD), ('biClrImportant', w.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', w.DWORD * 3)]


def image_name(pid):
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return ''
    try:
        size = w.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(1024)
        if ctypes.windll.kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return ''
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def ball_window():
    found = []

    @ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    def callback(handle, _param):
        pid = w.DWORD()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        if not user32.IsWindowVisible(handle):
            return True
        box = w.RECT()
        user32.GetWindowRect(handle, ctypes.byref(box))
        width, height = box.right - box.left, box.bottom - box.top
        if width > 20 and height > 20 and image_name(pid.value).lower().endswith('electron.exe'):
            found.append({'handle': handle, 'width': width, 'height': height, 'pid': pid.value})
        return True

    user32.EnumWindows(callback, 0)
    return max(found, key=lambda item: item['width'] * item['height']) if found else None


def photograph(target):
    """The ball window as an RGBA array, top-down."""
    window_dc = user32.GetWindowDC(target['handle'])
    memory_dc = gdi32.CreateCompatibleDC(window_dc)
    bitmap = gdi32.CreateCompatibleBitmap(window_dc, target['width'], target['height'])
    gdi32.SelectObject(memory_dc, bitmap)
    if not user32.PrintWindow(target['handle'], memory_dc, 2):
        user32.PrintWindow(target['handle'], memory_dc, 0)
    info = BITMAPINFO()
    info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    info.bmiHeader.biWidth = target['width']
    info.bmiHeader.biHeight = -target['height']
    info.bmiHeader.biPlanes = 1
    info.bmiHeader.biBitCount = 32
    buffer = ctypes.create_string_buffer(target['width'] * target['height'] * 4)
    gdi32.GetDIBits(memory_dc, bitmap, 0, target['height'], buffer, ctypes.byref(info), 0)
    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(memory_dc)
    user32.ReleaseDC(target['handle'], window_dc)
    pixels = numpy.frombuffer(buffer.raw, dtype=numpy.uint8)
    pixels = pixels.reshape(target['height'], target['width'], 4)[:, :, [2, 1, 0, 3]]
    return pixels


target = ball_window()
if target is None:
    print('no ball window found')
    raise SystemExit(1)
photo = photograph(target)
# The drawn part: anything that is neither transparent nor pure black, which is the window's own backdrop.
alpha = photo[:, :, 3]
visible = alpha > 0
luma = photo[:, :, :3].max(axis=2)
drawn = visible & (luma > 24)
rows = numpy.flatnonzero(drawn.any(axis=1))
columns = numpy.flatnonzero(drawn.any(axis=0))
if rows.size == 0 or columns.size == 0:
    print('the ball window has nothing drawn in it')
    raise SystemExit(1)
crop = photo[rows[0]:rows[-1] + 1, columns[0]:columns[-1] + 1]
print(f"ball window {target['width']}x{target['height']}, drawn {crop.shape[1]}x{crop.shape[0]} at ({columns[0]},{rows[0]})")
Image.fromarray(crop, 'RGBA').save(os.path.join(os.environ['TEMP'], 'ball-face.png'))
print(f"saved {os.path.join(os.environ['TEMP'], 'ball-face.png')}")

# Every clip in the pack, first frame and middle frame, resized to the ball's own drawn size.
candidates = []
for root, _dirs, files in os.walk(PACK):
    for name in files:
        if not name.lower().endswith('.gif'):
            continue
        path = os.path.join(root, name)
        try:
            with Image.open(path) as image:
                frames = [frame.convert('RGBA') for frame in ImageSequence.Iterator(image)]
        except Exception:
            continue
        if not frames:
            continue
        picks = [frames[0]] if len(frames) == 1 else [frames[0], frames[len(frames) // 2]]
        candidates.append((name, picks))

def difference(a, b):
    """Mean absolute difference over the pixels both have, ignoring alpha."""
    height = min(a.shape[0], b.shape[0])
    width = min(a.shape[1], b.shape[1])
    left = a[:height, :width, :3].astype(numpy.int16)
    right = b[:height, :width, :3].astype(numpy.int16)
    return float(numpy.abs(left - right).mean())

scored = []
for name, picks in candidates:
    best = min(
        difference(crop, numpy.array(frame.resize((crop.shape[1], crop.shape[0]), Image.LANCZOS)))
        for frame in picks
    )
    scored.append((best, name))
scored.sort()
print(f'\ncompared {len(scored)} clips; the closest few:')
for score, name in scored[:8]:
    print(f'  {score:7.2f}  {name}')
if want is not None:
    for score, name in scored:
        if name == want:
            print(f'\nthe slot in question, {want}: difference {score:.2f} (rank {scored.index((score, name)) + 1})')
            break
