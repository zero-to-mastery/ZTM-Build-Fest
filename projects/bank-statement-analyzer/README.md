# Bank Statement Analyzer

A command-line tool that reads the CSV you export from your bank and shows you where your money goes: spending by category, month by month, your top expenses, and payments that repeat every month.

**100% offline.** Your bank data never leaves your computer. No accounts, no API keys, no dependencies (Python standard library only).

## What problem does it solve?

Bank apps show a long list of transactions but rarely answer simple questions like "How much did I spend on food delivery this summer?" or "Which subscriptions am I still paying?". This tool answers those in one command, from a file you already have.

## Features

* Auto-detects columns from Greek or English headers (`Ημερομηνία`, `Περιγραφή`, `Ποσό`, `Date`, `Description`, `Amount`, or separate `Debit`/`Credit` columns)
* Handles `;` and `,` delimiters, `1.234,56` and `1,234.56` numbers, and old Greek encodings (cp1253)
* Skips junk lines above the header and footer totals
* Categorizes spending using editable keyword rules (`categories.json`), with Greek and English merchants
* Finds recurring payments (same place, similar amount, 3+ months)
* Exports a categorized CSV and a shareable HTML report

## Install

Requires Python 3.9+.

```bash
git clone https://github.com/zero-to-mastery/USERNAME/ZTM-Build-Fest.git
cd ZTM-Build-Fest/projects/bank-statement-analyzer
```

Nothing else to install.

## Usage

```bash
# Try it with the included (fake) sample data
python analyzer.py sample\_statement.csv

# Your own statement + HTML report + categorized CSV
python analyzer.py my\_statement.csv --html report.html --csv categorized.csv
```

If your bank shows expenses as positive numbers, add `--flip`. If columns are not detected, name them yourself:

```bash
python analyzer.py file.csv --date-col "Trans Date" --desc-col "Details" --amount-col "Value"
```

### Customize categories

Edit `categories.json` (or pass your own with `--categories my.json`). Each category is a list of keywords; accents and capitals are ignored, so `σκλαβενιτης` matches `ΣΚΛΑΒΕΝΊΤΗΣ`. Keywords match whole words only, and the first matching category wins. Incoming money is labelled `Income` (or `Transfers`).

## Run the tests

```bash
python -m unittest -v
```

## How I used AI

I used AI (Claude) as a coding assistant to design the structure, write the first version of the code and tests, and draft this README. The tool itself does not use AI and sends no data anywhere.

## Limitations

* Categories come from simple keyword matching, so unusual merchants fall under "Other" until you add them.
* Internal transfers between your own accounts count as spending/income; put their keywords in a category you ignore when reading the report.
* Only CSV exports are supported (not PDF statements).

## License

MIT

