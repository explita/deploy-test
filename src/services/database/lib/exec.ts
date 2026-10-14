import { run } from "../../../lib/runner.js";
import { database, postgres, mariadb } from "../../../lib/constants.js";
import {
  POSTGRES_CONTAINER_NAME,
  MARIADB_CONTAINER_NAME,
} from "@explita/protocol/deploy";

export async function execPostgres(
  sql: string,
  targetDb: string = postgres.name,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("docker", [
    "exec",
    "-e",
    `PGPASSWORD=${postgres.password || ""}`,
    POSTGRES_CONTAINER_NAME,
    "psql",
    "-U",
    postgres.user,
    "-p",
    String(postgres.port),
    "-d",
    targetDb,
    "-tAc",
    sql,
  ]);
}

export async function execMariaDb(
  sql: string,
  targetDb?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [
    "exec",
    "-i",
    MARIADB_CONTAINER_NAME,
    "mariadb",
    "-u",
    "root",
    `-p${mariadb.rootPassword}`,
    "--default-character-set=utf8mb4",
    "-sN",
  ];
  if (targetDb) {
    args.push(targetDb);
  }
  return run("docker", args, { stdin: sql });
}

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function quoteMysqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

export function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
