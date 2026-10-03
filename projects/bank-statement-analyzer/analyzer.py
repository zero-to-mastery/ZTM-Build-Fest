#!/usr/bin/env python3
"""Bank Statement Analyzer: see where your money goes from a bank CSV export.

Runs fully offline. Your data never leaves your computer.
Works with Greek and English headers, ';' or ',' delimiters, and 1.234,56 or 1,234.56 numbers.
"""

import argparse
import csv
import html
import json
import re
import statistics
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent

# Header keywords (accent-free, lowercase) used to auto-detect columns.
HEADER_HINTS = {
    "date": ["date", "ημερομηνια", "ημερ", "ημ/νια", "ημνια", "booking", "posted"],
    "desc": ["description", "περιγραφη", "αιτιολογια", "details", "merchant", "καταστημα", "narrative", "memo"],
    "amount": ["amount", "ποσο", "value", "τζιρος"],
    "debit": ["debit", "χρεωση", "withdrawal", "εξοδα", "paid out"],
    "credit": ["credit", "πιστωση", "deposit", "εισπραξη", "paid in"],
}
DATE_FORMATS = ["%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y-%m-%d", "%d/%m/%y", "%d-%m-%y", "%d.%m.%y", "%Y/%m/%d"]


# ---------- helpers ----------

def norm(text: str) -> str:
    """Lowercase and remove accents, so 'ΧΡΈΩΣΗ' == 'χρεωση'."""
    text = unicodedata.normalize("NFD", str(text).lower())
    return "".join(c for c in text if not unicodedata.combining(c)).strip()


def parse_amount(raw: str):
    """Turn '1.234,56', '-12,50', '(12.50)', '12,50-' or '€ 5' into a float. Returns None if empty/invalid."""
    s = str(raw).strip()
    if not s:
        return None
    negative = s.startswith("-") or s.endswith("-") or (s.startswith("(") and s.endswith(")"))
    s = re.sub(r"[^\d.,]", "", s)
    if not s or not re.search(r"\d", s):
        return None
    if "," in s and "." in s:
        # the last separator is the decimal one
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".") if re.search(r",\d{1,2}$", s) else s.replace(",", "")
    elif "." in s:
        if not re.search(r"\.\d{1,2}$", s) or s.count(".") > 1:
            s = s.replace(".", "")
    try:
        value = float(s)
    except ValueError:
        return None
    return -value if negative else value


def parse_date(raw: str):
    s = str(raw).strip().split(" ")[0].split("T")[0]
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def read_rows(path: str, delimiter=None):
    p = Path(path)
    if not p.exists():
        sys.exit(f"Error: file not found: {path}")
    data = p.read_bytes()
    text = None
    for enc in ("utf-8-sig", "cp1253", "latin-1"):  # cp1253 = old Greek bank exports
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if delimiter is None:
        sample = "\n".join(text.splitlines()[:20])
        try:
            delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = ";" if sample.count(";") > sample.count(",") else ","
    return list(csv.reader(text.splitlines(), delimiter=delimiter))


def find_header(rows):
    """Return index of the header row (banks often add lines above it)."""
    for i, row in enumerate(rows[:30]):
        cells = [norm(c) for c in row]
        if any(h in c for c in cells for h in HEADER_HINTS["date"]) and any(
            h in c for c in cells for h in HEADER_HINTS["amount"] + HEADER_HINTS["debit"] + HEADER_HINTS["credit"]
        ):
            return i
    return 0


def detect_columns(header, overrides):
    cells = [norm(c) for c in header]
    cols = {}
    for key in HEADER_HINTS:
        if overrides.get(key):
            target = norm(overrides[key])
            if target not in cells:
                sys.exit(f"Error: column '{overrides[key]}' not found. Columns are: {header}")
            cols[key] = cells.index(target)
            continue
        for i, c in enumerate(cells):
            if i in cols.values():
                continue
            if any(h in c for h in HEADER_HINTS[key]):
                cols[key] = i
                break
    return cols


# ---------- loading & categorizing ----------

