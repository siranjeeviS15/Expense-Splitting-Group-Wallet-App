const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const DATA_FILE = process.env.GROUP_WALLET_DATA_FILE || path.join(__dirname, '..', 'data.json');
const pool = process.env.DATABASE_URL && !process.env.GROUP_WALLET_DATA_FILE
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;
let useLocalStorage = !pool;

function newSplit(name = '') {
  return {
    id: randomUUID(),
    name: String(name).trim(),
    members: [],
    expenses: []
  };
}

function writeLocalState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function readLocalState() {
  if (!fs.existsSync(DATA_FILE)) {
    const split = newSplit();
    const state = { activeSplitId: split.id, splits: [split] };
    writeLocalState(state);
    return state;
  }

  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (Array.isArray(parsed.splits) && parsed.splits.length) {
    const state = parsed;
    for (const split of state.splits) {
      split.id = String(split.id || randomUUID());
      split.name = typeof split.name === 'string' ? split.name : '';
      split.members = Array.isArray(split.members) ? split.members : [];
      split.expenses = Array.isArray(split.expenses) ? split.expenses : [];
      for (const expense of split.expenses) {
        expense.id = String(expense.id || randomUUID());
      }
    }
    if (!state.splits.some((split) => split.id === String(state.activeSplitId))) {
      state.activeSplitId = state.splits[0].id;
    }
    writeLocalState(state);
    return state;
  }

  if (Array.isArray(parsed.members) && Array.isArray(parsed.expenses)) {
    const savedSplit = {
      id: randomUUID(),
      name: parsed.name === 'Weekend Trip' ? '' : String(parsed.name || ''),
      members: parsed.members.map((member) => String(member).trim()).filter(Boolean),
      expenses: parsed.expenses.map((expense) => ({
        ...expense,
        id: String(expense.id || randomUUID())
      }))
    };
    const freshSplit = newSplit();
    const state = {
      activeSplitId: freshSplit.id,
      splits: [savedSplit, freshSplit]
    };
    writeLocalState(state);
    return state;
  }

  throw new Error('The local split data file has an unsupported format.');
}

function getLocalSplit(splitId) {
  const state = readLocalState();
  const split = state.splits.find((item) => item.id === String(splitId || state.activeSplitId));
  if (!split) {
    throw new Error('Split not found');
  }
  return { state, split };
}

async function initializeDatabase() {
  if (useLocalStorage) {
    readLocalState();
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        UNIQUE (group_id, name)
      );
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
        paid_by INTEGER NOT NULL REFERENCES members(id),
        split_type TEXT NOT NULL DEFAULT 'equal'
      );
      CREATE TABLE IF NOT EXISTS expense_participants (
        expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        PRIMARY KEY (expense_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const groups = await pool.query('SELECT id FROM groups ORDER BY id');
    const activeSetting = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'active_split_id'"
    );
    if (groups.rowCount === 0) {
      const split = await pool.query("INSERT INTO groups (name) VALUES ('') RETURNING id");
      await pool.query(
        "INSERT INTO app_settings (key, value) VALUES ('active_split_id', $1)",
        [String(split.rows[0].id)]
      );
    } else if (!activeSetting.rowCount) {
      const freshSplit = await pool.query("INSERT INTO groups (name) VALUES ('') RETURNING id");
      await pool.query(`
        INSERT INTO app_settings (key, value) VALUES ('active_split_id', $1)
      `, [String(freshSplit.rows[0].id)]);
    } else if (!groups.rows.some((group) => String(group.id) === activeSetting.rows[0].value)) {
      await pool.query(`
        UPDATE app_settings SET value = $1 WHERE key = 'active_split_id'
      `, [String(groups.rows[0].id)]);
    }
  } catch (error) {
    if (process.env.REQUIRE_DATABASE === 'true') {
      console.error('PostgreSQL is required but could not be initialized.');
      throw error;
    }
    console.warn('PostgreSQL is unavailable. Falling back to the local JSON data store.');
    useLocalStorage = true;
    readLocalState();
  }
}

async function getSplits() {
  if (useLocalStorage) {
    const state = readLocalState();
    return {
      activeSplitId: state.activeSplitId,
      splits: state.splits.map((split) => ({
        id: split.id,
        name: split.name,
        memberCount: split.members.length,
        expenseCount: split.expenses.length
      }))
    };
  }

  const result = await pool.query(`
    SELECT g.id, g.name,
           (SELECT COUNT(*) FROM members m WHERE m.group_id = g.id)::int AS "memberCount",
           (SELECT COUNT(*) FROM expenses e WHERE e.group_id = g.id)::int AS "expenseCount"
    FROM groups g
    ORDER BY g.id
  `);
  const active = await pool.query(
    "SELECT value FROM app_settings WHERE key = 'active_split_id'"
  );
  return {
    activeSplitId: active.rows[0].value,
    splits: result.rows.map((split) => ({ ...split, id: String(split.id) }))
  };
}

