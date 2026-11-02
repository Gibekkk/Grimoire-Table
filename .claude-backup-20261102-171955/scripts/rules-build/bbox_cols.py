# Column-aware text from a scanned PDF: words come from `pdftotext -bbox`, the
# column gutter is found per page as the widest empty vertical band near the
# middle, and each column is rebuilt line by line (top to bottom).
import subprocess, re, html, sys, concurrent.futures as cf
WORD = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>')
def page_text(pdf, p):
    out = subprocess.run(['pdftotext', '-f', str(p), '-l', str(p), '-bbox', pdf, '-'], capture_output=True, text=True).stdout
    m = re.search(r'<page width="([\d.]+)" height="([\d.]+)"', out)
    if not m: return ""
    W = float(m.group(1))
    words = [(float(a), float(b), float(c), float(d), html.unescape(t)) for a, b, c, d, t in WORD.findall(out)]
    if not words: return ""
    # coverage histogram over x (1pt buckets) in the middle third
    cover = [0] * (int(W) + 2)
    for x0, y0, x1, y1, t in words:
        for x in range(int(x0), min(int(x1) + 1, len(cover))): cover[x] += 1
    lo, hi = int(W * 0.35), int(W * 0.65)
    best, run, start, bstart = 0, 0, lo, lo
    for x in range(lo, hi):
        if cover[x] <= 1:
            if run == 0: start = x
            run += 1
            if run > best: best, bstart = run, start
        else: run = 0
    split = bstart + best / 2 if best >= 6 else W / 2
    cols = [[w for w in words if (w[0] + w[2]) / 2 < split], [w for w in words if (w[0] + w[2]) / 2 >= split]]
    texts = []
    for col in cols:
        col.sort(key=lambda w: (w[1], w[0]))
        lines, cur, cy = [], [], None
        for w in col:
            if cy is not None and abs(w[1] - cy) > 4:
                lines.append(cur); cur = []
            if not cur: cy = w[1]
            cur.append(w)
        if cur: lines.append(cur)
        out_lines, prev_y = [], None
        for ln in lines:
            ln.sort(key=lambda w: w[0])
            y = ln[0][1]
            if prev_y is not None and y - prev_y > 18: out_lines.append("")
            out_lines.append(" ".join(w[4] for w in ln))
            prev_y = y
        texts.append("\n".join(out_lines))
    return f"\n@@PAGE {p}\n" + texts[0] + "\n@@COL\n" + texts[1]
if __name__ == "__main__":
    pdf, first, last, dest = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    with cf.ThreadPoolExecutor(8) as ex:
        open(dest, "w").write("".join(ex.map(lambda p: page_text(pdf, p), range(first, last + 1))))
