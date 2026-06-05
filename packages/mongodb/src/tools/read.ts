import { z } from "zod";
import type { Document, Sort } from "mongodb";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection.js";
import { textResult, errorResult, NonEmptyString } from "./environment.js";

const FilterSchema = z.record(z.unknown()).optional();
const ProjectionSchema = z
  .record(z.union([z.literal(0), z.literal(1), z.boolean()]))
  .optional();
const SortSchema = z.record(z.union([z.literal(1), z.literal(-1)])).optional();
const PipelineSchema = z.array(z.record(z.unknown()));

const DEFAULT_FIND_LIMIT = 20;
const MAX_FIND_LIMIT = 500;
const MAX_AGG_RESULTS = 500;
// Server-side time budget for every operation. Set below the MCP ~30s timeout
// so MongoDB aborts cleanly and we can return an errorResult instead of an
// unhandled rejection after the MCP layer has already given up.
const OP_MAX_TIME_MS = 25_000;

// Aggregation stages that write to the database. We block these in every
// environment because they bypass the write tools' confirmation guard.
const DISALLOWED_AGG_STAGES = ["$out", "$merge"] as const;

export function registerReadTools(
  server: McpServer,
  conn: ConnectionManager,
): void {
  server.tool(
    "list_databases",
    "List all databases on the active MongoDB connection.",
    {},
    async () => {
      try {
        const client = await conn.getClient();
        const admin = client.db().admin();
        const result = await admin.listDatabases();
        return textResult({
          env: conn.getActiveEnv(),
          databases: result.databases.map((d) => ({
            name: d.name,
            sizeOnDisk: d.sizeOnDisk,
            empty: d.empty,
          })),
        });
      } catch (err) {
        return errorResult(`list_databases failed: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "list_collections",
    "List all collections in a database.",
    { database: NonEmptyString },
    async ({ database }) => {
      try {
        const client = await conn.getClient();
        const cols = await client.db(database).listCollections().toArray();
        return textResult({
          env: conn.getActiveEnv(),
          database,
          collections: cols.map((c) => ({ name: c.name, type: c.type })),
        });
      } catch (err) {
        return errorResult(
          `list_collections failed: ${(err as Error).message}`,
        );
      }
    },
  );

  server.tool(
    "find",
    "Query documents. Defaults to limit=20, max 500. Returns matched documents.",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      filter: FilterSchema,
      projection: ProjectionSchema,
      limit: z.number().int().positive().max(MAX_FIND_LIMIT).optional(),
      sort: SortSchema,
    },
    async ({ database, collection, filter, projection, limit, sort }) => {
      try {
        const client = await conn.getClient();
        const col = client.db(database).collection(collection);
        const cursor = col.find((filter ?? {}) as Document, {
          projection: projection as Document | undefined,
          limit: limit ?? DEFAULT_FIND_LIMIT,
          sort: sort as Sort | undefined,
          maxTimeMS: OP_MAX_TIME_MS,
        });
        const docs = await cursor.toArray();
        return textResult({
          env: conn.getActiveEnv(),
          database,
          collection,
          count: docs.length,
          limit: limit ?? DEFAULT_FIND_LIMIT,
          documents: docs,
        });
      } catch (err) {
        return errorResult(`find failed: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "aggregate",
    "Run an aggregation pipeline. Result capped at 500 documents.",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      pipeline: PipelineSchema,
    },
    async ({ database, collection, pipeline }) => {
      try {
        // Reject write-capable stages ($out, $merge) before sending to the server.
        // These bypass the write tools' confirmation flow entirely.
        for (const stage of pipeline) {
          for (const key of Object.keys(stage)) {
            if ((DISALLOWED_AGG_STAGES as readonly string[]).includes(key)) {
              return errorResult(
                `aggregate refused: stage '${key}' performs writes and is blocked in all environments. ` +
                  `Use the dedicated write tools (insert/update/delete) with confirmed=true if needed.`,
              );
            }
          }
        }
        const client = await conn.getClient();
        const col = client.db(database).collection(collection);
        const docs = await col
          .aggregate(pipeline as Document[], { maxTimeMS: OP_MAX_TIME_MS })
          .limit(MAX_AGG_RESULTS)
          .toArray();
        return textResult({
          env: conn.getActiveEnv(),
          database,
          collection,
          count: docs.length,
          capped: docs.length >= MAX_AGG_RESULTS,
          documents: docs,
        });
      } catch (err) {
        return errorResult(`aggregate failed: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "count",
    "Count documents. With no filter uses estimatedDocumentCount (fast, metadata-based). With a filter uses countDocuments (exact but slower).",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      filter: FilterSchema,
    },
    async ({ database, collection, filter }) => {
      try {
        const client = await conn.getClient();
        const col = client.db(database).collection(collection);
        const hasFilter = filter && Object.keys(filter).length > 0;
        const n = hasFilter
          ? await col.countDocuments(filter as Document, {
              maxTimeMS: OP_MAX_TIME_MS,
            })
          : await col.estimatedDocumentCount({ maxTimeMS: OP_MAX_TIME_MS });
        return textResult({
          env: conn.getActiveEnv(),
          database,
          collection,
          count: n,
          estimated: !hasFilter,
        });
      } catch (err) {
        return errorResult(`count failed: ${(err as Error).message}`);
      }
    },
  );
}
