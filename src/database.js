const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const DATA_FILE = process.env.GROUP_WALLET_DATA_FILE || path.join(__dirname, '..', 'data.json');
const pool = process.env.DATABASE_URL && !process.env.GROUP_WALLET_DATA_FILE
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;
let useLocalStorage = !pool;

function emptyLocalState() {
  return { users: [], splits: [] };
}

function writeLocalState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function readLocalState() {
  if (!fs.existsSync(DATA_FILE)) {
    const state = emptyLocalState();
    writeLocalState(state);
    return state;
  }

  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  let state;
  if (Array.isArray(parsed.splits)) {
    state = {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      splits: parsed.splits
    };
  } else if (Array.isArray(parsed.members) && Array.isArray(parsed.expenses)) {
    const savedSplit = {
      id: randomUUID(),
      ownerId: null,
      name: parsed.name === 'Weekend Trip' ? '' : String(parsed.name || ''),
      members: parsed.members.map((member) => String(member).trim()).filter(Boolean),
      expenses: parsed.expenses.map((expense) => ({
        ...expense,
        id: String(expense.id || randomUUID())
      }))
    };
    state = { ...emptyLocalState(), splits: [savedSplit] };
  } else {
    throw new Error('The local split data file has an unsupported format.');
  }

  state.users = state.users.map((user) => ({
    ...user,
    id: String(user.id || randomUUID()),
    email: typeof user.email === 'string' ? user.email.toLowerCase() : null,
    phone: typeof user.phone === 'string' ? user.phone : null
  }));
  for (const split of state.splits) {
    split.id = String(split.id || randomUUID());
    split.ownerId = split.ownerId ? String(split.ownerId) : null;
    split.name = typeof split.name === 'string' ? split.name : '';
    split.members = Array.isArray(split.members) ? split.members : [];
    split.expenses = Array.isArray(split.expenses) ? split.expenses : [];
    for (const expense of split.expenses) {
      expense.id = String(expense.id || randomUUID());
    }
  }
  writeLocalState(state);
  return state;
}

function requireUserId(userId) {
  if (!userId) throw new Error('Authentication required');
  return String(userId);
}

function localUser(state, userId) {
  return state.users.find((user) => user.id === String(userId));
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    email: row.email,
    phone: row.phone_e164 || row.phone || null,
    passwordHash: row.password_hash || null,
    googleId: row.google_id || null
  };
}

function publicUser(user) {
  return user ? {
    id: String(user.id),
    email: user.email || null,
    phone: user.phone_e164 || user.phone || null
  } : null;
}

function newSplit(ownerId, name = '') {
  return {
    id: randomUUID(),
    ownerId: String(ownerId),
    name: String(name).trim(),
    members: [],
    expenses: []
  };
}

function getLocalSplit(splitId, userId) {
  const state = readLocalState();
  const ownerId = requireUserId(userId);
  const split = state.splits.find((item) =>
    item.id === String(splitId) && item.ownerId === ownerId
  );
  if (!split) throw new Error('Split not found');
  return { state, split };
}

async function createUser(email, passwordHash) {
  const normalizedEmail = String(email).trim().toLowerCase();
  if (useLocalStorage) {
    const state = readLocalState();
    if (state.users.some((user) => user.email === normalizedEmail)) {
      const error = new Error('An account with this email already exists.');
      error.code = 'USER_EXISTS';
      throw error;
    }
    const user = {
      id: randomUUID(),
      email: normalizedEmail,
      phone: null,
      passwordHash,
      googleId: null
    };
    state.users.push(user);
    writeLocalState(state);
    return publicUser(user);
  }

  try {
    const result = await pool.query(`
      INSERT INTO app_users (email, password_hash)
      VALUES ($1, $2)
      RETURNING id, email, phone_e164, password_hash, google_id
    `, [normalizedEmail, passwordHash]);
    return publicUser(userFromRow(result.rows[0]));
  } catch (error) {
    if (error.code === '23505') {
      const duplicate = new Error('An account with this email already exists.');
      duplicate.code = 'USER_EXISTS';
      throw duplicate;
    }
    throw error;
  }
}

