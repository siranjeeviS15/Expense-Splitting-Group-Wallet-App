# Deploy to Render

This project uses a single Render Node web service for both the frontend and API. The `render.yaml` Blueprint also provisions PostgreSQL and injects its private connection string into the service as `DATABASE_URL`.

## Deploy

1. Push this project, including `render.yaml`, to a GitHub repository you can access.
2. In Render, choose **New + → Blueprint** and connect that repository.
3. Review the Blueprint resources and create them. Render builds the app with `npm ci`, starts it with `npm start`, and checks `/health`.
4. Open the generated web-service URL. The frontend and backend are served from the same origin.

The production service sets `REQUIRE_DATABASE=true`: if PostgreSQL cannot be initialized, startup fails instead of silently switching to temporary local-file storage.

## Data and plan notes

New PostgreSQL deployments start with a blank split. Existing local `data.json` is not uploaded or automatically imported; export and migrate any data you need separately before relying on the cloud app.

The Blueprint uses Render's free plans to make initial setup straightforward. Check Render's current plan limits, database expiry, and backup policy before storing important data. Upgrade the database plan and configure backups as appropriate for ongoing use.

## Configuration

The Blueprint creates:

- `expense-splitting-group-wallet`: Node web service, frontend and API together.
- `expense-splitting-group-wallet-db`: PostgreSQL database.

The database's `connectionString` is mapped to `DATABASE_URL`; no credentials need to be committed to Git.
