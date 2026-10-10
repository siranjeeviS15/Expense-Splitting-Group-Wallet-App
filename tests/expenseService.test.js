const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateBalances, createGroup, addExpense } = require('../src/expenseService');

test('calculateBalances returns simple settlement values', () => {
  const group = createGroup('Trip', ['Asha', 'Ravi', 'Nina']);
  addExpense(group, {
    description: 'Hotel',
    amount: 6000,
    paidBy: 'Asha',
    participants: ['Asha', 'Ravi', 'Nina'],
    splitType: 'equal'
  });

  const balances = calculateBalances(group);
  assert.deepEqual(balances, [
    { member: 'Asha', amount: 4000 },
    { member: 'Ravi', amount: -2000 },
    { member: 'Nina', amount: -2000 }
  ]);
});

test('addExpense adds to group expenses', () => {
  const group = createGroup('Dinner', ['Asha', 'Ravi']);
  addExpense(group, {
    description: 'Dinner',
    amount: 2000,
    paidBy: 'Asha',
    participants: ['Asha', 'Ravi'],
    splitType: 'equal'
  });

  assert.equal(group.expenses.length, 1);
  assert.equal(group.expenses[0].description, 'Dinner');
});
