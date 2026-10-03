import tempfile
import unittest
from datetime import date
from pathlib import Path

import analyzer as a

CATS = a.load_categories(Path(__file__).parent / "categories.json")


class TestParsing(unittest.TestCase):
    def test_amounts(self):
        cases = {
            "1.234,56": 1234.56, "1,234.56": 1234.56, "-12,50": -12.5, "12,50-": -12.5,
            "(12.50)": -12.5, "€ 5": 5.0, "1.234": 1234.0, "0,99": 0.99, "": None, "abc": None,
        }
        for raw, want in cases.items():
            self.assertEqual(a.parse_amount(raw), want, raw)

    def test_dates(self):
        self.assertEqual(a.parse_date("05/09/2026"), date(2026, 9, 5))
        self.assertEqual(a.parse_date("2026-09-05 14:30"), date(2026, 9, 5))
        self.assertIsNone(a.parse_date("Σύνολο"))


class TestCategories(unittest.TestCase):
    def test_greek_accents_and_case(self):
        self.assertEqual(a.categorize("ΣΚΛΑΒΕΝΊΤΗΣ ΑΕ 123", -10, CATS), "Groceries")

    def test_word_boundaries(self):
        self.assertEqual(a.categorize("CURRENT ACCOUNT FEE", -1, CATS), "Other")  # 'rent' inside 'current'

    def test_income(self):
        self.assertEqual(a.categorize("ΜΙΣΘΟΔΟΣΙΑ", 1000, CATS), "Income")


class TestLoading(unittest.TestCase):
    def _load(self, content, enc="utf-8", **kw):
        with tempfile.NamedTemporaryFile("wb", suffix=".csv", delete=False) as f:
            f.write(content.encode(enc))
        return a.load_transactions(f.name, {}, **kw)

    def test_debit_credit_columns_comma_delimiter(self):
        txs = self._load("Date,Description,Debit,Credit\n01/01/2026,Coffee,3.50,\n02/01/2026,Salary,,1000.00\n")
        self.assertEqual([t["amount"] for t in txs], [-3.5, 1000.0])

    def test_old_greek_encoding_and_preamble(self):
        txs = self._load("Κινήσεις\nΗμερομηνία;Αιτιολογία;Ποσό\n01/01/2026;ΚΑΦΕΣ;-3,50\n", enc="cp1253")
        self.assertEqual(len(txs), 1)
        self.assertEqual(txs[0]["desc"], "ΚΑΦΕΣ")

    def test_flip(self):
        txs = self._load("Date;Description;Amount\n01/01/2026;X;5,00\n", flip=True)
        self.assertEqual(txs[0]["amount"], -5.0)

    def test_sample_file(self):
        txs = a.load_transactions(str(Path(__file__).parent / "sample_statement.csv"), {})
        r = a.analyze(txs, CATS)
        self.assertEqual(r["count"], len(txs))
        self.assertAlmostEqual(r["income"], 5000.0)
        self.assertTrue(any("netflix" in k for k, _, _ in r["recurring"]))


if __name__ == "__main__":
    unittest.main()
