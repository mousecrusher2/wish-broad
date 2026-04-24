import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(repoRoot, "schema.sql");
const migrationsDir = join(repoRoot, "migrations");

function runSqlite(args, options = {}) {
  const result = spawnSync("sqlite3", args, {
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `sqlite3 ${args.join(" ")} failed with status ${String(result.status)}`,
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

function applySql(databasePath, sql, label) {
  try {
    runSqlite([databasePath], {
      input: [".bail on", sql, ""].join("\n"),
    });
  } catch (error) {
    throw new Error(`Failed to apply ${label}: ${error.message}`, {
      cause: error,
    });
  }
}

function queryJson(databasePath, sql) {
  const output = runSqlite(["-json", databasePath, sql]);
  return output.trim().length === 0 ? [] : JSON.parse(output);
}

function quoteSqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizeType(type) {
  return type.trim().replaceAll(/\s+/gu, " ").toUpperCase();
}

function normalizeDefaultValue(value) {
  return typeof value === "string" ? value.trim() : null;
}

function normalizeSchemaSql(sql) {
  return sql.trim().replaceAll(/\s+/gu, " ");
}

function inspectIndexes(databasePath, tableName) {
  const indexes = queryJson(
    databasePath,
    `PRAGMA index_list(${quoteSqlString(tableName)});`,
  );

  return indexes
    .map((index) => {
      const columns = queryJson(
        databasePath,
        `PRAGMA index_xinfo(${quoteSqlString(index.name)});`,
      )
        .filter((column) => column.key === 1)
        .sort((a, b) => a.seqno - b.seqno)
        .map((column) => ({
          coll: column.coll ?? null,
          desc: Number(column.desc),
          name: column.name,
        }));

      return {
        columns,
        name: String(index.name).startsWith("sqlite_autoindex_")
          ? null
          : index.name,
        origin: index.origin,
        partial: Number(index.partial),
        unique: Number(index.unique),
      };
    })
    .sort((a, b) => {
      return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });
}

function inspectTable(databasePath, table) {
  const columns = queryJson(
    databasePath,
    `PRAGMA table_xinfo(${quoteSqlString(table.name)});`,
  ).map((column) => ({
    defaultValue: normalizeDefaultValue(column.dflt_value),
    hidden: Number(column.hidden),
    name: column.name,
    notNull: Number(column.notnull),
    primaryKeyPosition: Number(column.pk),
    type: normalizeType(column.type),
  }));

  const foreignKeys = queryJson(
    databasePath,
    `PRAGMA foreign_key_list(${quoteSqlString(table.name)});`,
  ).map((foreignKey) => ({
    from: foreignKey.from,
    id: Number(foreignKey.id),
    match: foreignKey.match,
    onDelete: foreignKey.on_delete,
    onUpdate: foreignKey.on_update,
    seq: Number(foreignKey.seq),
    table: foreignKey.table,
    to: foreignKey.to,
  }));

  return {
    columns,
    foreignKeys,
    indexes: inspectIndexes(databasePath, table.name),
    name: table.name,
    strict: /\bSTRICT\b/iu.test(table.sql),
    withoutRowid: /WITHOUT\s+ROWID/iu.test(table.sql),
  };
}

function inspectDatabase(databasePath) {
  const tables = queryJson(
    databasePath,
    [
      "SELECT name, sql",
      "FROM sqlite_schema",
      "WHERE type = 'table'",
      "AND name NOT LIKE 'sqlite_%'",
      "ORDER BY name",
    ].join(" "),
  ).map((table) => inspectTable(databasePath, table));

  const schemaObjects = queryJson(
    databasePath,
    [
      "SELECT type, name, tbl_name, sql",
      "FROM sqlite_schema",
      "WHERE type IN ('trigger', 'view')",
      "AND sql IS NOT NULL",
      "ORDER BY type, name",
    ].join(" "),
  ).map((object) => ({
    name: object.name,
    sql: normalizeSchemaSql(object.sql),
    tableName: object.tbl_name,
    type: object.type,
  }));

  return {
    schemaObjects,
    tables,
  };
}

function formatSchema(schema) {
  return JSON.stringify(schema, null, 2);
}

function findFirstDifference(leftText, rightText) {
  const leftLines = leftText.split("\n");
  const rightLines = rightText.split("\n");
  const lineCount = Math.max(leftLines.length, rightLines.length);

  for (let index = 0; index < lineCount; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return {
        actual: rightLines[index] ?? "<missing>",
        expected: leftLines[index] ?? "<missing>",
        line: index + 1,
      };
    }
  }

  return null;
}

function assertSqliteAvailable() {
  try {
    runSqlite(["-version"]);
  } catch (error) {
    throw new Error(
      `sqlite3 CLI is required for schema checks: ${error.message}`,
      { cause: error },
    );
  }
}

function main() {
  assertSqliteAvailable();

  const tempDir = mkdtempSync(join(tmpdir(), "wish-broad-schema-check-"));
  const schemaDatabasePath = join(tempDir, "schema.sqlite");
  const migrationsDatabasePath = join(tempDir, "migrations.sqlite");

  try {
    applySql(
      schemaDatabasePath,
      readFileSync(schemaPath, "utf8"),
      "schema.sql",
    );

    const migrationFiles = readdirSync(migrationsDir)
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

    for (const migrationFile of migrationFiles) {
      applySql(
        migrationsDatabasePath,
        readFileSync(join(migrationsDir, migrationFile), "utf8"),
        `migrations/${migrationFile}`,
      );
    }

    const expectedSchema = formatSchema(inspectDatabase(schemaDatabasePath));
    const actualSchema = formatSchema(inspectDatabase(migrationsDatabasePath));

    if (expectedSchema !== actualSchema) {
      const firstDifference = findFirstDifference(expectedSchema, actualSchema);
      console.error("Migration replay schema does not match schema.sql.");
      console.error(
        "This check compares schema shape only; it does not prove data migration correctness.",
      );
      if (firstDifference) {
        console.error(
          `First difference at line ${String(firstDifference.line)}:`,
        );
        console.error(`  schema.sql:  ${firstDifference.expected}`);
        console.error(`  migrations:  ${firstDifference.actual}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(
      `schema.sql matches replayed migrations (${String(migrationFiles.length)} files).`,
    );
    console.log(
      "Schema-only check passed; data migration correctness is not verified.",
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
