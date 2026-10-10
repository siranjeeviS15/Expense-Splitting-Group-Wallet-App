# Expense Splitter

A small web app for managing saved expense splits, members, shared expenses, balances, settlements, and CSV exports.

## Run locally

Requirements: Node.js and npm.

```sh
npm install
npm start
```

Open <http://localhost:3000>, create an account with an email and password of at least 12 characters, use phone OTP after configuring Twilio Verify, or use Google sign-in after configuring OAuth credentials. Local development stores accounts and splits in `data.json`; that file is intentionally ignored by Git because it contains private information.

To use PostgreSQL instead, set `DATABASE_URL` to a PostgreSQL connection string and `SESSION_SECRET` to a long random secret before starting the app. The app creates its tables on startup and falls back to local JSON storage if PostgreSQL is unavailable outside production. Production requires PostgreSQL.

For Google sign-in, create a Google OAuth web client and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Add `http://localhost:3000/auth/google/callback` as an authorized redirect URI for local development. On Render, add `https://<your-service>.onrender.com/auth/google/callback` to the OAuth client and set the two credentials in the Render service environment.

For phone OTP, create a Twilio Verify Service, then set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID` in the local environment or Render service environment. Restart/redeploy the app after setting all three values. The phone sign-in option appears only when Twilio is configured. Enter phone numbers in international E.164 format, including the leading `+` and country code.

## Features

- Create, name, switch between, and delete saved splits.
- Add and remove members.
- Record expenses and choose which members share each expense.
- View balances and suggested settlements.
- Delete expenses and export the selected split as CSV.
- Register and sign in using email/password, or optionally Google OAuth.
- Show or hide the password while entering it, and optionally sign in with a Twilio SMS verification code.
- Keep each account's saved splits private from other accounts.

The first successful OTP sign-in creates a phone-only account if that phone number has not signed in before. Phone accounts are not automatically linked to existing email or Google accounts. Email verification and password recovery are not configured yet. Do not use this app as the only recovery method for an important account.

## Tests

```sh
npm test
```
