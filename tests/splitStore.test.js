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

test('accounts have isolated splits and can manage their own data only', async (t) => {
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await store.initializeDatabase();
  const userA = await store.createUser('one@example.com', 'test-hash');
  const userB = await store.createUser('two@example.com', 'test-hash');

  const initial = await store.getSplits(userA.id);
  assert.equal(initial.splits.length, 1);
  const active = await store.loadGroup(initial.activeSplitId, userA.id);
  assert.equal(active.name, '');
  assert.deepEqual(active.members, []);
  assert.deepEqual(active.expenses, []);

  const state = JSON.parse(fs.readFileSync(process.env.GROUP_WALLET_DATA_FILE, 'utf8'));
  const legacySplit = state.splits.find((split) => split.ownerId === null);
  assert.deepEqual(legacySplit.members, ['Asha', 'Ravi']);
  assert.equal(legacySplit.expenses[0].description, 'Old bill');

  const split = await store.createSplit('Weekend', userA.id);
  assert.equal(split.name, 'Weekend');
  await store.addMember('Casey', split.id, userA.id);
  await store.addMember('Taylor', split.id, userA.id);
  await store.saveExpense({
    description: 'Dinner',
    amount: 48,
    paidBy: 'Casey',
    participants: ['Casey', 'Taylor']
  }, split.id, userA.id);

  const saved = await store.loadGroup(split.id, userA.id);
  assert.equal(saved.expenses.length, 1);
  assert.deepEqual(saved.expenses[0].participants, ['Casey', 'Taylor']);
  await assert.rejects(store.deleteMember('Taylor', split.id, userA.id), /part of a saved expense/);
  await assert.rejects(store.loadGroup(split.id, userB.id), /Split not found/);
  await assert.rejects(store.deleteSplit(split.id, userB.id), /Split not found/);

  assert.equal((await store.getSplits(userB.id)).splits.length, 1);
  const privateDefault = (await store.getSplits(userB.id)).activeSplitId;
  assert.notEqual(privateDefault, initial.activeSplitId);

  await store.deleteExpense(saved.expenses[0].id, split.id, userA.id);
  await store.deleteMember('Taylor', split.id, userA.id);
  assert.deepEqual((await store.loadGroup(split.id, userA.id)).members, ['Casey']);

  await store.deleteSplit(split.id, userA.id);
  let remainingSplits = await store.getSplits(userA.id);
  assert.equal(remainingSplits.splits.length, 1);
  assert.equal(remainingSplits.activeSplitId, initial.activeSplitId);

  const deletedLastSplit = await store.deleteSplit(initial.activeSplitId, userA.id);
  remainingSplits = await store.getSplits(userA.id);
  assert.equal(remainingSplits.splits.length, 1);
  assert.notEqual(remainingSplits.activeSplitId, initial.activeSplitId);
  assert.deepEqual(deletedLastSplit.split.members, []);
  assert.deepEqual(deletedLastSplit.split.expenses, []);
});
