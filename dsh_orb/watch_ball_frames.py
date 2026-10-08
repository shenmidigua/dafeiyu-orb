"""Watch the ball window and report the part of it that is actually drawn.

The page cannot be inspected from here, so this reads the thing the page actually does: it paints a
window. Three readings are taken from the same pixels:

* the **content box** -- the smallest rectangle that is not transparent. The ball window is a frameless
  Electron window whose real size is not the ball's size, so a hash of the whole window reports differences
  from empty space; the box is what the ball is.
* a **hash of that box**, one per sample, so a still ball and a moving one can be told apart.
* a **PNG of that box**, so the face can be looked at directly instead of inferred.

Usage: ``python dsh_orb/watch_ball_frames.py <seconds> [label] [--png <path>]``
"""

import ctypes
import ctypes.wintypes as w
import hashlib
import os
import sys
import time

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
CAPTUREBLT = 0x40000000

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
label = sys.argv[2] if len(sys.argv) > 2 else 'watch'
png_path = None
if '--png' in sys.argv:
    png_path = sys.argv[sys.argv.index('--png') + 1]


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
    """The executable a process is running, or ``''`` when it cannot be read."""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
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
    """Every window of an ``electron.exe`` process — the helper, and nothing from the system.

    Filtering by image name rather than by size is what keeps this off the system's own overlays: the text
    input application owns a full-screen window and would win by area every time.
    """
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
        if width > 20 and height > 20:
            length = user32.GetWindowTextLengthW(handle)
            title = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(handle, title, length + 1)
            found.append({'handle': handle, 'pid': pid.value, 'title': title.value,
                          'left': box.left, 'top': box.top, 'width': width, 'height': height,
                          'image': image_name(pid.value)})
        return True

    user32.EnumWindows(callback, 0)
    electron = [item for item in found if item['image'].lower().endswith('electron.exe')]
    return electron


def grab(handle, width, height):
    """The window's pixels, top-down, as a bytes object of BGRA."""
    window_dc = user32.GetWindowDC(handle)
    if not window_dc:
        return None
    memory_dc = gdi32.CreateCompatibleDC(window_dc)
    bitmap = gdi32.CreateCompatibleBitmap(window_dc, width, height)
    gdi32.SelectObject(memory_dc, bitmap)
    # `PW_RENDERFULLCONTENT` (2) is what makes a DirectComposition-rendered Electron window readable.
    if not user32.PrintWindow(handle, memory_dc, 2):
        user32.PrintWindow(handle, memory_dc, 0)
    info = BITMAPINFO()
    info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    info.bmiHeader.biWidth = width
    info.bmiHeader.biHeight = -height
    info.bmiHeader.biPlanes = 1
    info.bmiHeader.biBitCount = 32
    info.bmiHeader.biCompression = 0
    buffer = ctypes.create_string_buffer(width * height * 4)
    gdi32.GetDIBits(memory_dc, bitmap, 0, height, buffer, ctypes.byref(info), DIB_RGB_COLORS)
    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(memory_dc)
    user32.ReleaseDC(handle, window_dc)
    return buffer.raw


def content_box(raw, width, height):
    """The smallest rectangle that is not fully transparent, as `(left, top, right, bottom)`."""
    import numpy

    alpha = numpy.frombuffer(raw, dtype=numpy.uint8).reshape(height, width, 4)[:, :, 3]
    rows = numpy.flatnonzero(alpha.any(axis=1))
    columns = numpy.flatnonzero(alpha.any(axis=0))
    if rows.size == 0 or columns.size == 0:
        return None
    return (int(columns[0]), int(rows[0]), int(columns[-1]), int(rows[-1]))


def crop_hash(raw, width, height, box):
    """A hash of the box's pixels, with the box's own geometry in it so a move is a change too."""
    import numpy

    left, top, right, bottom = box
    pixels = numpy.frombuffer(raw, dtype=numpy.uint8).reshape(height, width, 4)[top:bottom + 1, left:right + 1]
    digest = hashlib.sha1(f'{left},{top},{right},{bottom};'.encode())
    digest.update(pixels.tobytes())
    return digest.hexdigest()[:12]


def write_png(path, raw, width, height, box):
    """Save the box as a PNG, so the face can be looked at rather than guessed at."""
    import numpy
    from PIL import Image

    left, top, right, bottom = box
    pixels = numpy.frombuffer(raw, dtype=numpy.uint8).reshape(height, width, 4)[top:bottom + 1, left:right + 1]
    # BGRA from `GetDIBits`, RGBA for Pillow.
    image = Image.fromarray(pixels[:, :, [2, 1, 0, 3]], 'RGBA')
    image.save(path)
    return path


candidates = ball_window()
if not candidates:
    print('no ball window found')
    raise SystemExit(1)
# The widest one with a real size: the helper also owns thin strips for the docked ball.
target = max(candidates, key=lambda item: item['width'] * item['height'])
print(f"window: pid={target['pid']} {target['width']}x{target['height']} at ({target['left']},{target['top']}) title={target['title']!r}")

started = time.time()
first = grab(target['handle'], target['width'], target['height'])
if first is None:
    print('the window could not be read')
    raise SystemExit(1)
box = content_box(first, target['width'], target['height'])
if box is None:
    print('the window is entirely transparent, so there is nothing to watch')
    raise SystemExit(1)
print(f'content box: {box[0]},{box[1]} -> {box[2]},{box[3]}  ({box[2] - box[0] + 1}x{box[3] - box[1] + 1})')
if png_path:
    write_png(png_path, first, target['width'], target['height'], box)
    print(f'saved {png_path}')

last = None
changes = 0
samples = 0
while time.time() - started < seconds:
    raw = grab(target['handle'], target['width'], target['height'])
    samples += 1
    if raw is not None:
        digest = crop_hash(raw, target['width'], target['height'], box)
        if digest != last:
            changes += 1
            print(f'  t={time.time() - started:6.2f}s  frame {changes}  {digest}')
            last = digest
    time.sleep(0.12)
print(f'\n{label}: {changes} distinct frames in {samples} samples over {seconds:g}s')
