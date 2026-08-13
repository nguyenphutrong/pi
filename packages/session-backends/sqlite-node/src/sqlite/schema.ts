import { sql } from "./sql.ts";
import type { SqliteDatabase } from "./types.ts";

export const SQLITE_SCHEMA_VERSION = 1;

export const SQLITE_SCHEMA_TABLES = [
	"branch_entries",
	"branch_meta",
	"entries",
	"registers",
	"session_sequences",
	"session_stats",
	"sessions",
	"usage_ledger",
	"writer_leases",
] as const;

export const SQLITE_SCHEMA_INDEXES = [
	"ix_be_entry",
	"ix_be_seq",
	"ix_be_type",
	"ix_bm_tip",
	"ix_entry_parent",
	"ix_entry_seq",
	"ix_usage_seq",
] as const;

export const SQLITE_SCHEMA_TRIGGERS = ["entries_id_not_usage", "usage_id_not_entry"] as const;

const SCHEMA = `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  parent_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  storage_version INTEGER NOT NULL CHECK(storage_version = 1),
  metadata TEXT CHECK(metadata IS NULL OR json_valid(metadata))
) WITHOUT ROWID;

CREATE TABLE session_sequences (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  next_seq INTEGER NOT NULL CHECK(next_seq BETWEEN 1 AND 9007199254740991)
) WITHOUT ROWID;

CREATE TABLE entries (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 9007199254740991),
  parent_id TEXT,
  timestamp INTEGER NOT NULL CHECK(timestamp BETWEEN 0 AND 9007199254740991),
  type TEXT NOT NULL CHECK(type IN ('message', 'compaction', 'branch_summary', 'custom')),
  custom_type TEXT,
  payload TEXT,
  PRIMARY KEY(session_id, id),
  UNIQUE(session_id, seq),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY(session_id, parent_id) REFERENCES entries(session_id, id),
  CHECK((type = 'custom' AND custom_type IS NOT NULL AND length(custom_type) > 0 AND instr(custom_type, char(0)) = 0)
     OR (type <> 'custom' AND custom_type IS NULL)),
  CHECK((type = 'custom') OR payload IS NOT NULL),
  CHECK(payload IS NULL OR json_valid(payload))
) WITHOUT ROWID;
CREATE INDEX ix_entry_parent ON entries(session_id, parent_id);
CREATE INDEX ix_entry_seq ON entries(session_id, seq, type);

CREATE TABLE registers (
  session_id TEXT NOT NULL,
  namespace TEXT NOT NULL CHECK(length(namespace) > 0 AND instr(namespace, char(0)) = 0),
  key TEXT NOT NULL CHECK(instr(key, char(0)) = 0),
  value TEXT NOT NULL CHECK(json_valid(value)),
  seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(session_id, namespace, key),
  UNIQUE(session_id, seq),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE usage_ledger (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 9007199254740991),
  entry_id TEXT,
  usage TEXT NOT NULL CHECK(json_valid(usage)),
  adjustment INTEGER NOT NULL CHECK(adjustment IN (0, 1)),
  details TEXT CHECK(details IS NULL OR json_valid(details)),
  PRIMARY KEY(session_id, id),
  UNIQUE(session_id, seq),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY(session_id, entry_id) REFERENCES entries(session_id, id)
) WITHOUT ROWID;
CREATE INDEX ix_usage_seq ON usage_ledger(session_id, seq);

CREATE TABLE session_stats (
  session_id TEXT PRIMARY KEY,
  message_count INTEGER NOT NULL CHECK(message_count BETWEEN 0 AND 9007199254740991),
  usage_payload TEXT NOT NULL CHECK(json_valid(usage_payload)),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE writer_leases (
  session_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL CHECK(length(owner_id) > 0),
  fence INTEGER NOT NULL CHECK(fence BETWEEN 1 AND 9007199254740991),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE branch_meta (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  tip_entry_id TEXT NOT NULL,
  tip_seq INTEGER NOT NULL CHECK(tip_seq BETWEEN 1 AND 9007199254740991),
  base_branch_id TEXT,
  base_seq INTEGER,
  PRIMARY KEY(session_id, branch_id),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY(session_id, tip_entry_id) REFERENCES entries(session_id, id),
  FOREIGN KEY(session_id, base_branch_id) REFERENCES branch_meta(session_id, branch_id),
  CHECK((base_branch_id IS NULL) = (base_seq IS NULL)),
  CHECK(base_seq IS NULL OR (base_seq BETWEEN 1 AND 9007199254740991 AND base_seq <= tip_seq))
) WITHOUT ROWID;
CREATE UNIQUE INDEX ix_bm_tip ON branch_meta(session_id, tip_entry_id);

CREATE TABLE branch_entries (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  entry_seq INTEGER NOT NULL CHECK(entry_seq BETWEEN 1 AND 9007199254740991),
  entry_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('message', 'compaction', 'branch_summary', 'custom')),
  PRIMARY KEY(session_id, branch_id, entry_id),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY(session_id, branch_id) REFERENCES branch_meta(session_id, branch_id),
  FOREIGN KEY(session_id, entry_id) REFERENCES entries(session_id, id)
) WITHOUT ROWID;
CREATE INDEX ix_be_seq ON branch_entries(session_id, branch_id, entry_seq, entry_id, entry_type);
CREATE INDEX ix_be_type ON branch_entries(session_id, branch_id, entry_type, entry_seq, entry_id);
CREATE INDEX ix_be_entry ON branch_entries(session_id, entry_id);

CREATE TRIGGER entries_id_not_usage BEFORE INSERT ON entries
WHEN EXISTS (SELECT 1 FROM usage_ledger WHERE session_id = NEW.session_id AND id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'durable id already used by usage'); END;
CREATE TRIGGER usage_id_not_entry BEFORE INSERT ON usage_ledger
WHEN EXISTS (SELECT 1 FROM entries WHERE session_id = NEW.session_id AND id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'durable id already used by entry'); END;
`;

