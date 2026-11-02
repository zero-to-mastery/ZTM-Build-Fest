#!/usr/bin/env python3
"""Convert an epub into one Markdown file per unit under <workspace>/source/ and write SYLLABUS.md.

Usage: ingest_epub.py <book.epub> <workspace-dir>

Reads the OPF spine for order, takes each spine item's first heading as the unit title,
and keeps headings, paragraphs, lists, code blocks, emphasis and images. Images are copied
to source/images/. Spine items with fewer than 60 words, and front/back matter (cover, table of
contents, copyright, footnotes, index), are skipped as units; footnotes are kept as source/footnotes.md.
Units whose heading starts with a number ("3. Intro to ...") are numbered by that chapter number.
Stdlib only.
"""
import re
import sys
import zipfile
import posixpath
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET


class MarkdownConverter(HTMLParser):
    BLOCK = {"p", "div", "section", "article", "blockquote", "figure", "figcaption", "aside", "header", "footer"}

    def __init__(self, image_sink):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.stack = []
        self.list_stack = []
        self.in_pre = False
        self.image_sink = image_sink
        self.first_heading = None
        self.href = None

    def text(self, s):
        self.out.append(s)

    def newline(self, n=2):
        joined = "".join(self.out).rstrip(" ")
        trailing = len(joined) - len(joined.rstrip("\n"))
        if trailing < n:
            self.out = [joined + "\n" * (n - trailing)]

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.stack.append(tag)
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.newline()
            self.text("#" * int(tag[1]) + " ")
        elif tag == "pre":
            self.newline()
            self.text("```\n")
            self.in_pre = True
        elif tag == "code" and not self.in_pre:
            self.text("`")
        elif tag in ("em", "i"):
            self.text("_")
        elif tag in ("strong", "b"):
            self.text("**")
        elif tag in ("ul", "ol"):
            self.newline()
            self.list_stack.append([tag, 0])
        elif tag == "li":
            self.newline(1)
            depth = len(self.list_stack) - 1
            if self.list_stack and self.list_stack[-1][0] == "ol":
                self.list_stack[-1][1] += 1
                self.text("  " * depth + f"{self.list_stack[-1][1]}. ")
            else:
                self.text("  " * depth + "- ")
        elif tag == "br":
            self.text("\n")
        elif tag == "img":
            src = a.get("src", "")
            alt = a.get("alt", "")
            local = self.image_sink(src) if src else ""
            self.newline()
            self.text(f"![{alt}]({local})")
            self.newline()
        elif tag == "a":
            self.href = a.get("href")
            if self.href and not self.href.startswith("#"):
                self.text("[")
        elif tag == "blockquote":
            self.newline()
            self.text("> ")
        elif tag in self.BLOCK:
            self.newline()

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            if self.first_heading is None:
                line = "".join(self.out).rstrip().split("\n")[-1]
                self.first_heading = line.lstrip("# ").strip()
            self.newline()
        elif tag == "pre":
            self.in_pre = False
            self.newline(1)
            self.text("```")
            self.newline()
        elif tag == "code" and not self.in_pre:
            self.text("`")
        elif tag in ("em", "i"):
            self.text("_")
        elif tag in ("strong", "b"):
            self.text("**")
        elif tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
            self.newline()
        elif tag == "a":
            if self.href and not self.href.startswith("#"):
                self.text(f"]({self.href})")
            self.href = None
        elif tag in self.BLOCK:
            self.newline()

    def handle_data(self, data):
        if self.in_pre:
            self.text(data)
            return
        if "style" in self.stack or "script" in self.stack or "title" in self.stack:
            return
        data = re.sub(r"\s+", " ", data)
        if data.strip() or (self.out and not self.out[-1].endswith("\n")):
            self.text(data)

    def result(self):
        s = "".join(self.out)
        s = re.sub(r"[ \t]+\n", "\n", s)
        s = re.sub(r"\n{3,}", "\n\n", s)
        return s.strip() + "\n"


def slugify(s):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:60] or "unit"


def main(epub, workspace):
    ws = Path(workspace)
    src_dir = ws / "source"
    img_dir = src_dir / "images"
    src_dir.mkdir(parents=True, exist_ok=True)
    img_dir.mkdir(exist_ok=True)

    with zipfile.ZipFile(epub) as z:
        names = set(z.namelist())
        container = ET.fromstring(z.read("META-INF/container.xml"))
        ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
        opf_path = container.find(".//c:rootfile", ns).attrib["full-path"]
        opf_dir = posixpath.dirname(opf_path)
        opf = ET.fromstring(z.read(opf_path))
        ons = {"o": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
        title_el = opf.find(".//dc:title", ons)
        book_title = title_el.text.strip() if title_el is not None and title_el.text else Path(epub).stem
        manifest = {i.attrib["id"]: i.attrib["href"] for i in opf.findall(".//o:manifest/o:item", ons)}
        spine = [manifest[r.attrib["idref"]] for r in opf.findall(".//o:spine/o:itemref", ons) if r.attrib["idref"] in manifest]

        units = []
        n = 0
        for href in spine:
            path = posixpath.normpath(posixpath.join(opf_dir, href)) if opf_dir else href
            if path not in names:
                continue
            doc_dir = posixpath.dirname(path)

            def sink(src, doc_dir=doc_dir):
                ipath = posixpath.normpath(posixpath.join(doc_dir, src))
                if ipath not in names:
                    return src
                target = img_dir / posixpath.basename(ipath)
                if not target.exists():
                    target.write_bytes(z.read(ipath))
                return f"images/{target.name}"

            conv = MarkdownConverter(sink)
            conv.feed(z.read(path).decode("utf-8", errors="replace"))
            md = conv.result()
            words = len(re.findall(r"\w+", re.sub(r"!\[.*?\]\(.*?\)", "", md)))
            if words < 60:
                continue
            title = conv.first_heading or Path(href).stem
            body = f"# {title}\n\n" + re.sub(r"^# .*\n\n?", "", md, count=1)
            low = title.lower()
            if re.search(r"footnotes|endnotes", low):
                (src_dir / "footnotes.md").write_text(body, encoding="utf-8")
                continue
            if re.search(r"table of contents|^contents$|copyright|^index$|about the author|acknowledg", low) or book_title.lower().startswith(low) or low.startswith(book_title.lower()):
                continue
            m = re.match(r"(?:chapter\s+)?(\d+)[.:]?\s+(.*)", title, re.I)
            if m:
                n = int(m.group(1)); title = m.group(2).strip()
            else:
                n += 1
            fname = f"{n:02d}-{slugify(title)}.md"
            (src_dir / fname).write_text(body, encoding="utf-8")
            units.append((fname, title, words))

    lines = [f"# Syllabus: {book_title}", "", "Status: `unread` | `read` | `weak` | `owned`. The storyteller updates this after every event.", "",
             "| Unit | Title | Words | Status |", "| --- | --- | --- | --- |"]
    for fname, title, words in units:
        lines.append(f"| `source/{fname}` | {title} | {words} | unread |")
    (ws / "SYLLABUS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(units)} units -> {src_dir}")
    for fname, title, words in units:
        print(f"  {fname:50s} {words:6d} words")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