async function findUserByEmail(email) {
  const normalizedEmail = String(email).trim().toLowerCase();
  if (useLocalStorage) {
    const state = readLocalState();
    return state.users.find((user) => user.email === normalizedEmail) || null;
  }
  const result = await pool.query(
    'SELECT id, email, phone_e164, password_hash, google_id FROM app_users WHERE email = $1',
    [normalizedEmail]
  );
  return userFromRow(result.rows[0]);
}

async function findUserById(userId) {
  if (useLocalStorage) {
    return publicUser(localUser(readLocalState(), userId));
  }
  const result = await pool.query(
    'SELECT id, email, phone_e164 FROM app_users WHERE id = $1',
    [userId]
  );
  return publicUser(result.rows[0]);
}

async function findOrCreateGoogleUser(email, googleId) {
  const normalizedEmail = String(email).trim().toLowerCase();
  if (useLocalStorage) {
    const state = readLocalState();
    const googleUser = state.users.find((user) => user.googleId === googleId);
    if (googleUser) return publicUser(googleUser);

    const emailUser = state.users.find((user) => user.email === normalizedEmail);
    if (emailUser) {
      const error = new Error('This email already has an account. Sign in with its original method.');
      error.code = 'ACCOUNT_LINK_REQUIRED';
      throw error;
    }

    const user = {
      id: randomUUID(),
      email: normalizedEmail,
      phone: null,
      passwordHash: null,
      googleId
    };
    state.users.push(user);
    writeLocalState(state);
    return publicUser(user);
  }

  const byGoogle = await pool.query(
    'SELECT id, email, phone_e164 FROM app_users WHERE google_id = $1',
    [googleId]
  );
  if (byGoogle.rowCount) return publicUser(byGoogle.rows[0]);

  const byEmail = await pool.query(
    'SELECT id FROM app_users WHERE email = $1',
    [normalizedEmail]
  );
  if (byEmail.rowCount) {
    const error = new Error('This email already has an account. Sign in with its original method.');
    error.code = 'ACCOUNT_LINK_REQUIRED';
    throw error;
  }

  try {
    const result = await pool.query(`
      INSERT INTO app_users (email, google_id)
      VALUES ($1, $2)
      RETURNING id, email, phone_e164
    `, [normalizedEmail, googleId]);
    return publicUser(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      const duplicate = new Error('This Google account is already linked.');
      duplicate.code = 'ACCOUNT_LINK_REQUIRED';
      throw duplicate;
    }
    throw error;
  }
}

async function findOrCreatePhoneUser(phone) {
  const phoneNumber = String(phone);
  if (useLocalStorage) {
    const state = readLocalState();
    let user = state.users.find((entry) => entry.phone === phoneNumber);
    if (!user) {
      user = {
        id: randomUUID(),
        email: null,
        phone: phoneNumber,
        passwordHash: null,
        googleId: null
      };
      state.users.push(user);
      writeLocalState(state);
    }
    return publicUser(user);
  }

  const result = await pool.query(`
    INSERT INTO app_users (phone_e164)
    VALUES ($1)
    ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
    RETURNING id, email, phone_e164
  `, [phoneNumber]);
  return publicUser(result.rows[0]);
}

