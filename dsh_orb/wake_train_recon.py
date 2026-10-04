"""Reconnaissance for a local openWakeWord training run.

Answers the questions that decide whether the training pipeline can run on this
machine at all, before anything large is downloaded: how much disk is free, which
package index is reachable, and whether the training data hosts respond.

Nothing here installs or downloads anything; it is all reachability and capacity.
"""

from __future__ import annotations

import json
import shutil
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

PY311 = r"D:\tools\indextts\py311"


def disk() -> None:
    print("== disk ==")
    for name, path in (("C:", "C:\\"), ("D:", "D:\\")):
        try:
            total, used, free = shutil.disk_usage(path)
            print(f"  {name}  total {total/2**30:7.1f} GiB   used {used/2**30:7.1f} GiB"
                  f"   free {free/2**30:6.1f} GiB")
        except OSError as error:
            print(f"  {name}  unavailable: {error}")


def tcp(host: str, port: int = 443, timeout: float = 8.0) -> str:
    start = time.perf_counter()
    try:
        address = socket.gethostbyname(host)
    except OSError as error:
        return f"{host:34} DNS FAIL {type(error).__name__}"
    try:
        with socket.create_connection((address, port), timeout=timeout):
            pass
    except OSError as error:
        return f"{host:34} {address:16} tcp FAIL after {time.perf_counter()-start:.1f}s {type(error).__name__}"
    return f"{host:34} {address:16} tcp OK   {time.perf_counter()-start:.2f}s"


def https_head(url: str, timeout: float = 15.0) -> str:
    """Report status and size without pulling the body, following redirects."""
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            length = response.headers.get("content-length")
            size = f"{int(length)/2**20:8.1f} MiB" if length and length.isdigit() else "     ? MiB"
            return f"HTTP {response.status}  {size}  {response.url[:80]}"
    except urllib.error.HTTPError as error:
        return f"HTTP {error.code} {error.reason}"
    except Exception as error:  # noqa: BLE001
        return f"{type(error).__name__}: {str(error)[:70]}"


def main() -> int:
    print(f"python {sys.version.split()[0]}  ({sys.executable})")
    print()
    disk()
    print()

    print("== hosts the pipeline needs ==")
    for host in (
        "pypi.org",
        "pypi.tuna.tsinghua.edu.cn",
        "files.pythonhosted.org",
        "huggingface.co",
        "hf-mirror.com",
        "github.com",
        "codeload.github.com",
        "objects.githubusercontent.com",
        "zenodo.org",
        "openslr.org",
        "www.openslr.org",
    ):
        print(" ", tcp(host))
    print()

    print("== specific training artefacts ==")
    urls = (
        # openWakeWord's hosted feature/negative data (used by the official notebook)
        "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
        "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy",
        "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/false_positive_validation_data_features.npy",
        # the source tree itself, which the training module lives in
        "https://codeload.github.com/dscripka/openWakeWord/tar.gz/refs/heads/main",
        # a Chinese Piper voice, in case the sample generator route is used
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx",
        # the 2026 community notebook that claims 36-language support
        "https://codeload.github.com/alfiedennen/openwakeword-colab-2026/tar.gz/refs/heads/main",
    )
    for url in urls:
        tail = url.split("/")[-1][:44]
        print(f"  {tail:46} {https_head(url)}")
    print()

    print("== package availability (no install) ==")
    index = "https://pypi.tuna.tsinghua.edu.cn/simple"
    for package in ("openwakeword", "onnxruntime", "audiomentations", "torch-audiomentations",
                    "acoustics", "speechbrain", "torchmetrics", "mutagen", "webrtcvad"):
        data = https_head(f"{index}/{package}/")
        print(f"  {package:22} {data}")
    print()

    print("== existing torch environment ==")
    code = (
        "import torch, torchaudio, librosa, soundfile, scipy, numpy;"
        "print('  torch', torch.__version__, 'cuda', torch.cuda.is_available(),"
        "torch.cuda.get_device_name(0) if torch.cuda.is_available() else '');"
        "print('  torchaudio', torchaudio.__version__, 'librosa', librosa.__version__,"
        "'soundfile', soundfile.__version__, 'scipy', scipy.__version__, 'numpy', numpy.__version__)"
    )
    import subprocess
    result = subprocess.run([f"{PY311}\\python.exe", "-c", code],
                            capture_output=True, timeout=180)
    print(result.stdout.decode("utf8", "replace").rstrip("\n") or "(no output)")
    if result.returncode != 0:
        print("  stderr:", result.stderr.decode("utf8", "replace")[-300:])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
