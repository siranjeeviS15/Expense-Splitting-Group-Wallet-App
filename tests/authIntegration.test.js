const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dataFile = path.join(os.tmpdir(), `expense-login-${randomUUID()}.json`);
process.env.GROUP_WALLET_DATA_FILE = dataFile;
delete process.env.DATABASE_URL;

const { app } = require('../server');
const { initializeDatabase } = require('../src/database');

let server;
let baseUrl;

async function request(url, options = {}, session = {}) {
  const headers = new Headers(options.headers || {});
  if (session.cookie) headers.set('Cookie', session.cookie);
  const response = await fetch(`${baseUrl}${url}`, { ...options, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) session.cookie = setCookie.split(';', 1)[0];
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function startSession() {
  const session = {};
  const { body } = await request('/api/auth/me', {}, session);
  return { session, csrfToken: body.csrfToken };
}

async function register(session, csrfToken, email) {
  return request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ email, password: 'correct-horse-battery' })
  }, session);
}

before(async () => {
  await initializeDatabase();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
});

test('registration, CSRF, login/logout, and split privacy work over HTTP', async () => {
  const accountA = await startSession();
  const csrfRejected = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@example.com', password: 'correct-horse-battery' })
  }, accountA.session);
  assert.equal(csrfRejected.response.status, 403);

  const registeredA = await register(accountA.session, accountA.csrfToken, 'a@example.com');
  assert.equal(registeredA.response.status, 201);
  assert.equal(registeredA.body.user.email, 'a@example.com');
  assert.equal('passwordHash' in registeredA.body.user, false);
  accountA.csrfToken = registeredA.body.csrfToken;

  const duplicate = await register(accountA.session, accountA.csrfToken, 'a@example.com');
  assert.equal(duplicate.response.status, 409);

  const createdSplit = await request('/api/splits', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': accountA.csrfToken
    },
    body: JSON.stringify({ name: 'Private account A split' })
  }, accountA.session);
  assert.equal(createdSplit.response.status, 201);
  const privateSplitId = createdSplit.body.activeSplitId;

  const addedMember = await request('/api/members', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': accountA.csrfToken
    },
    body: JSON.stringify({ name: 'Alice' })
  }, accountA.session);
  assert.equal(addedMember.response.status, 201);
  assert.deepEqual(addedMember.body, ['Alice']);

  const accountB = await startSession();
  const registeredB = await register(accountB.session, accountB.csrfToken, 'b@example.com');
  assert.equal(registeredB.response.status, 201);
  accountB.csrfToken = registeredB.body.csrfToken;

  const splitsB = await request('/api/splits', {}, accountB.session);
  assert.equal(splitsB.response.status, 200);
  assert.equal(splitsB.body.splits.some((split) => split.name === 'Private account A split'), false);

  const foreignSplit = await request(`/api/splits/${privateSplitId}/activate`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': accountB.csrfToken }
  }, accountB.session);
  assert.equal(foreignSplit.response.status, 404);

  const logout = await request('/api/auth/logout', {
    method: 'POST',
    headers: { 'X-CSRF-Token': accountB.csrfToken }
  }, accountB.session);
  assert.equal(logout.response.status, 204);
  const protectedAfterLogout = await request('/api/splits', {}, accountB.session);
  assert.equal(protectedAfterLogout.response.status, 401);

  const loginSession = await startSession();
  const invalidLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': loginSession.csrfToken
    },
    body: JSON.stringify({ email: 'b@example.com', password: 'incorrect-password' })
  }, loginSession.session);
  assert.equal(invalidLogin.response.status, 401);

  const validLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': loginSession.csrfToken
    },
    body: JSON.stringify({ email: 'b@example.com', password: 'correct-horse-battery' })
  }, loginSession.session);
  assert.equal(validLogin.response.status, 200);
  assert.equal(validLogin.body.authenticated, true);
  const signedInSplits = await request('/api/splits', {}, loginSession.session);
  assert.equal(signedInSplits.response.status, 200);
  assert.equal(signedInSplits.body.splits.some((split) => split.name === 'Private account A split'), false);
});
