const express = require('express');
const path = require('path');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { rateLimit } = require('express-rate-limit');
const { randomBytes, timingSafeEqual } = require('crypto');
const { addExpense, calculateBalances } = require('./src/expenseService');
const {
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
} = require('./src/database');
const { hashPassword, validateEmail, verifyPassword } = require('./src/authService');
const { checkVerification, sendVerification, validatePhoneNumber } = require('./src/twilioVerify');

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
let databaseReady = false;
let googleEnabled = false;
const phoneEnabled = Boolean(
  process.env.TWILIO_ACCOUNT_SID
  && process.env.TWILIO_AUTH_TOKEN
  && process.env.TWILIO_VERIFY_SERVICE_SID
);

if (isProduction) {
  app.set('trust proxy', 1);
}

const sessionSecret = process.env.SESSION_SECRET || (
  isProduction ? null : randomBytes(32).toString('hex')
);
if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be configured in production.');
}

app.use(express.json({ limit: '32kb' }));
app.use(session({
  name: 'expense.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: pool
    ? new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: true
    })
    : undefined,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await findUserById(id);
    done(null, user || false);
  } catch (error) {
    done(error);
  }
});

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (googleClientId && googleClientSecret) {
  const callbackUrl = process.env.GOOGLE_CALLBACK_URL
    || `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`}/auth/google/callback`;
  passport.use(new GoogleStrategy({
    clientID: googleClientId,
    clientSecret: googleClientSecret,
    callbackURL: callbackUrl,
    state: true
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const emailEntry = profile.emails?.find((entry) => entry.value);
      const verified = profile._json?.email_verified === true;
      if (!emailEntry || !verified) {
        return done(null, false, { message: 'Google must provide a verified email address.' });
      }
      const user = await findOrCreateGoogleUser(emailEntry.value, profile.id);
      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }));
  googleEnabled = true;
} else if (googleClientId || googleClientSecret) {
  console.warn('Google sign-in is disabled until both OAuth credentials are configured.');
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again later.' }
});

const phoneSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many code requests. Please try again later.' }
});

const phoneVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' }
});

function getCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('base64url');
  }
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  const expected = req.session?.csrfToken;
  const supplied = req.get('X-CSRF-Token');
  if (!expected || !supplied) {
    return res.status(403).json({ error: 'Security token missing. Refresh and try again.' });
  }
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length
      || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(403).json({ error: 'Security token expired. Refresh and try again.' });
  }
  return next();
}

function requireAuthentication(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Please sign in to continue.' });
  }
  return next();
}

function loginUser(req, user) {
  return new Promise((resolve, reject) => {
    req.login(user, (error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

function authErrorStatus(error) {
  if (error.code === 'USER_EXISTS') return 409;
  if (error.code === 'ACCOUNT_LINK_REQUIRED') return 409;
  if (error.message === 'Enter a valid email address.'
      || error.message.startsWith('Password')) return 400;
  return 500;
}

app.get('/health', (req, res) => {
  res.status(databaseReady ? 200 : 503).json({
    status: databaseReady ? 'ok' : 'starting'
  });
});

app.get('/api/auth/me', (req, res) => {
  res.json({
    authenticated: Boolean(req.user),
    user: req.user
      ? { id: req.user.id, email: req.user.email, phone: req.user.phone || null }
      : null,
    csrfToken: getCsrfToken(req),
    googleEnabled,
    phoneEnabled
  });
});

app.post('/api/auth/register', authLimiter, requireCsrf, async (req, res) => {
  try {
    const email = validateEmail(req.body.email);
    const passwordHash = await hashPassword(req.body.password);
    const user = await createUser(email, passwordHash);
    await loginUser(req, user);
    req.session.csrfToken = randomBytes(32).toString('base64url');
    res.status(201).json({
      authenticated: true,
      user,
      csrfToken: req.session.csrfToken
    });
  } catch (error) {
    const status = authErrorStatus(error);
    if (status >= 500) console.error('Account registration failed:', error.message);
    res.status(status).json({
      error: status === 500 ? 'Unable to create your account right now.' : error.message
    });
  }
});

app.post('/api/auth/login', authLimiter, requireCsrf, async (req, res) => {
  try {
    const email = validateEmail(req.body.email);
    const user = await findUserByEmail(email);
    const valid = user?.passwordHash
      ? await verifyPassword(req.body.password, user.passwordHash)
      : false;
    if (!valid) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const publicUser = { id: user.id, email: user.email };
    await loginUser(req, publicUser);
    req.session.csrfToken = randomBytes(32).toString('base64url');
    return res.json({
      authenticated: true,
      user: publicUser,
      csrfToken: req.session.csrfToken
    });
  } catch (error) {
    const status = authErrorStatus(error);
    if (status >= 500) console.error('Sign-in failed:', error.message);
    return res.status(status).json({
      error: status === 500 ? 'Unable to sign in right now.' : error.message
    });
  }
});

app.post('/api/auth/phone/send', phoneSendLimiter, requireCsrf, async (req, res) => {
  try {
    const phone = validatePhoneNumber(req.body.phone);
    await sendVerification(phone);
    return res.json({ sent: true });
  } catch (error) {
    if (error.code === 'INVALID_PHONE') {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === 'TWILIO_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Phone sign-in is not configured.' });
    }
    console.error('Phone verification request failed:', error.code || 'PROVIDER_ERROR');
    return res.status(502).json({ error: 'Could not send a verification code. Please try again later.' });
  }
});

app.post('/api/auth/phone/verify', phoneVerifyLimiter, requireCsrf, async (req, res) => {
  try {
    const phone = validatePhoneNumber(req.body.phone);
    const approved = await checkVerification(phone, req.body.code);
    if (!approved) {
      return res.status(401).json({ error: 'The verification code is incorrect or expired.' });
    }
    const user = await findOrCreatePhoneUser(phone);
    await loginUser(req, user);
    req.session.csrfToken = randomBytes(32).toString('base64url');
    return res.json({
      authenticated: true,
      user,
      csrfToken: req.session.csrfToken
    });
  } catch (error) {
    if (error.code === 'INVALID_PHONE' || error.code === 'INVALID_OTP') {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === 'TWILIO_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Phone sign-in is not configured.' });
    }
    if (error.code === 'TWILIO_REJECTED' && [400, 404].includes(error.providerStatus)) {
      return res.status(401).json({ error: 'The verification code is incorrect or expired.' });
    }
    console.error('Phone verification failed:', error.code || 'PROVIDER_ERROR');
    return res.status(502).json({ error: 'Could not verify this code. Please try again later.' });
  }
});

app.post('/api/auth/logout', requireCsrf, (req, res, next) => {
  req.logout((logoutError) => {
    if (logoutError) return next(logoutError);
    req.session.destroy((sessionError) => {
      if (sessionError) return next(sessionError);
      res.clearCookie('expense.sid', {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax'
      });
      return res.status(204).end();
    });
  });
});

if (googleEnabled) {
  app.get('/auth/google', passport.authenticate('google', {
    scope: ['email', 'profile']
  }));
  app.get('/auth/google/callback', passport.authenticate('google', {
    failureRedirect: '/?authError=google'
  }), (req, res) => {
    req.session.csrfToken = randomBytes(32).toString('base64url');
    res.redirect('/');
  });
}

const api = express.Router();
api.use(requireAuthentication);

async function currentGroup(req) {
  const splitList = await getSplits(req.user.id, req.session.activeSplitId);
  req.session.activeSplitId = splitList.activeSplitId;
  return loadGroup(splitList.activeSplitId, req.user.id);
}

api.get('/group', async (req, res) => {
  try {
    res.json(await currentGroup(req));
  } catch (error) {
    res.status(500).json({ error: 'Unable to load this split.' });
  }
});

api.get('/splits', async (req, res) => {
  try {
    const splits = await getSplits(req.user.id, req.session.activeSplitId);
    req.session.activeSplitId = splits.activeSplitId;
    res.json(splits);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load saved splits.' });
  }
});

api.post('/splits', requireCsrf, async (req, res) => {
  try {
    const split = await createSplit(req.body.name, req.user.id);
    req.session.activeSplitId = split.id;
    res.status(201).json(await getSplits(req.user.id, split.id));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

api.post('/splits/:id/activate', requireCsrf, async (req, res) => {
  try {
    const split = await setActiveSplit(req.params.id, req.user.id);
    req.session.activeSplitId = split.id;
    res.json(await getSplits(req.user.id, split.id));
  } catch (error) {
    res.status(404).json({ error: 'Split not found.' });
  }
});

api.delete('/splits/:id', requireCsrf, async (req, res) => {
  try {
    const result = await deleteSplit(req.params.id, req.user.id);
    req.session.activeSplitId = result.activeSplitId;
    res.json(await getSplits(req.user.id, result.activeSplitId));
  } catch (error) {
    res.status(error.message === 'Split not found' ? 404 : 500).json({
      error: error.message === 'Split not found' ? error.message : 'Unable to delete split.'
    });
  }
});

api.post('/expenses', requireCsrf, async (req, res) => {
  try {
    const group = await currentGroup(req);
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
    if (!canonicalPayer) throw new Error('Payer must be a member of this split');
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
    await saveExpense(expense, group.id, req.user.id);
    const updatedGroup = await loadGroup(group.id, req.user.id);
    res.status(201).json(updatedGroup.expenses[updatedGroup.expenses.length - 1]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

api.post('/members', requireCsrf, async (req, res) => {
  try {
    const group = await currentGroup(req);
    if (!req.body.name || !req.body.name.trim()) throw new Error('Member name is required');
    await addMember(req.body.name.trim(), group.id, req.user.id);
    res.status(201).json((await loadGroup(group.id, req.user.id)).members);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

api.delete('/members/:name', requireCsrf, async (req, res) => {
  try {
    const group = await currentGroup(req);
    await deleteMember(req.params.name, group.id, req.user.id);
    res.json((await loadGroup(group.id, req.user.id)).members);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

api.delete('/expenses/:id', requireCsrf, async (req, res) => {
  try {
    const group = await currentGroup(req);
    await deleteExpense(req.params.id, group.id, req.user.id);
    res.json((await loadGroup(group.id, req.user.id)).expenses);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

api.get('/balances', async (req, res) => {
  try {
    res.json(calculateBalances(await currentGroup(req)));
  } catch (error) {
    res.status(500).json({ error: 'Unable to load balances.' });
  }
});

api.get('/summary', async (req, res) => {
  try {
    const group = await currentGroup(req);
    res.json({
      total_expenses: Number(group.expenses.reduce((total, expense) => total + expense.amount, 0).toFixed(2)),
      member_count: group.members.length,
      balances: calculateBalances(group)
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load the split summary.' });
  }
});

api.get('/settlements', async (req, res) => {
  try {
    const balances = calculateBalances(await currentGroup(req)).map((balance) => ({ ...balance }));
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
  } catch (error) {
    res.status(500).json({ error: 'Unable to calculate settlements.' });
  }
});

api.get('/export.csv', async (req, res) => {
  try {
    const group = await currentGroup(req);
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
  } catch (error) {
    res.status(500).json({ error: 'Unable to export this split.' });
  }
});

app.use('/api', api);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await initializeDatabase();
  databaseReady = true;
  app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Unable to start server:', error.message);
    process.exit(1);
  });
}

module.exports = { app, pool };
