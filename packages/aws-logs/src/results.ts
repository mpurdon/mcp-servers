import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";

/** One normalized log event, regardless of which API produced it. */
export interface LogEvent {
  timestamp: number;
  time: string;
  message: string;
  logGroup: string;
  logStream?: string;
  /** Insights @ptr — lets a follow-up GetLogRecord pull the full raw record. */
  ptr?: string;
  /** Extra projected fields from a queryOverride. */
  [key: string]: unknown;
}

export interface WriteResultsOutcome {
  path: string;
  events: number;
  bytes: number;
  truncated: boolean;
  /** Set when the configured directory was unusable and we fell back. */
  fallbackReason?: string;
}

/** Ceiling on a single result file so a runaway search cannot fill the disk. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

function slugify(input: string): string {
  return (
    input
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "search"
  );
}

async function ensureWritableDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // mkdir succeeding does not prove we can create files (read-only mount,
  // restrictive ACL), so probe with a real file.
  const probe = join(dir, `.probe-${randomBytes(4).toString("hex")}`);
  const handle = await open(probe, "w");
  await handle.close();
  await unlink(probe);
}

/**
 * Pick a usable output directory, degrading rather than failing: the configured
 * dir, then the OS temp dir. A search that found results should never be lost
 * because of a disk problem.
 */
async function selectOutputDir(
  preferred: string,
): Promise<{ dir: string; fallbackReason?: string }> {
  try {
    await ensureWritableDir(preferred);
    return { dir: preferred };
  } catch (err) {
    const reason = `${preferred} is not writable (${(err as Error).message})`;
    const fallback = join(tmpdir(), "aws-logs-mcp");
    try {
      await ensureWritableDir(fallback);
      return { dir: fallback, fallbackReason: reason };
    } catch (err2) {
      throw new Error(
        `${reason}; fallback ${fallback} also failed (${(err2 as Error).message}). ` +
          `Set "outputDir" in ~/.aws-logs-mcp/config.json to a writable path.`,
        { cause: err2 },
      );
    }
  }
}

/**
 * Stream events to NDJSON. NDJSON (not a JSON array) so the file stays valid
 * under truncation, can be appended incrementally, and is directly greppable
 * with jq/grep by whoever reads it next.
 */
export async function writeResults(
  outputDir: string,
  label: string,
  events: readonly LogEvent[],
): Promise<WriteResultsOutcome> {
  const { dir, fallbackReason } = await selectOutputDir(outputDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(
    dir,
    `${slugify(label)}-${stamp}-${randomBytes(3).toString("hex")}.ndjson`,
  );

  const stream = createWriteStream(path, { encoding: "utf8", mode: 0o600 });

  let bytes = 0;
  let written = 0;
  let truncated = false;

  try {
    for (const event of events) {
      const line = `${JSON.stringify(event)}\n`;
      const size = Buffer.byteLength(line, "utf8");
      if (bytes + size > MAX_FILE_BYTES) {
        truncated = true;
        break;
      }
      if (!stream.write(line)) {
        // Respect backpressure — a large result set can outrun the disk.
        await new Promise<void>((res, rej) => {
          stream.once("drain", res);
          stream.once("error", rej);
        });
      }
      bytes += size;
      written++;
    }

    await new Promise<void>((res, rej) => {
      stream.end((err?: Error | null) => (err ? rej(err) : res()));
      stream.once("error", rej);
    });
  } catch (err) {
    stream.destroy();
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOSPC") {
      throw new Error(
        `Ran out of disk space writing results to ${path}. Free space under ${dir} and retry.`,
        { cause: err },
      );
    }
    throw new Error(`Failed writing results to ${path}: ${e.message}`, {
      cause: err,
    });
  }

  return { path, events: written, bytes, truncated, fallbackReason };
}

export interface ReadResultsOptions {
  offset?: number;
  limit?: number;
  /** Case-insensitive substring applied to the serialized line. */
  contains?: string;
  /**
   * Dot paths to project, e.g. ["time", "message.message_type"]. Returning two
   * useful fields instead of a 1KB JSON blob per event is the difference
   * between reading 20 events and reading 500.
   */
  fields?: string[];
  /** Truncate each returned message to this many characters. */
  maxMessageChars?: number;
}

