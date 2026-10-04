"""Train the 大肥鱼 classifier and export it as the ONNX file the orb loads.

The architecture is copied from openWakeWord's `train.py` — `Flatten -> Linear(1536,128) -> LayerNorm
-> ReLU -> [FCNBlock] -> Linear(128,1) -> Sigmoid` — rather than imported from it, because importing
`openwakeword.train` drags in `openwakeword.data`, which wants pronouncing, speechbrain,
audiomentations and a tflite runtime. None of that is needed to fit a few thousand weights, and all of
it is a chance for the environment to differ from the one the model ships into. What matters is that
the shipped classifier's *interface* is reproduced exactly: `[1,16,96] -> [1,1]`, which is what
`hey_jarvis_v0.1.onnx` declares and what `assets/wake.js` feeds.

Two decisions that carry the result:

  * **The split is by clip, not by window.** Neighbouring windows of one clip are nearly the same
    audio; splitting them at random puts almost-identical rows on both sides of the fence and reports
    a validation score that is really a memorisation score. `*-clips.npy` exists so that cannot
    happen quietly.
  * **Hard negatives are weighted up.** 大肥猪, 大飞鱼, 大白鱼 and friends are the only negatives that
    a model gets wrong in practice; ordinary Chinese sentences are easy and there are 3150 of them.
    Left unweighted, "does not fire on talking" drowns out "does not fire on a near-miss".

Features arrive from `wake_dataset.py features`, already in the renderer's own format — see
`wake_features.OrbFeatures` and `wake_scale_compare.py` for why that specific path was chosen.

Usage:
    wake_train.py                 # train, evaluate, export to data/features/dafeiyu.onnx
    wake_train.py --epochs 60     # longer, if the first run looks underfit
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys

import numpy as np
import torch
from sklearn.metrics import roc_auc_score
from torch import nn, optim

sys.path.insert(0, str(pathlib.Path(__file__).parent))

DATA = pathlib.Path(r"C:\Users\digua\wakeword\data")
FEATURE_DIR = DATA / "features"

# Where the trained classifier has to end up to be loadable. `wake.ts` resolves any non-default
# keyword as `<keyword>.onnx`, so pointing orb-wake.json at `dafeiyu` finds exactly this name.
OUTPUT = FEATURE_DIR / "dafeiyu.onnx"

INPUT_SHAPE = (16, 96)
LAYER_DIM = 128
N_BLOCKS = 1
OPSET = 13                     # what openWakeWord itself exports with; onnxruntime-web here is 1.30

BATCH = 256
LR = 1e-4

# A near-miss is worth this many ordinary sentences. Not tuned in the abstract: the adversarial set is
# 15 phrases x 2 rates x 14 voices = 420 clips against 3150 filler, so without a weight the loss is
# dominated by "do not fire on arbitrary Mandarin", which is the easy half of the problem.
HARD_NEGATIVE_WEIGHT = 3.0

# openWakeWord's own hard-example filter. Negatives already scoring near zero are suppressed and cost
# nothing to keep punishing; positives already near one are learned. Dropping them concentrates every
# step on the samples that are still wrong.
NEGATIVE_KEEP_BELOW = 0.001
POSITIVE_KEEP_ABOVE = 0.999


class FCNBlock(nn.Module):
    """Mirrors openWakeWord's `FCNBlock`: Linear -> LayerNorm -> ReLU."""

    def __init__(self, layer_dim: int) -> None:
        super().__init__()
        self.fcn_layer = nn.Linear(layer_dim, layer_dim)
        self.relu = nn.ReLU()
        self.layer_norm = nn.LayerNorm(layer_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.relu(self.layer_norm(self.fcn_layer(x)))


class Net(nn.Module):
    """openWakeWord's `model_type="dnn"` network, verbatim in structure."""

    def __init__(self, input_shape: tuple[int, int] = INPUT_SHAPE, layer_dim: int = LAYER_DIM,
                 n_blocks: int = N_BLOCKS, n_classes: int = 1) -> None:
        super().__init__()
        self.flatten = nn.Flatten()
        self.layer1 = nn.Linear(input_shape[0] * input_shape[1], layer_dim)
        self.relu1 = nn.ReLU()
        self.layernorm1 = nn.LayerNorm(layer_dim)
        self.blocks = nn.ModuleList([FCNBlock(layer_dim) for _ in range(n_blocks)])
        self.last_layer = nn.Linear(layer_dim, 1)
        self.last_act = nn.Sigmoid() if n_classes == 1 else nn.ReLU()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.relu1(self.layernorm1(self.layer1(self.flatten(x))))
        for block in self.blocks:
            x = block(x)
        return self.last_act(self.last_layer(x))


class Split:
    """One side of the data, with the two index spaces kept explicitly apart.

    Clip-scoped facts (the name, whether it is adversarial) and window-scoped facts (features, the
    fold it belongs to) are indexed differently, and mixing them up produces plausible-looking wrong
    numbers rather than an exception — so both spaces are materialised here, once, with an assertion
    that they agree.
    """

    def __init__(self, side: str) -> None:
        self.side = side
        self.x = np.load(FEATURE_DIR / f"{side}.npy").astype(np.float32)
        self.clip_ids = np.load(FEATURE_DIR / f"{side}-clips.npy").astype(np.int64)
        self.names = json.loads((FEATURE_DIR / f"{side}-names.json").read_text(encoding="utf-8"))
        if self.x.shape[0] != self.clip_ids.shape[0]:
            raise SystemExit(f"{side}: {self.x.shape[0]} windows but {self.clip_ids.shape[0]} ids")
        if self.clip_ids.size and int(self.clip_ids.max()) >= len(self.names):
            raise SystemExit(f"{side}: clip id {self.clip_ids.max()} beyond "
                             f"{len(self.names)} names")
        self.n_clips = len(self.names)

        self.label = 1.0 if side == "positive" else 0.0
        # Adversarial clips are recognised by the filename wake_dataset.py gave them. This is the only
        # place the two kinds of negative are told apart again, and it decides their training weight.
        self.hard_clip = np.array([name.startswith("adversarial-") for name in self.names], dtype=bool)
        self.hard_window = self.hard_clip[self.clip_ids]
        assert self.hard_window.shape == self.clip_ids.shape
        self.folds: np.ndarray | None = None

    def assign_folds(self, fold_count: int, rng: np.random.Generator) -> None:
        """Deal clips into folds.

        Round-robin off a shuffle rather than contiguous blocks, so the folds stay even when the clip
        count is not divisible by their number — 1455 positive clips over 5 folds leaves a block
        split with a fold one clip short of the others.
        """
        self.folds = rng.permutation(self.n_clips) % fold_count

    def windows(self, fold: int, held_out: bool) -> np.ndarray:
        """Window mask for the clips assigned to `fold`, or to every other fold."""
        if self.folds is None:
            raise RuntimeError("assign_folds() has not been called")
        assigned = self.folds[self.clip_ids]
        return (assigned == fold) if held_out else (assigned != fold)

    def hard_weight(self) -> np.ndarray:
        return np.where(self.hard_window, HARD_NEGATIVE_WEIGHT, 1.0).astype(np.float32)


def clip_scores(scores: np.ndarray, clips: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Collapse windows to one score per clip, by the maximum.

    The engine fires on a single window above threshold, so the maximum is the honest summary: a clip
    whose best window is 0.9 wakes the orb even when its other windows sit near zero.

    Returns `(values, order, labels_are_irrelevant_here)` — the caller owns labels, because a clip's
    label is only known by looking it up, and doing it here would hide a mismatch.
    """
    best: dict[int, float] = {}
    for score, clip in zip(scores, clips):
        clip = int(clip)
        best[clip] = max(best.get(clip, 0.0), float(score))
    order = np.array(sorted(best), dtype=np.int64)
    return np.array([best[int(clip)] for clip in order], dtype=np.float32), order, best


def predict(model: nn.Module, x: np.ndarray) -> np.ndarray:
    """Score a batch of windows in evaluation mode, on whatever device the model is on."""
    model.eval()
    # The model may be on the GPU while the features live in host memory, so the chunk is moved and
    # the result brought back rather than assuming either side.
    device = next(model.parameters()).device
    with torch.no_grad():
        rows = []
        for start in range(0, x.shape[0], 4096):
            chunk = torch.from_numpy(x[start:start + 4096]).to(device)
            rows.append(model(chunk).cpu().numpy().ravel())
    return np.concatenate(rows) if rows else np.zeros(0, dtype=np.float32)


def evaluate(model: nn.Module, positive: Split, negative: Split, fold: int) -> dict:
    """Score the held-out fold and summarise it the way the engine will experience it."""
    positive_mask = positive.windows(fold, held_out=True)
    negative_mask = negative.windows(fold, held_out=True)

    positive_values, _, _ = clip_scores(
        predict(model, positive.x[positive_mask]), positive.clip_ids[positive_mask])
    negative_values, negative_order, _ = clip_scores(
        predict(model, negative.x[negative_mask]), negative.clip_ids[negative_mask])

    return {"positive": positive_values, "negative": negative_values,
            "negative_hard": negative.hard_clip[negative_order]}


def threshold_table(result: dict) -> list[dict]:
    """Recall and false-alarm rate at each threshold, so the operating point is chosen, not assumed."""
    rows = []
    hard = result["negative_hard"]
    for threshold in (0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90):
        rows.append({
            "threshold": threshold,
            "recall": float((result["positive"] >= threshold).mean()),
            "hard_fp": float((result["negative"][hard] >= threshold).mean()) if hard.sum() else 0.0,
            "filler_fp": float((result["negative"][~hard] >= threshold).mean())
            if (~hard).sum() else 0.0,
        })
    return rows


def export(model: nn.Module, path: pathlib.Path) -> dict:
    """Export to ONNX and prove the exported graph agrees with PyTorch before it is trusted."""
    import onnxruntime as ort

    path.parent.mkdir(parents=True, exist_ok=True)
    # Batch stays fixed at 1: wake.js feeds one window at a time, so a dynamic leading dimension would
    # buy nothing and cost inference speed in the browser.
    model_cpu = model.to("cpu").eval()
    torch.onnx.export(model_cpu, torch.rand(1, *INPUT_SHAPE), str(path), opset_version=OPSET,
                      input_names=["input"], output_names=["output"])

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0]
    out = session.get_outputs()[0]

    probe = np.random.default_rng(0).random((64, *INPUT_SHAPE)).astype(np.float32)
    with torch.no_grad():
        reference = model_cpu(torch.from_numpy(probe)).numpy().ravel()
    actual = np.array([session.run(None, {feed.name: row[None, :, :]})[0].ravel()[0]
                       for row in probe], dtype=np.float32)
    return {"path": str(path), "input_shape": list(feed.shape), "input_name": feed.name,
            "output_shape": list(out.shape), "output_name": out.name,
            "max_abs_diff": float(np.abs(reference - actual).max()),
            "size_bytes": path.stat().st_size}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", type=pathlib.Path, default=OUTPUT)
    parser.add_argument("--load", type=pathlib.Path, default=None,
                        help="skip training and export this checkpoint instead")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    rng = np.random.default_rng(args.seed)

    if not (FEATURE_DIR / "positive.npy").exists() or not (FEATURE_DIR / "negative.npy").exists():
        raise SystemExit(f"no features under {FEATURE_DIR}; run `wake_dataset.py features` first")

    positive = Split("positive")
    negative = Split("negative")
    print(f"  positives: {positive.x.shape[0]} windows / {positive.n_clips} clips")
    print(f"  negatives: {negative.x.shape[0]} windows / {negative.n_clips} clips "
          f"({int(negative.hard_clip.sum())} adversarial)")

    # One fold is held out for the whole run. Cross-validating all five would give a tighter estimate
    # and cost five times as much; the decision this number feeds is "is this shippable", not a
    # publishable error bar.
    fold = args.folds - 1
    positive.assign_folds(args.folds, rng)
    negative.assign_folds(args.folds, rng)
    # Written out because the split is the one thing a later evaluation cannot reconstruct safely:
    # re-deriving it means re-running this RNG in this exact order, and any change to the number of
    # folds or the order of these two calls would silently move clips across the fence, turning a
    # held-out score into a memorisation score with nothing to show for it.
    np.save(FEATURE_DIR / "folds-positive.npy", positive.folds)
    np.save(FEATURE_DIR / "folds-negative.npy", negative.folds)

    train_positive = positive.windows(fold, held_out=False)
    train_negative = negative.windows(fold, held_out=False)
    x = np.vstack([positive.x[train_positive], negative.x[train_negative]])
    y = np.concatenate([np.full(int(train_positive.sum()), 1.0, dtype=np.float32),
                        np.zeros(int(train_negative.sum()), dtype=np.float32)])
    weight = np.concatenate([np.ones(int(train_positive.sum()), dtype=np.float32),
                             negative.hard_weight()[train_negative]])
    print(f"  training on {x.shape[0]} windows, holding out fold {fold}")

    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    model = Net().to(device)

    if args.load is not None:
        # Re-export path. The first export attempt died on a missing `onnx` package, after the
        # training had already succeeded; keeping the weights means a packaging problem never costs
        # the run that produced them.
        model.load_state_dict(torch.load(args.load, map_location=device)["state"])
        print(f"  loaded {args.load}; skipping training")
        info = export(model, args.out)
        print(json.dumps(info, indent=2))
        return 0 if info["input_shape"] == [1, 16, 96] else 1

    print(f"  device: {device}")

    optimizer = optim.Adam(model.parameters(), lr=LR)
    loss_fn = nn.BCELoss(reduction="none")

    x_tensor = torch.from_numpy(x)
    y_tensor = torch.from_numpy(y)
    weight_tensor = torch.from_numpy(weight)
    count = x.shape[0]

    best_auc = -1.0
    best_state = None
    for epoch in range(1, args.epochs + 1):
        model.train()
        order = rng.permutation(count)
        total_loss = 0.0
        kept = 0
        for start in range(0, count, BATCH):
            index = torch.from_numpy(order[start:start + BATCH])
            bx = x_tensor[index].to(device)
            by = y_tensor[index].to(device)
            bw = weight_tensor[index].to(device)

            optimizer.zero_grad()
            prediction = model(bx).ravel()

            keep = torch.where(by > 0.5, prediction < POSITIVE_KEEP_ABOVE,
                               prediction >= NEGATIVE_KEEP_BELOW)
            if int(keep.sum()) == 0:
                continue
            loss = (loss_fn(prediction[keep], by[keep]) * bw[keep]).mean()
            loss.backward()
            optimizer.step()
            total_loss += float(loss.detach()) * int(keep.sum())
            kept += int(keep.sum())

        if epoch % 5 == 0 or epoch == 1 or epoch == args.epochs:
            result = evaluate(model, positive, negative, fold)
            pooled_labels = np.concatenate([np.ones(result["positive"].size),
                                            np.zeros(result["negative"].size)])
            # Selected on clip AUC rather than on loss: the loss is computed over a filtered batch, so
            # its value moves for reasons that have nothing to do with quality.
            auc = roc_auc_score(pooled_labels, np.concatenate([result["positive"],
                                                               result["negative"]]))
            improved = auc > best_auc
            if improved:
                best_auc = auc
                best_state = {key: value.detach().clone()
                              for key, value in model.state_dict().items()}
            print(f"  epoch {epoch:3d}  loss {total_loss/max(1, kept):.5f}  "
                  f"kept {kept/count:6.1%}  clip AUC {auc:.4f}"
                  + ("  <- best" if improved else ""))

    if best_state is not None:
        model.load_state_dict(best_state)
    print(f"  best clip AUC: {best_auc:.4f}")

    checkpoint = FEATURE_DIR / "dafeiyu.pt"
    torch.save({"state": model.state_dict(), "input_shape": list(INPUT_SHAPE), "fold": fold,
                "folds": args.folds, "seed": args.seed, "epochs": args.epochs,
                "clip_auc": best_auc}, checkpoint)
    print(f"  checkpoint: {checkpoint}")

    result = evaluate(model, positive, negative, fold)
    print()
    print(f"  {'threshold':>10} {'recall':>8} {'near-miss FP':>13} {'filler FP':>10}")
    print("  " + "-" * 46)
    for row in threshold_table(result):
        print(f"  {row['threshold']:10.2f} {row['recall']:8.1%} {row['hard_fp']:13.1%} "
              f"{row['filler_fp']:10.1%}")

    info = export(model, args.out)
    print()
    print(f"  exported {info['path']}")
    print(f"    input  {info['input_name']} {info['input_shape']}")
    print(f"    output {info['output_name']} {info['output_shape']}")
    print(f"    size   {info['size_bytes']/1024:.0f} KiB")
    print(f"    PyTorch vs onnxruntime max difference: {info['max_abs_diff']:.2e}")
    if info["input_shape"] != [1, 16, 96] or info["output_shape"] != [1, 1]:
        print("    SHAPE MISMATCH — wake.js builds exactly [1,16,96] and reads data[0].")
        return 1
    if info["max_abs_diff"] > 1e-4:
        print("    EXPORT MISMATCH — the graph does not reproduce the trained model.")
        return 1
    print("    shapes and numerics match what wake.js expects.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
