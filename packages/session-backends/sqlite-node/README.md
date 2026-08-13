# @nguyenphutrong/pi-session-sqlite

Private Node.js SQLite backend for `@nguyenphutrong/pi-session-storage`. This initial
layer provides the `node:sqlite` adapter, parameterized SQL helper, synchronous
`BEGIN IMMEDIATE` transactions, and the canonical version-one schema initializer.

```ts
const db = await createNodeSqliteFactory().open(path);
initializeSqliteSchema(db);
```

The package is private and does not yet expose a Storage repository or lease behavior.