type SchemaObjectType = "table" | "index" | "trigger";

function normalizeDefinition(definition: string): string {
	return definition.replace(/;\s*$/, "").replace(/\s+/g, " ").trim();
}

function canonicalDefinition(type: SchemaObjectType, name: string): string {
	const markers =
		type === "index"
			? [`CREATE INDEX ${name}`, `CREATE UNIQUE INDEX ${name}`]
			: [`CREATE ${type.toUpperCase()} ${name}`];
	const start = markers.reduce((found, marker) => (found === -1 ? SCHEMA.indexOf(marker) : found), -1);
	if (start === -1) throw new Error(`Missing canonical SQLite ${type} definition: ${name}`);
	const terminator = type === "trigger" ? "END;" : ";";
	const end = SCHEMA.indexOf(terminator, start);
	if (end === -1) throw new Error(`Incomplete canonical SQLite ${type} definition: ${name}`);
	return normalizeDefinition(SCHEMA.slice(start, end + terminator.length));
}

const SCHEMA_DEFINITIONS = new Map<string, string>([
	...SQLITE_SCHEMA_TABLES.map((name) => [`table:${name}`, canonicalDefinition("table", name)] as const),
	...SQLITE_SCHEMA_INDEXES.map((name) => [`index:${name}`, canonicalDefinition("index", name)] as const),
	...SQLITE_SCHEMA_TRIGGERS.map((name) => [`trigger:${name}`, canonicalDefinition("trigger", name)] as const),
]);

function inventory(db: SqliteDatabase, type: "table" | "index" | "trigger"): string[] {
	return sql`SELECT name FROM sqlite_schema WHERE type = ${type} AND name NOT LIKE 'sqlite_%' ORDER BY name`
		.all<{ name: string }>(db)
		.map((row) => row.name);
}

function assertInventory(db: SqliteDatabase): void {
	for (const [type, expected] of [
		["table", SQLITE_SCHEMA_TABLES],
		["index", SQLITE_SCHEMA_INDEXES],
		["trigger", SQLITE_SCHEMA_TRIGGERS],
	] as const) {
		const actual = inventory(db, type);
		if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
			throw new Error(`Unsupported SQLite ${type} inventory: ${actual.join(", ")}`);
		}
	}
	const objects =
		sql`SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`.all<{
			type: string;
			name: string;
			sql: string | null;
		}>(db);
	const expectedCount = SQLITE_SCHEMA_TABLES.length + SQLITE_SCHEMA_INDEXES.length + SQLITE_SCHEMA_TRIGGERS.length;
	if (objects.length !== expectedCount) {
		throw new Error(
			`Unsupported SQLite schema object inventory: ${objects.map(({ type, name }) => `${type}:${name}`).join(", ")}`,
		);
	}
	for (const object of objects) {
		if (
			object.sql === null ||
			normalizeDefinition(object.sql) !== SCHEMA_DEFINITIONS.get(`${object.type}:${object.name}`)
		) {
			throw new Error(`Unsupported SQLite ${object.type} definition: ${object.name}`);
		}
	}
}

/** Configures and initializes a new database, or validates an existing version-one database. */
export function initializeSqliteSchema(db: SqliteDatabase): void {
	db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
	const version = sql`PRAGMA user_version`.get<{ user_version: number }>(db)?.user_version;
	if (version === undefined) throw new Error("Unable to read SQLite user_version");
	if (version === 0) {
		const objects = sql`SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1`.all<{ name: string }>(
			db,
		);
		if (objects.length > 0) throw new Error("Unsupported non-empty legacy SQLite database at user_version 0");
		db.transaction(() => {
			db.exec(SCHEMA);
			db.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION}`);
		});
	} else if (version !== SQLITE_SCHEMA_VERSION) {
		throw new Error(`Unsupported SQLite schema version ${version}`);
	}
	assertInventory(db);
}
