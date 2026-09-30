"""Contact sheet: a grid of rendered stills with the absolute frame number under each (Task 18, gate B).

    .venv/Scripts/python scripts/sheet.py --out out/stills/gate-b.png --cols 3 [--tile 960] still.png=127 ...

Each argument is <png>=<frame>. Tiles are scaled to --tile px wide (keeping 16:9) and laid out row by row; the label
under each tile reads « <frame> · <mm:ss.ff> ». Composed with matplotlib (the venv's plotting library) at 1 px per
figure pixel, so the sheet has exactly the size of the grid.
"""
from __future__ import annotations
import argparse, math
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.image import imread

FPS = 30
LABEL_H = 44
GAP = 8
BG = "#101014"
INK = "#f2f2ee"


def timecode(frame: int) -> str:
    s, f = divmod(frame, FPS)
    return f"{s // 60}:{s % 60:02d}.{f:02d}"


def compose(items: list[tuple[Path, int]], out: Path, cols: int, tile_w: int) -> Path:
    first = imread(items[0][0])
    tile_h = round(tile_w * first.shape[0] / first.shape[1])
    rows = math.ceil(len(items) / cols)
    width = cols * tile_w + (cols + 1) * GAP
    height = rows * (tile_h + LABEL_H) + (rows + 1) * GAP
    dpi = 100
    fig = plt.figure(figsize=(width / dpi, height / dpi), dpi=dpi, facecolor=BG)
    for i, (path, frame) in enumerate(items):
        r, c = divmod(i, cols)
        x0 = GAP + c * (tile_w + GAP)
        y0 = GAP + r * (tile_h + LABEL_H + GAP)  # from the top
        ax = fig.add_axes((x0 / width, 1 - (y0 + tile_h) / height, tile_w / width, tile_h / height))
        ax.imshow(imread(path), interpolation="antialiased")
        ax.set_axis_off()
        fig.text((x0 + tile_w / 2) / width, 1 - (y0 + tile_h + LABEL_H / 2) / height, f"{frame}  ·  {timecode(frame)}",
                 ha="center", va="center", color=INK, fontsize=LABEL_H * 0.42, family="DejaVu Sans Mono")
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=dpi, facecolor=BG)
    plt.close(fig)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--tile", type=int, default=960, help="tile width in px")
    ap.add_argument("stills", nargs="+", help="<png>=<frame>")
    a = ap.parse_args()
    items = []
    for s in a.stills:
        p, _, f = s.rpartition("=")
        items.append((Path(p), int(f)))
    print(f"sheet: {compose(items, a.out, a.cols, a.tile)} ({len(items)} stills, {a.cols} columns)")


if __name__ == "__main__":
    main()