async function createSplit(name = '') {
  const splitName = String(name || '').trim();
  if (useLocalStorage) {
    const state = readLocalState();
    const split = newSplit(splitName);
    state.splits.push(split);
    state.activeSplitId = split.id;
    writeLocalState(state);
    return split;
  }

  const result = await pool.query(
    'INSERT INTO groups (name) VALUES ($1) RETURNING id, name',
    [splitName]
  );
  const split = { ...result.rows[0], id: String(result.rows[0].id), members: [], expenses: [] };
  await setActiveSplit(split.id);
  return split;
}

async function deleteSplit(splitId) {
  if (useLocalStorage) {
    const state = readLocalState();
    const splitIndex = state.splits.findIndex((split) => split.id === String(splitId));
    if (splitIndex === -1) throw new Error('Split not found');

    state.splits.splice(splitIndex, 1);
    if (!state.splits.length) {
      const replacement = newSplit();
      state.splits.push(replacement);
      state.activeSplitId = replacement.id;
    } else if (!state.splits.some((split) => split.id === state.activeSplitId)) {
      state.activeSplitId = state.splits[0].id;
    }

    writeLocalState(state);
    return {
      activeSplitId: state.activeSplitId,
      split: state.splits.find((split) => split.id === state.activeSplitId)
    };
  }

  const client = await pool.connect();
  let nextActiveSplitId;
  try {
    await client.query('BEGIN');
    const deleted = await client.query(
      'DELETE FROM groups WHERE id = $1 RETURNING id',
      [splitId]
    );
    if (!deleted.rowCount) throw new Error('Split not found');

    const remaining = await client.query('SELECT id FROM groups ORDER BY id');
    const active = await client.query(
      "SELECT value FROM app_settings WHERE key = 'active_split_id' FOR UPDATE"
    );
    const activeStillExists = remaining.rows.some((split) =>
      String(split.id) === active.rows[0]?.value
    );

    if (activeStillExists) {
      nextActiveSplitId = active.rows[0].value;
    } else if (remaining.rowCount) {
      nextActiveSplitId = String(remaining.rows[0].id);
    } else {
      const replacement = await client.query(
        "INSERT INTO groups (name) VALUES ('') RETURNING id"
      );
      nextActiveSplitId = String(replacement.rows[0].id);
    }

    await client.query(`
      INSERT INTO app_settings (key, value) VALUES ('active_split_id', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [nextActiveSplitId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    activeSplitId: nextActiveSplitId,
    split: await loadGroup(nextActiveSplitId)
  };
}

async function setActiveSplit(splitId) {
  if (useLocalStorage) {
    const state = readLocalState();
    const split = state.splits.find((item) => item.id === String(splitId));
    if (!split) throw new Error('Split not found');
    state.activeSplitId = split.id;
    writeLocalState(state);
    return split;
  }

  const result = await pool.query('SELECT id FROM groups WHERE id = $1', [splitId]);
  if (!result.rowCount) throw new Error('Split not found');
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('active_split_id', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [String(splitId)]);
  return loadGroup(splitId);
}

async function getActiveSplitId() {
  if (useLocalStorage) {
    return readLocalState().activeSplitId;
  }
  const result = await pool.query(
    "SELECT value FROM app_settings WHERE key = 'active_split_id'"
  );
  return result.rows[0].value;
}

async function loadGroup(splitId) {
  if (useLocalStorage) {
    return getLocalSplit(splitId).split;
  }

  const id = splitId || await getActiveSplitId();
  const groupResult = await pool.query('SELECT id, name FROM groups WHERE id = $1', [id]);
  const group = groupResult.rows[0];
  if (!group) throw new Error('Split not found');

  const membersResult = await pool.query(
    'SELECT id, name FROM members WHERE group_id = $1 ORDER BY id',
    [group.id]
  );
  const expensesResult = await pool.query(`
    SELECT e.id, e.description, e.amount::float8 AS amount,
           payer.name AS "paidBy", e.split_type AS "splitType"
    FROM expenses e
    JOIN members payer ON payer.id = e.paid_by
    WHERE e.group_id = $1
    ORDER BY e.id
  `, [group.id]);
  const expenses = [];
  for (const expense of expensesResult.rows) {
    const participantsResult = await pool.query(`
      SELECT m.name
      FROM expense_participants ep
      JOIN members m ON m.id = ep.member_id
      WHERE ep.expense_id = $1
      ORDER BY m.id
    `, [expense.id]);
    const participants = participantsResult.rows.map((row) => row.name);
    expenses.push({
      ...expense,
      id: String(expense.id),
      participants,
      share: participants.length
        ? Math.round((expense.amount / participants.length) * 100) / 100
        : 0
    });
  }

  return {
    id: String(group.id),
    name: group.name,
    members: membersResult.rows.map((member) => member.name),
    expenses
  };
}

async function saveExpense(expense, splitId) {
  if (useLocalStorage) {
    const { state, split } = getLocalSplit(splitId);
    const participants = expense.participants;
    const entry = {
      ...expense,
      id: String(expense.id || randomUUID()),
      description: String(expense.description).trim(),
      amount: Number(expense.amount),
      paidBy: String(expense.paidBy).trim(),
      participants: [...participants],
      splitType: 'equal',
      share: Number((Number(expense.amount) / participants.length).toFixed(2))
    };
    split.expenses.push(entry);
    writeLocalState(state);
    return entry;
  }

  const groupId = splitId || await getActiveSplitId();
  const payerResult = await pool.query(
    'SELECT id FROM members WHERE group_id = $1 AND LOWER(name) = LOWER($2)',
    [groupId, expense.paidBy]
  );
  const payer = payerResult.rows[0];
  if (!payer) throw new Error('Payer must be a member of this split');

  const participantIds = [];
  for (const name of expense.participants) {
    const participant = await pool.query(
      'SELECT id FROM members WHERE group_id = $1 AND LOWER(name) = LOWER($2)',
      [groupId, name]
    );
    if (!participant.rowCount) throw new Error(`Unknown participant: ${name}`);
    participantIds.push(participant.rows[0].id);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      INSERT INTO expenses (group_id, description, amount, paid_by, split_type)
      VALUES ($1, $2, $3, $4, 'equal') RETURNING id
    `, [groupId, expense.description, expense.amount, payer.id]);
    for (const memberId of participantIds) {
      await client.query(
        'INSERT INTO expense_participants (expense_id, member_id) VALUES ($1, $2)',
        [result.rows[0].id, memberId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function addMember(name, splitId) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('Member name is required');

  if (useLocalStorage) {
    const { state, split } = getLocalSplit(splitId);
    if (!split.members.some((member) => member.toLowerCase() === trimmedName.toLowerCase())) {
      split.members.push(trimmedName);
      writeLocalState(state);
    }
    return split.members;
  }

  const groupId = splitId || await getActiveSplitId();
  const result = await pool.query(`
    INSERT INTO members (group_id, name) VALUES ($1, $2)
    ON CONFLICT (group_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING name
  `, [groupId, trimmedName]);
  return result.rows[0].name;
}

async function deleteExpense(expenseId, splitId) {
  if (useLocalStorage) {
    const { state, split } = getLocalSplit(splitId);
    const originalCount = split.expenses.length;
    split.expenses = split.expenses.filter((expense) => String(expense.id) !== String(expenseId));
    if (split.expenses.length === originalCount) throw new Error('Expense not found');
    writeLocalState(state);
    return;
  }

  const result = await pool.query(
    'DELETE FROM expenses WHERE id = $1 AND group_id = $2',
    [expenseId, splitId || await getActiveSplitId()]
  );
  if (!result.rowCount) throw new Error('Expense not found');
}

async function deleteMember(name, splitId) {
  if (useLocalStorage) {
    const { state, split } = getLocalSplit(splitId);
    const member = split.members.find((item) => item.toLowerCase() === String(name).toLowerCase());
    if (!member) throw new Error('Member not found');
    const isUsed = split.expenses.some((expense) =>
      String(expense.paidBy).toLowerCase() === member.toLowerCase()
      || (expense.participants || []).some((participant) =>
        String(participant).toLowerCase() === member.toLowerCase())
    );
    if (isUsed) throw new Error('Cannot remove a member who is part of a saved expense');
    split.members = split.members.filter((item) => item !== member);
    writeLocalState(state);
    return;
  }

  const groupId = splitId || await getActiveSplitId();
  const memberResult = await pool.query(
    'SELECT id FROM members WHERE group_id = $1 AND LOWER(name) = LOWER($2)',
    [groupId, name]
  );
  if (!memberResult.rowCount) throw new Error('Member not found');
  const memberId = memberResult.rows[0].id;
  const usedResult = await pool.query(`
    SELECT 1
    FROM expenses e
    LEFT JOIN expense_participants ep ON ep.expense_id = e.id
    WHERE e.group_id = $1 AND (e.paid_by = $2 OR ep.member_id = $2)
    LIMIT 1
  `, [groupId, memberId]);
  if (usedResult.rowCount) {
    throw new Error('Cannot remove a member who is part of a saved expense');
  }
  await pool.query('DELETE FROM members WHERE id = $1 AND group_id = $2', [memberId, groupId]);
}

module.exports = {
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
};
