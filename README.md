# Expense Splitter

A small web app for managing saved expense splits, members, shared expenses, balances, settlements, and CSV exports.

## Run locally

Requirements: Node.js and npm.

```sh
npm install
npm start
```

Open <http://localhost:3000>. The app starts with a blank split and stores local data in `data.json`. That file is intentionally ignored by Git because it contains personal split information.

To use PostgreSQL instead, set `DATABASE_URL` to a PostgreSQL connection string before starting the app. The app creates its tables on startup and falls back to local JSON storage if PostgreSQL is unavailable.

## Features

- Create, name, switch between, and delete saved splits.
- Add and remove members.
- Record expenses and choose which members share each expense.
- View balances and suggested settlements.
- Delete expenses and export the selected split as CSV.

## Tests

```sh
npm test
```
