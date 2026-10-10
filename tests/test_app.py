import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app


class GroupTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        app.DATA_FILE = Path(self.temp_dir.name) / "data.json"
        self.group = app.Group("Test Trip", ["Asha", "Ravi"])

    def test_expense_paid_by_new_member_adds_member_to_group(self):
        entry = self.group.add_expense({
            "description": "Dinner",
            "amount": 30,
            "paidBy": "Nina",
            "participants": ["Asha", "Ravi", "Nina"],
        })

        self.assertEqual("Dinner", entry["description"])
        self.assertIn("Nina", self.group.members)
        self.assertEqual(3, self.group.get_summary()["member_count"])


if __name__ == "__main__":
    unittest.main()
