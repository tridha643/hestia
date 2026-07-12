import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * fsync the directory holding `path` so the preceding rename is itself durable.
 * A crash after `rename` but before the parent's metadata reaches disk can
 * otherwise resurrect the old name (or lose the file) even though the file
 * bytes were fsync'd — the classic atomic-write gap. Best-effort: some
 * platforms reject O_RDONLY dir fsync (EINVAL/EISDIR/EPERM), which is
 * harmless, so failures here are swallowed rather than failing the write.
 */
function fsyncDir(path: string): void {
  let fd: number;
  try {
    fd = openSync(dirname(path), "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Directory fsync unsupported on this fs — the rename already happened.
  } finally {
    closeSync(fd);
  }
}

/** Publish a JSON file atomically so readers observe either the old or complete new value. */
export function writeAtomicJsonFile(
  path: string,
  value: unknown,
  options: { mode?: number; pretty?: boolean } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const mode = options.mode ?? 0o600;
  const fd = openSync(temporaryPath, "wx", mode);
  try {
    writeFileSync(fd, JSON.stringify(value, null, options.pretty === false ? 0 : 2));
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  fsyncDir(path);
}

/** Atomically publish private UTF-8 text (TOML, YAML, or other generated config). */
export function writeAtomicTextFile(path: string, source: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporaryPath, "wx", mode);
  try {
    writeFileSync(fd, source);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  fsyncDir(path);
}
