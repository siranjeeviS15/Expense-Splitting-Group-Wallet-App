const express = require('express');
const path = require('path');
const { addExpense, calculateBalances } = require('./src/expenseService');
const {
  addMember,
  createSplit,
  deleteExpense,
  deleteMember,
  deleteSplit,
  getActiveSplitId,
  getSplits,
  initializeDatabase,
  loadGroup,
  pool,
  saveExpense,
  setActiveSplit
} = require('./src/database');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let group;
let activeSplitId;

app.get('/health', (req, res) => {
  res.status(group ? 200 : 503).json({ status: group ? 'ok' : 'starting' });
});

app.get('/api/group', (req, res) => res.json(group));

app.get('/api/splits', async (req, res) => {
  try {
    res.json(await getSplits());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/splits', async (req, res) => {
  try {
    const split = await createSplit(req.body.name);
    activeSplitId = split.id;
    group = split;
    res.status(201).json(await getSplits());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/splits/:id/activate', async (req, res) => {
  try {
    group = await setActiveSplit(req.params.id);
    activeSplitId = group.id;
    res.json(await getSplits());
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.delete('/api/splits/:id', async (req, res) => {
  try {
    const result = await deleteSplit(req.params.id);
    activeSplitId = result.activeSplitId;
    group = result.split;
    res.json(await getSplits());
  } catch (error) {
    res.status(error.message === 'Split not found' ? 404 : 500).json({ error: error.message });
  }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { description, amount, paidBy, participants } = req.body;
    if (typeof description !== 'string' || !description.trim()) {
      throw new Error('Expense description is required');
    }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new Error('Amount must be a positive number');
    }
    const canonicalPayer = group.members.find((member) =>
      member.toLowerCase() === String(paidBy || '').trim().toLowerCase()
    );
    if (!canonicalPayer) {
      throw new Error('Payer must be a member of this split');
    }
    if (!Array.isArray(participants) || !participants.length) {
      throw new Error('Select at least one member to share this expense');
    }
    const validParticipants = participants.map((participant) =>
      group.members.find((member) => member.toLowerCase() === String(participant).trim().toLowerCase())
    );
    if (validParticipants.some((participant) => !participant)) {
      throw new Error('All participants must be members of this split');
    }
    if (new Set(validParticipants.map((participant) => participant.toLowerCase())).size !== validParticipants.length) {
      throw new Error('A participant can only be selected once');
    }
    const expense = addExpense(
      { ...group, expenses: [...group.expenses] },
      {
        ...req.body,
        description: description.trim(),
        amount: Number(amount),
        paidBy: canonicalPayer,
        participants: validParticipants
      }
    );
    await saveExpense(expense, activeSplitId);
    group = await loadGroup(activeSplitId);
    res.status(201).json(group.expenses[group.expenses.length - 1]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/members', async (req, res) => {
  try {
    if (!req.body.name || !req.body.name.trim()) throw new Error('Member name is required');
    await addMember(req.body.name.trim(), activeSplitId);
    group = await loadGroup(activeSplitId);
    res.status(201).json(group.members);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/members/:name', async (req, res) => {
  try {
    await deleteMember(req.params.name, activeSplitId);
    group = await loadGroup(activeSplitId);
    res.json(group.members);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    await deleteExpense(req.params.id, activeSplitId);
    group = await loadGroup(activeSplitId);
    res.json(group.expenses);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/balances', (req, res) => res.json(calculateBalances(group)));

app.get('/api/summary', (req, res) => {
  res.json({
    total_expenses: Number(group.expenses.reduce((total, expense) => total + expense.amount, 0).toFixed(2)),
    member_count: group.members.length,
    balances: calculateBalances(group)
  });
});

app.get('/api/settlements', (req, res) => {
  const balances = calculateBalances(group).map((balance) => ({ ...balance }));
  const positive = balances.filter((balance) => balance.amount > 0);
  const negative = balances.filter((balance) => balance.amount < 0);
  const settlements = [];
  for (const payer of positive) {
    for (const receiver of negative) {
      if (payer.amount <= 0) break;
      const amount = Math.min(payer.amount, Math.abs(receiver.amount));
      if (amount > 0) {
        settlements.push({ from: receiver.member, to: payer.member, amount: Number(amount.toFixed(2)) });
        payer.amount -= amount;
        receiver.amount += amount;
      }
    }
  }
  res.json(settlements);
});

app.get('/api/export.csv', (req, res) => {
  const csvValue = (value) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [
    ['Description', 'Amount', 'Paid by', 'Participants', 'Share per person'],
    ...group.expenses.map((expense) => [
      expense.description,
      expense.amount,
      expense.paidBy,
      (expense.participants || []).join(', '),
      expense.share
    ])
  ];
  const csv = rows.map((row) => row.map(csvValue).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="split-expenses.csv"');
  res.send(csv);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await initializeDatabase();
  activeSplitId = await getActiveSplitId();
  group = await loadGroup(activeSplitId);
  app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Unable to start server:', error.message);
    process.exit(1);
  });
}

module.exports = { app, pool };