def load_transactions(path, overrides, flip=False, delimiter=None):
    rows = read_rows(path, delimiter)
    if not rows:
        sys.exit("Error: the file is empty.")
    h = find_header(rows)
    header, body = rows[h], rows[h + 1 :]
    cols = detect_columns(header, overrides)
    has_amount = "amount" in cols or ("debit" in cols and "credit" in cols)
    if "date" not in cols or "desc" not in cols or not has_amount:
        sys.exit(
            f"Error: could not detect columns. Found: {header}\n"
            "Use --date-col, --desc-col and --amount-col (or --debit-col/--credit-col) with the exact header names."
        )
    txs, skipped = [], 0
    for row in body:
        try:
            d = parse_date(row[cols["date"]])
            if "amount" in cols:
                amt = parse_amount(row[cols["amount"]])
            else:
                debit = parse_amount(row[cols["debit"]]) or 0.0
                credit = parse_amount(row[cols["credit"]]) or 0.0
                amt = credit - abs(debit)
            desc = row[cols["desc"]].strip()
        except IndexError:
            d = amt = None
        if d is None or amt is None:
            skipped += 1
            continue
        txs.append({"date": d, "desc": desc, "amount": -amt if flip else amt})
    if not txs:
        sys.exit("Error: no transactions could be read. Try --delimiter or the column options.")
    if skipped:
        print(f"Note: skipped {skipped} unreadable row(s) (headers/footers/blank lines).\n", file=sys.stderr)
    return txs


def load_categories(path):
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return {cat: [norm(k) for k in kws] for cat, kws in raw.items()}


def keyword_in(kw, text):
    return re.search(rf"(?<![a-zα-ω]){re.escape(kw)}(?![a-zα-ω])", text) is not None


def categorize(desc, amount, categories):
    text = norm(desc)
    matched = next((c for c, kws in categories.items() if any(keyword_in(k, text) for k in kws)), None)
    if amount > 0:
        return "Transfers" if matched == "Transfers" else "Income"
    return matched or "Other"


def merchant_key(desc):
    """Group 'NETFLIX.COM 12345' and 'NETFLIX.COM 67890' together."""
    t = re.sub(r"\d+", " ", norm(desc))
    t = re.sub(r"[^a-zα-ω.]+", " ", t)
    return " ".join(t.split()[:3]) or "unknown"


# ---------- analysis ----------

def analyze(txs, categories):
    for t in txs:
        t["category"] = categorize(t["desc"], t["amount"], categories)
    spend = [t for t in txs if t["amount"] < 0]
    income = sum(t["amount"] for t in txs if t["amount"] > 0)
    total_spend = -sum(t["amount"] for t in spend)

    by_cat = defaultdict(float)
    for t in spend:
        by_cat[t["category"]] += -t["amount"]

    by_month = defaultdict(lambda: [0.0, 0.0])  # income, spending
    for t in txs:
        key = t["date"].strftime("%Y-%m")
        by_month[key][0 if t["amount"] > 0 else 1] += abs(t["amount"])

    merchants = defaultdict(float)
    for t in spend:
        merchants[merchant_key(t["desc"])] += -t["amount"]

    groups = defaultdict(list)
    for t in spend:
        groups[merchant_key(t["desc"])].append(t)
    recurring = []
    for key, items in groups.items():
        months = {t["date"].strftime("%Y-%m") for t in items}
        amounts = [-t["amount"] for t in items]
        if len(months) >= 3 and max(amounts) <= min(amounts) * 1.25:
            recurring.append((key, len(months), statistics.mean(amounts)))
    recurring.sort(key=lambda r: -r[2])

    return {
        "income": income,
        "spend": total_spend,
        "by_cat": sorted(by_cat.items(), key=lambda kv: -kv[1]),
        "by_month": sorted(by_month.items()),
        "merchants": sorted(merchants.items(), key=lambda kv: -kv[1])[:10],
        "biggest": sorted(spend, key=lambda t: t["amount"])[:5],
        "recurring": recurring,
        "first": min(t["date"] for t in txs),
        "last": max(t["date"] for t in txs),
        "count": len(txs),
    }


# ---------- output ----------

def bar(value, maximum, width=24):
    return "█" * (round(width * value / maximum) if maximum else 0)


def print_report(r, cur):
    m = lambda x: f"{x:,.2f} {cur}"
    print(f"\n=== {r['first']} → {r['last']}  ({r['count']} transactions) ===")
    print(f"Income:   {m(r['income'])}\nSpending: {m(r['spend'])}\nNet:      {m(r['income'] - r['spend'])}")

    print("\n-- Spending by category --")
    top = r["by_cat"][0][1] if r["by_cat"] else 0
    for cat, v in r["by_cat"]:
        pct = 100 * v / r["spend"] if r["spend"] else 0
        print(f"{cat:<24}{m(v):>16} {pct:5.1f}%  {bar(v, top)}")

    print("\n-- By month (income / spending) --")
    for month, (inc, sp) in r["by_month"]:
        print(f"{month}  {m(inc):>16}  {m(sp):>16}")

    print("\n-- Top places you spent --")
    for name, v in r["merchants"]:
        print(f"{name[:30]:<32}{m(v):>16}")

    print("\n-- Biggest single expenses --")
    for t in r["biggest"]:
        print(f"{t['date']}  {m(-t['amount']):>14}  {t['desc'][:40]}")

    if r["recurring"]:
        print("\n-- Recurring payments (same place, similar amount, 3+ months) --")
        for key, months, avg in r["recurring"]:
            print(f"{key[:30]:<32}{m(avg):>16}  /month ({months} months seen)")
    print()


