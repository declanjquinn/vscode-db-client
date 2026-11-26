# DB Client

A small MySQL and PostgreSQL client for VS Code, laid out like MySQL Workbench.

| Workbench | Here |
|---|---|
| Navigator / Schemas | **DB Client** icon in the activity bar → *Schemas* tree |
| Object Info | *Object Info* view under the tree (select a table) |
| SQL editor toolbar | Buttons at the top right of any `.sql` editor: ⚡ Execute, ▶ Execute Current Statement, ■ Stop |
| Result Grid, Action Output | **DB Client** tab in the bottom panel |
| Limit to 1000 rows | `dbClient.rowLimit` setting, or *Set Row Limit* in the editor's `…` menu |

- `Ctrl+Shift+Enter` runs the selection, or the whole file. `Ctrl+Enter` runs the statement under the cursor.
- The status bar shows the active connection and default schema. Click it to switch. Right-click a schema → *Set as Default Schema*.
- A result is editable when it is a plain `SELECT` from one table and includes that table's primary key. Double-click a cell (or `F2`), then **Apply**. Changes are shown for confirmation and run in one transaction, which is rolled back unless every statement changes exactly one row.
- Passwords are kept in VS Code's secret storage, not in settings.

## Develop

```bash
npm install
npm run build        # bundle to dist/extension.js
npm run check        # type-check
npm test             # unit tests
docker compose up -d # throwaway MySQL (127.0.0.1:33306, root/test) and PostgreSQL (127.0.0.1:55432, postgres/test, database shop)
npm run test:db      # driver tests against those databases
```

Press `F5` in VS Code to open a window with the extension loaded.

## Not supported yet

SSH tunnels, `DELIMITER` scripts, stored procedures/functions in the tree, autocomplete from the schema, custom SSL certificates (SSL always verifies the server certificate).