async function initializeDatabase() {
  if (useLocalStorage) {
    readLocalState();
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE,
        phone_e164 TEXT UNIQUE,
        password_hash TEXT,
        google_id TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE app_users ALTER COLUMN email DROP NOT NULL;
      ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone_e164 TEXT UNIQUE;
      ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_check;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'app_users_auth_method_check'
            AND conrelid = 'app_users'::regclass
        ) THEN
          ALTER TABLE app_users ADD CONSTRAINT app_users_auth_method_check
            CHECK (password_hash IS NOT NULL OR google_id IS NOT NULL OR phone_e164 IS NOT NULL);
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        owner_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT ''
      );
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES app_users(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS groups_owner_id_idx ON groups(owner_id);
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
    `);
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

async function getSplits(userId, requestedActiveId) {
  const ownerId = requireUserId(userId);
  let summaries;
  if (useLocalStorage) {
    const state = readLocalState();
    if (!state.users.some((user) => user.id === ownerId)) {
      throw new Error('User not found');
    }
    summaries = state.splits
      .filter((split) => split.ownerId === ownerId)
      .map((split) => ({
        id: split.id,
        name: split.name,
        memberCount: split.members.length,
        expenseCount: split.expenses.length
      }));
  } else {
    const result = await pool.query(`
      SELECT g.id, g.name,
             (SELECT COUNT(*) FROM members m WHERE m.group_id = g.id)::int AS "memberCount",
             (SELECT COUNT(*) FROM expenses e WHERE e.group_id = g.id)::int AS "expenseCount"
      FROM groups g
      WHERE g.owner_id = $1
      ORDER BY g.id
    `, [ownerId]);
    summaries = result.rows.map((split) => ({ ...split, id: String(split.id) }));
  }

  if (!summaries.length) {
    const split = await createSplit('', ownerId);
    summaries = [{
      id: String(split.id),
      name: split.name,
      memberCount: 0,
      expenseCount: 0
    }];
  }

  const activeSplitId = summaries.some((split) => split.id === String(requestedActiveId))
    ? String(requestedActiveId)
    : summaries[0].id;
  return { activeSplitId, splits: summaries };
}

async function createSplit(name = '', userId) {
  const ownerId = requireUserId(userId);
  const splitName = String(name || '').trim();
  if (useLocalStorage) {
    const state = readLocalState();
    if (!state.users.some((user) => user.id === ownerId)) throw new Error('User not found');
    const split = newSplit(ownerId, splitName);
    state.splits.push(split);
    writeLocalState(state);
    return split;
  }

  const result = await pool.query(
    'INSERT INTO groups (owner_id, name) VALUES ($1, $2) RETURNING id, name',
    [ownerId, splitName]
  );
  return {
    ...result.rows[0],
    id: String(result.rows[0].id),
    ownerId,
    members: [],
    expenses: []
  };
}

async function deleteSplit(splitId, userId) {
  const ownerId = requireUserId(userId);
  if (useLocalStorage) {
    const state = readLocalState();
    const splitIndex = state.splits.findIndex((split) =>
      split.id === String(splitId) && split.ownerId === ownerId
    );
    if (splitIndex === -1) throw new Error('Split not found');
    state.splits.splice(splitIndex, 1);
    let remaining = state.splits.filter((split) => split.ownerId === ownerId);
    if (!remaining.length) {
      const replacement = newSplit(ownerId);
      state.splits.push(replacement);
      remaining = [replacement];
    }
    writeLocalState(state);
    return {
      activeSplitId: remaining[0].id,
      split: remaining[0]
    };
  }

  const client = await pool.connect();
  let nextActiveSplitId;
  try {
    await client.query('BEGIN');
    const deleted = await client.query(
      'DELETE FROM groups WHERE id = $1 AND owner_id = $2 RETURNING id',
      [splitId, ownerId]
    );
    if (!deleted.rowCount) throw new Error('Split not found');

    let remaining = await client.query(
      'SELECT id FROM groups WHERE owner_id = $1 ORDER BY id',
      [ownerId]
    );
    if (!remaining.rowCount) {
      const replacement = await client.query(
        "INSERT INTO groups (owner_id, name) VALUES ($1, '') RETURNING id",
        [ownerId]
      );
      remaining = { rows: replacement.rows, rowCount: 1 };
    }
    nextActiveSplitId = String(remaining.rows[0].id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    activeSplitId: nextActiveSplitId,
    split: await loadGroup(nextActiveSplitId, ownerId)
  };
}

async function setActiveSplit(splitId, userId) {
  return loadGroup(splitId, userId);
}

async function loadGroup(splitId, userId) {
  const ownerId = requireUserId(userId);
  if (useLocalStorage) {
    return getLocalSplit(splitId, ownerId).split;
  }

  const id = splitId || (await getSplits(ownerId)).activeSplitId;
  const groupResult = await pool.query(
    'SELECT id, name FROM groups WHERE id = $1 AND owner_id = $2',
    [id, ownerId]
  );
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
    ownerId,
    name: group.name,
    members: membersResult.rows.map((member) => member.name),
    expenses
  };
}

async function saveExpense(expense, splitId, userId) {
  const ownerId = requireUserId(userId);
  if (useLocalStorage) {
    const { state, split } = getLocalSplit(splitId, ownerId);
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

  const groupId = splitId || (await getSplits(ownerId)).activeSplitId;
  const groupResult = await pool.query(
    'SELECT id FROM groups WHERE id = $1 AND owner_id = $2',
    [groupId, ownerId]
  );
  if (!groupResult.rowCount) throw new Error('Split not found');
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

async function addMember(name, splitId, userId) {
  const ownerId = requireUserId(userId);
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('Member name is required');

  if (useLocalStorage) {
    const { state, split } = getLocalSplit(splitId, ownerId);
    if (!split.members.some((member) => member.toLowerCase() === trimmedName.toLowerCase())) {
      split.members.push(trimmedName);
      writeLocalState(state);
    }
    return split.members;
  }

  const groupId = splitId || (await getSplits(ownerId)).activeSplitId;
  const result = await pool.query(`
    INSERT INTO members (group_id, name)
    SELECT id, $3 FROM groups WHERE id = $1 AND owner_id = $2
    ON CONFLICT (group_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING name
  `, [groupId, ownerId, trimmedName]);
  if (!result.rowCount) throw new Error('Split not found');
  return result.rows[0].name;
}

async function deleteExpense(expenseId, splitId, userId) {
  const ownerId = requireUserId(userId);
  if (useLocalStorage) {
    const { state, split } = getLocalSplit(splitId, ownerId);
    const originalCount = split.expenses.length;
    split.expenses = split.expenses.filter((expense) => String(expense.id) !== String(expenseId));
    if (split.expenses.length === originalCount) throw new Error('Expense not found');
    writeLocalState(state);
    return;
  }

  const result = await pool.query(`
    DELETE FROM expenses e
    USING groups g
    WHERE e.id = $1 AND e.group_id = $2 AND g.id = e.group_id AND g.owner_id = $3
  `, [expenseId, splitId, ownerId]);
  if (!result.rowCount) throw new Error('Expense not found');
}

async function deleteMember(name, splitId, userId) {
  const ownerId = requireUserId(userId);
  if (useLocalStorage) {
    const { state, split } = getLocalSplit(splitId, ownerId);
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

  const groupId = splitId;
  const memberResult = await pool.query(`
    SELECT m.id
    FROM members m
    JOIN groups g ON g.id = m.group_id
    WHERE g.id = $1 AND g.owner_id = $2 AND LOWER(m.name) = LOWER($3)
  `, [groupId, ownerId, name]);
  if (!memberResult.rowCount) throw new Error('Member not found');
  const memberId = memberResult.rows[0].id;
  const usedResult = await pool.query(`
    SELECT 1
    FROM expenses e
    JOIN groups g ON g.id = e.group_id
    LEFT JOIN expense_participants ep ON ep.expense_id = e.id
    WHERE g.id = $1 AND g.owner_id = $2
      AND (e.paid_by = $3 OR ep.member_id = $3)
    LIMIT 1
  `, [groupId, ownerId, memberId]);
  if (usedResult.rowCount) {
    throw new Error('Cannot remove a member who is part of a saved expense');
  }
  await pool.query(
    'DELETE FROM members WHERE id = $1 AND group_id = $2',
    [memberId, groupId]
  );
}

module.exports = {
  addMember,
  createSplit,
  createUser,
  deleteExpense,
  deleteMember,
  deleteSplit,
  findOrCreateGoogleUser,
  findOrCreatePhoneUser,
  findUserByEmail,
  findUserById,
  getSplits,
  initializeDatabase,
  loadGroup,
  pool,
  saveExpense,
  setActiveSplit
};