/** Resolve a dot path, transparently descending into a JSON-encoded `message`. */
function pluck(event: LogEvent, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = event;

  for (let i = 0; i < parts.length; i++) {
    if (current === null || current === undefined) return undefined;

    if (typeof current === "string") {
      // Allow "message.foo" to reach into a JSON log line.
      try {
        current = JSON.parse(current);
      } catch {
        return undefined;
      }
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[parts[i]];
  }
  return current;
}

export interface ReadResultsOutcome {
  path: string;
  totalMatched: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  events: LogEvent[];
}

/**
 * Page through a previously written result file without loading it all into
 * memory. Exists so hosts with no filesystem access can still consume results,
 * and so large files can be sliced server-side.
 */
export async function readResults(
  path: string,
  allowedDirs: readonly string[],
  opts: ReadResultsOptions = {},
): Promise<ReadResultsOutcome> {
  const abs = resolve(path);

  // Only ever read back files this server produced — this tool must not become
  // an arbitrary-file-read primitive for whatever is driving the model.
  const permitted = allowedDirs.some((dir) => {
    const base = resolve(dir);
    return abs === base || abs.startsWith(base + sep);
  });
  if (!permitted) {
    throw new Error(
      `Refusing to read ${abs}: outside this server's result directories (${allowedDirs.join(", ")}).`,
    );
  }
  if (!abs.endsWith(".ndjson")) {
    throw new Error(`Refusing to read ${abs}: not an .ndjson result file.`);
  }
  if (!existsSync(abs)) {
    throw new Error(
      `Result file ${abs} no longer exists. Files are pruned periodically and on restart — re-run the search.`,
    );
  }

  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const needle = opts.contains?.toLowerCase();

  const events: LogEvent[] = [];
  let matched = 0;

  const rl = createInterface({
    input: createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (line.trim() === "") continue;
      if (needle && !line.toLowerCase().includes(needle)) continue;

      const index = matched++;
      if (index < offset || events.length >= limit) continue;

      try {
        const parsed = JSON.parse(line) as LogEvent;

        if (opts.fields && opts.fields.length > 0) {
          const projected: Record<string, unknown> = {};
          for (const path of opts.fields) {
            const value = pluck(parsed, path);
            if (value !== undefined) projected[path] = value;
          }
          events.push(projected as unknown as LogEvent);
        } else if (
          opts.maxMessageChars &&
          parsed.message.length > opts.maxMessageChars
        ) {
          events.push({
            ...parsed,
            message: `${parsed.message.slice(0, opts.maxMessageChars)}…(+${parsed.message.length - opts.maxMessageChars})`,
          });
        } else {
          events.push(parsed);
        }
      } catch {
        // A truncated final line is possible if the process died mid-write.
        events.push({
          timestamp: 0,
          time: "",
          message: `[unparseable line ${index}]`,
          logGroup: "",
        });
      }
    }
  } finally {
    rl.close();
  }

  return {
    path: abs,
    totalMatched: matched,
    returned: events.length,
    offset,
    hasMore: offset + events.length < matched,
    events,
  };
}

/**
 * Best-effort prune of stale result files. Called at startup so /tmp does not
 * accumulate log dumps indefinitely; never throws.
 */
export async function pruneOldResults(
  dir: string,
  retentionHours: number,
): Promise<number> {
  if (retentionHours <= 0) return 0;
  const cutoff = Date.now() - retentionHours * 3_600_000;
  let removed = 0;

  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.endsWith(".ndjson")) continue;
      const full = join(dir, name);
      try {
        const info = await stat(full);
        if (info.mtimeMs < cutoff) {
          await unlink(full);
          removed++;
        }
      } catch {
        // Raced with another process, or permission denied — skip it.
      }
    }
  } catch {
    // Directory does not exist yet; nothing to prune.
  }

  return removed;
}
