"""Write a small two-column "paper" PDF for end-to-end tests.

Every body line starts with a tag like [2R05] (page 2, right column, line 5)
so tests can check that the cursor walks the text in reading order.
Only the standard Helvetica fonts are used, so no font files are needed.
"""
import sys

WIDTH, HEIGHT = 612, 792
LEFT_X, RIGHT_X = 54, 322
TOP_Y = 700
LEADING = 12
LINES_PER_COLUMN = 40
WORDS = ("the quick brown fox jumps over a lazy dog while reading papers "
         "line by line with vim keys and bookmarks").split()


def escape(text):
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def body_line(page, column, n):
    offset = page * 7 + n * 3 + (5 if column == "R" else 0)
    words = [WORDS[(offset + i) % len(WORDS)] for i in range(6)]
    return f"[{page}{column}{n:02d}] " + " ".join(words)


def page_stream(page, pages):
    ops = []

    def text(x, y, s, font="F1", size=10):
        ops.append(f"BT /{font} {size} Tf {x} {y} Td ({escape(s)}) Tj ET")

    text(54, 760, "Inchworm Test Paper - running head", size=8)
    y_start = TOP_Y
    if page == 1:
        text(150, 735, "Reading Line by Line: An Inchworm Study", font="F2", size=16)
        y_start = 705
    for column, x in (("L", LEFT_X), ("R", RIGHT_X)):
        y = y_start
        for n in range(1, LINES_PER_COLUMN + 1):
            # Paragraphs of 8 lines with a blank line between them
            if n > 1 and (n - 1) % 8 == 0:
                y -= LEADING
            indent = 10 if (n - 1) % 8 == 0 else 0
            text(x + indent, y, body_line(page, column, n))
            y -= LEADING
    text(300, 40, str(page), size=9)
    return "\n".join(ops).encode("latin-1")


def build(pages=3):
    objects = []

    def add(body):
        objects.append(body)
        return len(objects)

    catalog = add(None)
    pages_id = add(None)
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    bold = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    kids = []
    for page in range(1, pages + 1):
        stream = page_stream(page, pages)
        content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        kids.append(add(
            (f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {WIDTH} {HEIGHT}] "
             f"/Resources << /Font << /F1 {font} 0 R /F2 {bold} 0 R >> >> /Contents {content} 0 R >>").encode()))
    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode()
    objects[pages_id - 1] = (f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] "
                             f"/Count {len(kids)} >>").encode()
    info = add(b"<< /Title (Reading Line by Line: An Inchworm Study) /Author (Inchworm Tests) >>")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R /Info {info} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n").encode()
    return bytes(out)


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "inchworm-test.pdf"
    with open(path, "wb") as f:
        f.write(build())
    print(path)