def export_csv(txs, path):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["date", "description", "amount", "category"])
        for t in sorted(txs, key=lambda t: t["date"]):
            w.writerow([t["date"].isoformat(), t["desc"], f"{t['amount']:.2f}", t["category"]])


def export_html(r, path, cur):
    e = html.escape
    m = lambda x: e(f"{x:,.2f} {cur}")
    top = r["by_cat"][0][1] if r["by_cat"] else 0
    cat_rows = "".join(
        f"<tr><td>{e(c)}</td><td class=n>{m(v)}</td><td><div class=bar style='width:{100*v/top:.0f}%'></div></td></tr>"
        for c, v in r["by_cat"]
    )
    month_rows = "".join(f"<tr><td>{e(k)}</td><td class=n>{m(i)}</td><td class=n>{m(s)}</td></tr>" for k, (i, s) in r["by_month"])
    rec_rows = "".join(f"<tr><td>{e(k)}</td><td class=n>{m(a)}</td><td class=n>{n} months</td></tr>" for k, n, a in r["recurring"])
    big_rows = "".join(f"<tr><td>{t['date']}</td><td>{e(t['desc'])}</td><td class=n>{m(-t['amount'])}</td></tr>" for t in r["biggest"])
    page = f"""<!doctype html><html><head><meta charset="utf-8"><title>Spending report</title>
<style>body{{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#222}}
table{{border-collapse:collapse;width:100%;margin-bottom:2rem}}td,th{{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}}
.n{{text-align:right;white-space:nowrap}}.bar{{background:#4f8cff;height:14px;border-radius:3px}}
.cards{{display:flex;gap:1rem;margin:1rem 0 2rem}}.card{{flex:1;background:#f4f6fa;padding:1rem;border-radius:8px}}.card b{{display:block;font-size:1.3rem}}</style></head><body>
<h1>Spending report</h1><p>{r['first']} → {r['last']} ({r['count']} transactions)</p>
<div class=cards><div class=card>Income<b>{m(r['income'])}</b></div><div class=card>Spending<b>{m(r['spend'])}</b></div><div class=card>Net<b>{m(r['income']-r['spend'])}</b></div></div>
<h2>By category</h2><table>{cat_rows}</table>
<h2>By month</h2><table><tr><th>Month</th><th class=n>Income</th><th class=n>Spending</th></tr>{month_rows}</table>
<h2>Biggest expenses</h2><table>{big_rows}</table>
{"<h2>Recurring payments</h2><table>"+rec_rows+"</table>" if rec_rows else ""}
</body></html>"""
    Path(path).write_text(page, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="Analyze a bank statement CSV and see where your money goes.")
    ap.add_argument("file", help="CSV exported from your bank")
    ap.add_argument("--currency", default="€")
    ap.add_argument("--categories", default=str(HERE / "categories.json"), help="your own category rules (JSON)")
    ap.add_argument("--html", metavar="OUT.html", help="also save a shareable HTML report")
    ap.add_argument("--csv", metavar="OUT.csv", help="also save the transactions with categories")
    ap.add_argument("--flip", action="store_true", help="use if your bank shows expenses as positive numbers")
    ap.add_argument("--delimiter", help="force a delimiter, e.g. ';'")
    for k in HEADER_HINTS:
        ap.add_argument(f"--{k}-col", help=f"exact header name of the {k} column")
    a = ap.parse_args()
    overrides = {k: getattr(a, f"{k}_col") for k in HEADER_HINTS}

    txs = load_transactions(a.file, overrides, a.flip, a.delimiter)
    result = analyze(txs, load_categories(a.categories))
    print_report(result, a.currency)
    if a.csv:
        export_csv(txs, a.csv)
        print(f"Saved {a.csv}")
    if a.html:
        export_html(result, a.html, a.currency)
        print(f"Saved {a.html}")


if __name__ == "__main__":
    main()
