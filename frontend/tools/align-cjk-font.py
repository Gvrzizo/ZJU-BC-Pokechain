#!/usr/bin/env python3
"""把 Fusion Pixel 的中日韩字形整体上移 2 格（200/1200 em），与 Press Start 2P 的基线带对齐。

Press Start 2P 的字形画在 em 的上部（下缘离基线 1 格 = 0.125em），而常规中日韩字体的
字面框跨基线分布（-0.083em ~ +0.833em），两套字体同号混排时汉字会整体低于拉丁字母
约 0.17em —— CSS 的 size-adjust / ascent-override 只能改字号和行盒，改不了字形与基线的
相对位置，所以这里在字体层面把汉字（含标点）上移 0.167em（12px 点阵正好 2 格，
12/24px 等整数倍字号下仍是整数像素，不会破坏点阵清晰度）。

用法：
    python3 tools/align-cjk-font.py 上游.otf 输出.woff2
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.misc.transform import Transform
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont


def main(src: Path, dst: Path) -> None:
    # recalcTimestamp=False：保持 head.modified 不变，同一上游文件每次产出字节一致
    font = TTFont(src, recalcTimestamp=False)
    upem = font["head"].unitsPerEm
    if upem % 12 != 0:
        raise SystemExit(f"只适用于 12px 点阵字体（upem 应为 12 的整数倍），当前 upem={upem}")
    shift_y = upem // 6  # 2 格
    cff = font["CFF "].cff
    top_dict = cff[cff.fontNames[0]]
    char_strings = top_dict.CharStrings
    glyph_set = font.getGlyphSet()

    shift = Transform(1, 0, 0, 1, 0, shift_y)
    for name in font.getGlyphOrder():
        recorder = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recorder)
        pen = T2CharStringPen(char_strings[name].width, glyph_set)
        recorder.replay(TransformPen(pen, shift))
        char_strings[name] = pen.getCharString(
            private=top_dict.Private, globalSubrs=cff.GlobalSubrs
        )

    # 字面框 / 度量随之上移，保持文件自身的元数据自洽
    head = font["head"]
    os2 = font["OS/2"]
    head.yMin += shift_y
    head.yMax += shift_y
    for attr in ("sTypoAscender", "sTypoDescender", "usWinAscent", "usWinDescent"):
        setattr(os2, attr, getattr(os2, attr) + shift_y)
    font["hhea"].ascender += shift_y
    font["hhea"].descender += shift_y

    dst.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        otf = Path(tmp) / "aligned.otf"
        font.save(otf)
        subprocess.run(["woff2_compress", str(otf)], check=True, cwd=tmp)
        dst.write_bytes((Path(tmp) / "aligned.woff2").read_bytes())
    print(f"{src.name} -> {dst} ({dst.stat().st_size} bytes, shift +{shift_y}/{upem} em)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
