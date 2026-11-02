#!/usr/bin/env python3
# @shared-law (Sovereign Law)
"""Convert PDF to Markdown using PyMuPDF (fitz)."""
import sys
import fitz  # PyMuPDF

def pdf_to_markdown(pdf_path, md_path):
    """Convert PDF to Markdown format."""
    doc = fitz.open(pdf_path)
    markdown_lines = []

    for page_num, page in enumerate(doc, 1):
        text = page.get_text()
        if text.strip():
            # Add page separator for clarity
            markdown_lines.append(f"\n---\n**Page {page_num}**\n---\n")
            markdown_lines.append(text)

    doc.close()

    # Write to markdown file
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(markdown_lines))

    print(f"Converted {pdf_path} to {md_path}")

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: python3 convert_pdf_to_md.py <input.pdf> <output.md>")
        sys.exit(1)

    pdf_to_markdown(sys.argv[1], sys.argv[2])
