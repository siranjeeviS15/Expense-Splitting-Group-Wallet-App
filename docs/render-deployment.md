# Deploy to Render

This project uses a single Render Node web service for both the frontend and API. The `render.yaml` Blueprint also provisions PostgreSQL and injects its private connection string into the service as `DATABASE_URL`.

## Deploy

1. Push this project, including `render.yaml`, to a GitHub repository you can access.
2. In Render, choose **New + → Blueprint** and connect that repository.
3. Review the Blueprint resources and create them. Render builds the app with `npm ci`, starts it with `npm start`, and checks `/health`.
4. Open the generated web-service URL. The frontend and backend are served from the same origin.

The production service sets `REQUIRE_DATABASE=true`: if PostgreSQL cannot be initialized, startup fails instead of silently switching to temporary local-file storage.

The Blueprint generates a `SESSION_SECRET`. To enable optional Google sign-in:

1. Create a Google OAuth client with the web application type.
2. Add `https://<your-render-service>.onrender.com/auth/google/callback` as an authorized redirect URI.
3. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the Render service environment and redeploy.

Email/password registration works without Google credentials. Passwords are stored as salted scrypt hashes, and authenticated sessions are stored in PostgreSQL. Email verification and password recovery are not configured.

To enable phone OTP sign-in, create a Twilio Verify Service and add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID` as secrets in the Render web service environment, then redeploy. The phone sign-in button is shown only when all three values are present. The app accepts E.164 phone numbers (for example, `+14155552671`). A verified number without an existing phone account creates a separate phone-only account; it is not automatically linked to an email or Google account.

## Data and plan notes

New PostgreSQL deployments start with a blank split. Existing local `data.json` is not uploaded or automatically imported; export and migrate any data you need separately before relying on the cloud app.

The Blueprint uses Render's free plans to make initial setup straightforward. Check Render's current plan limits, database expiry, and backup policy before storing important data. Upgrade the database plan and configure backups as appropriate for ongoing use.

## Configuration

The Blueprint creates:

- `expense-splitting-group-wallet`: Node web service, frontend and API together.
- `expense-splitting-group-wallet-db`: PostgreSQL database.

The database's `connectionString` is mapped to `DATABASE_URL`; no credentials need to be committed to Git.
