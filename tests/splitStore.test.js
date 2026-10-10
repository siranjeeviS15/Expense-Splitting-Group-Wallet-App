const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-split-test-'));
process.env.GROUP_WALLET_DATA_FILE = path.join(directory, 'data.json');
fs.writeFileSync(process.env.GROUP_WALLET_DATA_FILE, JSON.stringify({
  name: 'Weekend Trip',
  members: ['Asha', 'Ravi'],
  expenses: [{
    description: 'Old bill',
    amount: 20,
    paidBy: 'Asha',
    participants: ['Asha', 'Ravi']
  }]
}));

const store = require('../src/database');

test('new empty splits preserve legacy data and support split-specific expense management', async (t) => {
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await store.initializeDatabase();

  const initial = await store.getSplits();
  assert.equal(initial.splits.length, 2);
  const active = await store.loadGroup(initial.activeSplitId);
  assert.equal(active.name, '');
  assert.deepEqual(active.members, []);
  assert.deepEqual(active.expenses, []);

  const archivedSplit = initial.splits.find((split) => split.id !== initial.activeSplitId);
  const archived = await store.loadGroup(archivedSplit.id);
  assert.equal(archived.name, '');
  assert.deepEqual(archived.members, ['Asha', 'Ravi']);
  assert.equal(archived.expenses[0].description, 'Old bill');

  const split = await store.createSplit('Weekend');
  assert.equal(split.name, 'Weekend');
  await store.addMember('Casey', split.id);
  await store.addMember('Taylor', split.id);
  await store.saveExpense({
    description: 'Dinner',
    amount: 48,
    paidBy: 'Casey',
    participants: ['Casey', 'Taylor']
  }, split.id);

  const saved = await store.loadGroup(split.id);
  assert.equal(saved.expenses.length, 1);
  assert.deepEqual(saved.expenses[0].participants, ['Casey', 'Taylor']);
  await assert.rejects(store.deleteMember('Taylor', split.id), /part of a saved expense/);

  await store.deleteExpense(saved.expenses[0].id, split.id);
  await store.deleteMember('Taylor', split.id);
  assert.deepEqual((await store.loadGroup(split.id)).members, ['Casey']);
  assert.equal((await store.loadGroup(archivedSplit.id)).expenses.length, 1);

  await store.deleteSplit(archivedSplit.id);
  let remainingSplits = await store.getSplits();
  assert.equal(remainingSplits.splits.some((item) => item.id === archivedSplit.id), false);
  assert.equal(remainingSplits.activeSplitId, split.id);

  await store.deleteSplit(split.id);
  remainingSplits = await store.getSplits();
  assert.equal(remainingSplits.activeSplitId, initial.activeSplitId);
  assert.equal(remainingSplits.splits.length, 1);

  const deletedLastSplit = await store.deleteSplit(initial.activeSplitId);
  remainingSplits = await store.getSplits();
  assert.equal(remainingSplits.splits.length, 1);
  assert.notEqual(remainingSplits.activeSplitId, initial.activeSplitId);
  assert.deepEqual(deletedLastSplit.split.members, []);
  assert.deepEqual(deletedLastSplit.split.expenses, []);
});
