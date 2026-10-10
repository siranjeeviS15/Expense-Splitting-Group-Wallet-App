function createGroup(name, members) {
  return {
    name,
    members,
    expenses: []
  };
}

function addExpense(group, expense) {
  const participants = expense.participants || group.members;
  const splitCount = participants.length;
  const share = Math.round((expense.amount / splitCount) * 100) / 100;

  const entry = {
    ...expense,
    participants,
    share
  };

  group.expenses.push(entry);
  return entry;
}

function calculateBalances(group) {
  const balances = Object.fromEntries(group.members.map((member) => [member, 0]));

  for (const expense of group.expenses) {
    const participants = expense.participants || group.members;
    const share = Math.round((expense.amount / participants.length) * 100) / 100;

    balances[expense.paidBy] += expense.amount;
    for (const participant of participants) {
      balances[participant] -= share;
    }
  }

  return group.members.map((member) => ({
    member,
    amount: Number(balances[member].toFixed(2))
  }));
}

module.exports = {
  createGroup,
  addExpense,
  calculateBalances
};
