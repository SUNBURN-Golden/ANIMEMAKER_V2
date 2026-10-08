"""사용 설명서 한글(HWP/HWPX) 파일 만들기.

사용법: python3 make-hwp.py <출력이름(확장자 없이)>
  → <이름>.hwpx 와 <이름>.hwp 두 개를 만든다. (python-hwpx 필요: pip install python-hwpx)
내용은 content.js 하나에서 가져온다 (Word·PDF 와 같은 내용).
"""
import json
import os
import re
import struct
import subprocess
import sys

from hwpx import HwpxDocument

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "img")
FONT = "맑은 고딕"
CONTENT_W_MM = 170  # A4 - 여백 20mm x 2

VIOLET = "#6D28D9"
INK = "#1F1B2E"
MUTED = "#6B6780"
BOX = {
    "tip": ("#E8F7EE", "#16A34A", "꿀팁"),
    "warn": ("#FFF4E0", "#D97706", "조심해요"),
    "adult": ("#FDECEC", "#DC2626", "어른과 함께"),
    "info": ("#EEF2FF", "#4F46E5", "알아 두기"),
}


def load_content():
    js = os.path.join(HERE, "content.js")
    out = subprocess.check_output(["node", "-e", f"process.stdout.write(JSON.stringify(require({json.dumps(js)})))"])
    return json.loads(out)


def segments(text):
    """'**굵게**' 표시를 (글자, 굵게?) 조각으로"""
    parts = [p for p in re.split(r"(\*\*[^*]+\*\*)", text) if p]
    return [(p[2:-2], True) if p.startswith("**") and p.endswith("**") else (p, False) for p in parts]


def plain(text):
    return re.sub(r"\*\*([^*]+)\*\*", r"\1", text)


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    return struct.unpack(">II", head[16:24])


class Builder:
    def __init__(self):
        self.doc = HwpxDocument.new()
        self.first = True

    def para(self, text="", *, size=11, bold=False, color=None, align=None, before=0, after=5, line=150,
             indent=0, page_break=False, keep_next=False):
        if self.first:
            # 새 문서에는 빈 첫 문단이 있다 → 그걸 쓴다
            p = self.doc.paragraphs[0]
            self.first = False
        else:
            p = self.doc.add_paragraph("", include_run=False, inherit_style=False)
        for seg, b in segments(text) if text else []:
            p.add_run(seg, bold=bold or b, size=size, color=color or (INK if b else None), font=FONT)
        if not text:
            p.add_run("", size=size, font=FONT)
        self.doc.styles.apply_paragraph_format(
            paragraphs=[p], alignment=align, spacing_before_pt=before, spacing_after_pt=after,
            line_spacing_percent=line, indent_left_mm=indent or None, page_break_before=page_break or None,
            keep_with_next=keep_next or None,
        )
        return p

    def image(self, file, width_cm, caption):
        path = os.path.join(IMG, file)
        w, h = png_size(path)
        width_mm = width_cm * 10
        height_mm = width_mm * h / w
        with open(path, "rb") as f:
            data = f.read()
        pic = self.doc.add_picture(data, "png", width_mm=width_mm, height_mm=height_mm, align="center")
        if caption:
            self.para(f"▲ {caption}", size=9, color=MUTED, align="CENTER", after=8)
        return pic

    def table(self, head, rows, widths_pct, *, head_fill=VIOLET):
        ncols = len(head)
        t = self.doc.add_table(len(rows) + 1, ncols, width=None)
        head_style = self.doc.styles.ensure_run(bold=True, color="#FFFFFF", size=10, font=FONT)
        body_style = self.doc.styles.ensure_run(size=10, font=FONT)
        for c, txt in enumerate(head):
            cell = t.cell(0, c)
            cell.text = plain(txt)
            for run in cell.paragraphs[0].runs:
                run.element.set("charPrIDRef", str(head_style))
            t.set_cell_shading(0, c, head_fill)
        for r, row in enumerate(rows, start=1):
            for c, txt in enumerate(row):
                cell = t.cell(r, c)
                cell.text = plain(txt)
                for p in cell.paragraphs:
                    for run in p.runs:
                        run.element.set("charPrIDRef", str(body_style))
                if r % 2 == 0:
                    t.set_cell_shading(r, c, "#FAF8FF")
        # 열 너비
        total = 42520  # 170mm in HWPUNIT (1mm = 283.465)
        for r in range(len(rows) + 1):
            for c in range(ncols):
                t.cell(r, c).set_size(width=int(total * widths_pct[c] / 100))
        self.para("", size=6, after=4)
        return t

    def box(self, kind, title, text=None, items=None):
        fill, bar, label = BOX.get(kind, BOX["info"])
        t = self.doc.add_table(1, 1)
        cell = t.cell(0, 0)
        cell.text = f"{label} | {title}"
        title_style = self.doc.styles.ensure_run(bold=True, color=bar, size=11, font=FONT)
        for run in cell.paragraphs[0].runs:
            run.element.set("charPrIDRef", str(title_style))
        lines = []
        if text:
            lines.append(text)
        for it in items or []:
            lines.append("• " + it)
        for line in lines:
            p = cell.add_paragraph("")
            for seg, b in segments(line):
                p.add_run(seg, bold=b, size=10.5, font=FONT, color=INK if b else None)
        t.set_cell_shading(0, 0, fill)
        cell.set_size(width=42520)
        self.para("", size=6, after=4)

    def build(self, content):
        for b in content:
            t = b["t"]
            if t == "title":
                self.para("", size=12, after=60)
                self.image(b["icon"], 4.5, None)
                self.para(b["title"], size=30, bold=True, color=VIOLET, align="CENTER", before=12, after=6)
                self.para(b["sub"], size=20, bold=True, align="CENTER", after=18)
                self.para(b["tag"], size=14, color=VIOLET, align="CENTER", after=80)
                self.para(b["note"], size=10, color=MUTED, align="CENTER")
            elif t == "toc":
                self.para(b["title"], size=22, bold=True, color=VIOLET, after=12, page_break=True)
                for it in b["items"]:
                    self.para(it, size=13, indent=6, after=5)
            elif t == "pagebreak":
                pass  # 차례·1장 앞에서 page_break 로 처리
            elif t == "h1":
                first_chapter = b["text"].startswith("1장")
                self.para(b["text"], size=17, bold=True, color=VIOLET, before=12, after=6,
                          keep_next=True, page_break=first_chapter)
            elif t == "h2":
                self.para("■ " + b["text"], size=13, bold=True, before=8, after=5, keep_next=True)
            elif t == "p":
                self.para(b["text"], size=11, after=6)
            elif t == "steps":
                for i, it in enumerate(b["items"], start=1):
                    self.para(f"**{i}.** {it}", size=11, indent=4, after=4)
                self.para("", size=6, after=2)
            elif t == "bullets":
                for it in b["items"]:
                    self.para(f"• {it}", size=11, indent=4, after=5)
            elif t == "box":
                self.box(b["kind"], b["title"], b.get("text"), b.get("items"))
            elif t == "img":
                self.image(b["file"], min(b.get("width", 15), 16), b.get("caption"))
            elif t == "table":
                self.table(b["head"], b["rows"], b["widths"])
            else:
                raise ValueError(f"모르는 블록: {t}")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "manual"
    builder = Builder()
    builder.build(load_content())
    builder.doc.save_to_path(out + ".hwpx")
    print("wrote", out + ".hwpx")
    builder.doc.save_to_path(out + ".hwp")
    print("wrote", out + ".hwp")


if __name__ == "__main__":
    main()
