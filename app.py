from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import os

ROOT = Path(__file__).parent.resolve()
PUBLIC_DIR = ROOT / "public"
DATA_FILE = ROOT / "data.json"

class Group:
    def __init__(self, name, members):
        self.name = name
        self.members = members
        self.expenses = []

    def load_from_disk(self):
        if DATA_FILE.exists():
            try:
                payload = json.loads(DATA_FILE.read_text(encoding="utf-8"))
                self.expenses = payload.get("expenses", [])
                self.name = payload.get("name", self.name)
                self.members = payload.get("members", self.members)
            except Exception:
                self.expenses = []

    def save_to_disk(self):
        DATA_FILE.write_text(json.dumps({"name": self.name, "members": self.members, "expenses": self.expenses}, indent=2), encoding="utf-8")

    def add_expense(self, expense):
        if not expense:
            raise ValueError("Expense data is required")

        description = str(expense.get("description", "")).strip()
        paid_by = str(expense.get("paidBy", "")).strip()
        amount = expense.get("amount")

        if not description or not paid_by:
            raise ValueError("Description and payer name are required")
        if amount is None or not isinstance(amount, (int, float)) or amount <= 0:
            raise ValueError("Amount must be a positive number")

        participants = expense.get("participants") or self.members
        if isinstance(participants, list):
            participants = [str(item).strip() for item in participants if str(item).strip()]
        else:
            participants = []

        if not participants:
            participants = list(self.members)

        if paid_by not in participants:
            participants.append(paid_by)

        for participant in participants:
            if participant not in self.members:
                self.members.append(participant)

        share = round(float(amount) / len(participants), 2)
        entry = {**expense, "description": description, "paidBy": paid_by, "amount": float(amount), "participants": participants, "share": share}
        self.expenses.append(entry)
        self.save_to_disk()
        return entry

    def add_member(self, name):
        member_name = str(name).strip()
        if not member_name:
            raise ValueError("Member name is required")
        normalized_name = member_name.lower()
        if not any(existing.lower() == normalized_name for existing in self.members):
            self.members.append(member_name)
            self.save_to_disk()
        return self.members

    def calculate_balances(self):
        balances = {member: 0.0 for member in self.members}
        for expense in self.expenses:
            participants = expense.get("participants") or self.members
            share = round(expense["amount"] / len(participants), 2)
            balances[expense["paidBy"]] += expense["amount"]
            for participant in participants:
                balances[participant] -= share
        return [{"member": member, "amount": round(balances[member], 2)} for member in self.members]

    def get_summary(self):
        total = sum(expense["amount"] for expense in self.expenses)
        balances = self.calculate_balances()
        return {
            "total_expenses": round(total, 2),
            "member_count": len(self.members),
            "balances": balances
        }

    def get_settlements(self):
        balances = self.calculate_balances()
        positive = [b for b in balances if b["amount"] > 0]
        negative = [b for b in balances if b["amount"] < 0]
        transactions = []
        for payer in positive:
            for receiver in negative:
                if payer["amount"] <= 0:
                    break
                amount = min(payer["amount"], abs(receiver["amount"]))
                if amount > 0:
                    transactions.append({
                        "from": receiver["member"],
                        "to": payer["member"],
                        "amount": round(amount, 2)
                    })
                    payer["amount"] -= amount
                    receiver["amount"] += amount
        return transactions


group = Group("Weekend Trip", ["Asha", "Ravi", "Nina"])
group.load_from_disk()

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw_body = self.rfile.read(length)
        if not raw_body:
            return {}
        try:
            return json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        if self.path == "/api/group":
            self._send_json(200, {"name": group.name, "members": group.members, "expenses": group.expenses})
        elif self.path == "/api/balances":
            self._send_json(200, group.calculate_balances())
        elif self.path == "/api/summary":
            self._send_json(200, group.get_summary())
        elif self.path == "/api/settlements":
            self._send_json(200, group.get_settlements())
        else:
            file_path = PUBLIC_DIR / "index.html"
            if not file_path.exists():
                self._send_json(404, {"error": "index.html not found"})
                return
            content = file_path.read_text(encoding="utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content.encode("utf-8"))))
            self.end_headers()
            self.wfile.write(content.encode("utf-8"))

    def do_POST(self):
        if self.path == "/api/expenses":
            try:
                expense = self._read_json_body()
                entry = group.add_expense(expense)
                self._send_json(201, entry)
            except Exception as exc:
                self._send_json(400, {"error": str(exc)})
        elif self.path == "/api/members":
            try:
                payload = self._read_json_body()
                members = group.add_member(payload.get("name", ""))
                self._send_json(201, {"members": members})
            except Exception as exc:
                self._send_json(400, {"error": str(exc)})
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == "__main__":
    host = "127.0.0.1"
    port = int(os.environ.get("PORT", "8000"))
    server = HTTPServer((host, port), Handler)
    print(f"Server running on http://{host}:{port}")
    server.serve_forever()
