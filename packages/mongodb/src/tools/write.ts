import { z } from "zod";
import type { Document, Filter, UpdateFilter } from "mongodb";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection.js";
import { textResult, errorResult, NonEmptyString } from "./environment.js";

const DocumentSchema = z.record(z.string(), z.unknown());
const FilterSchema = z.record(z.string(), z.unknown());
const UpdateSchema = z.record(z.string(), z.unknown());

type ConfirmShape = { confirmed?: boolean };

/**
 * Wrap a write handler so that, when the active env is `prd` and `confirmed`
 * isn't explicitly true, we return a structured confirmation-required response
 * instead of executing.
 *
 * Pass `alwaysConfirm: true` for extra-dangerous ops (e.g. drop_collection)
 * which require confirmation in every environment.
 */
function withProdGuard<TArgs extends ConfirmShape>(
  conn: ConnectionManager,
  opName: string,
  describe: (args: TArgs) => Record<string, unknown>,
  execute: (args: TArgs) => Promise<unknown>,
  alwaysConfirm = false,
) {
  return async (args: TArgs) => {
    const needsConfirm = alwaysConfirm || conn.isProduction();
    if (needsConfirm && !args.confirmed) {
      return textResult({
        confirmationRequired: true,
        operation: opName,
        environment: conn.getActiveEnv(),
        environmentName: conn.getActiveEnvName(),
        host: conn.getActiveHost(),
        reason: alwaysConfirm
          ? `${opName} is destructive and requires explicit confirmation in every environment.`
          : `Active environment is production. Re-invoke with confirmed=true to execute.`,
        plannedExecution: describe(args),
      });
    }
    try {
      const result = await execute(args);
      return textResult({
        env: conn.getActiveEnv(),
        operation: opName,
        ...(result as Record<string, unknown>),
      });
    } catch (err) {
      return errorResult(`${opName} failed: ${(err as Error).message}`);
    }
  };
}

export function registerWriteTools(
  server: McpServer,
  conn: ConnectionManager,
): void {
  // insert_one
  server.tool(
    "insert_one",
    "Insert one document. In prd, requires confirmed=true.",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      document: DocumentSchema,
      confirmed: z.boolean().optional(),
    },
    withProdGuard(
      conn,
      "insert_one",
      (a) => ({
        database: a.database,
        collection: a.collection,
        document: a.document,
      }),
      async (a) => {
        const client = await conn.getClient();
        const r = await client
          .db(a.database)
          .collection(a.collection)
          .insertOne(a.document as Document);
        return { acknowledged: r.acknowledged, insertedId: r.insertedId };
      },
    ),
  );

  // insert_many
  server.tool(
    "insert_many",
    "Insert multiple documents. In prd, requires confirmed=true.",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      documents: z.array(DocumentSchema).min(1),
      confirmed: z.boolean().optional(),
    },
    withProdGuard(
      conn,
      "insert_many",
      (a) => ({
        database: a.database,
        collection: a.collection,
        documentCount: a.documents.length,
        firstDocumentPreview: a.documents[0],
      }),
      async (a) => {
        const client = await conn.getClient();
        const r = await client
          .db(a.database)
          .collection(a.collection)
          .insertMany(a.documents as Document[]);
        return {
          acknowledged: r.acknowledged,
          insertedCount: r.insertedCount,
          insertedIds: r.insertedIds,
        };
      },
    ),
  );

  // update_one
  server.tool(
    "update_one",
    "Update one matching document. In prd, requires confirmed=true.",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      filter: FilterSchema,
      update: UpdateSchema,
      upsert: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    withProdGuard(
      conn,
      "update_one",
      (a) => ({
        database: a.database,
        collection: a.collection,
        filter: a.filter,
        update: a.update,
        upsert: a.upsert ?? false,
      }),
      async (a) => {
        const client = await conn.getClient();
        const r = await client
          .db(a.database)
          .collection(a.collection)
          .updateOne(
            a.filter as Filter<Document>,
            a.update as UpdateFilter<Document>,
            { upsert: a.upsert ?? false },
          );
        return {
          acknowledged: r.acknowledged,
          matchedCount: r.matchedCount,
          modifiedCount: r.modifiedCount,
          upsertedCount: r.upsertedCount,
          upsertedId: r.upsertedId,
        };
      },
    ),
  );

  // update_many
  server.tool(
    "update_many",
    "Update all matching documents. In prd, requires confirmed=true.",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      filter: FilterSchema,
      update: UpdateSchema,
      confirmed: z.boolean().optional(),
    },
    withProdGuard(
      conn,
      "update_many",
      (a) => ({
        database: a.database,
        collection: a.collection,
        filter: a.filter,
        update: a.update,
      }),
      async (a) => {
        const client = await conn.getClient();
        const r = await client
          .db(a.database)
          .collection(a.collection)
          .updateMany(
            a.filter as Filter<Document>,
            a.update as UpdateFilter<Document>,
          );
        return {
          acknowledged: r.acknowledged,
          matchedCount: r.matchedCount,
          modifiedCount: r.modifiedCount,
        };
      },
    ),
  );

  // delete_one
  server.tool(
    "delete_one",
    "Delete one matching document. In prd, requires confirmed=true.",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      filter: FilterSchema,
      confirmed: z.boolean().optional(),
    },
    withProdGuard(
      conn,
      "delete_one",
      (a) => ({
        database: a.database,
        collection: a.collection,
        filter: a.filter,
      }),
      async (a) => {
        const client = await conn.getClient();
        const r = await client
          .db(a.database)
          .collection(a.collection)
          .deleteOne(a.filter as Filter<Document>);
        return { acknowledged: r.acknowledged, deletedCount: r.deletedCount };
      },
    ),
  );

  // delete_many
  server.tool(
    "delete_many",
    "Delete all matching documents. In prd, requires confirmed=true.",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      filter: FilterSchema,
      confirmed: z.boolean().optional(),
    },
    withProdGuard(
      conn,
      "delete_many",
      (a) => ({
        database: a.database,
        collection: a.collection,
        filter: a.filter,
      }),
      async (a) => {
        const client = await conn.getClient();
        const r = await client
          .db(a.database)
          .collection(a.collection)
          .deleteMany(a.filter as Filter<Document>);
        return { acknowledged: r.acknowledged, deletedCount: r.deletedCount };
      },
    ),
  );

  // drop_collection — ALWAYS requires confirmation
  server.tool(
    "drop_collection",
    "Drop an entire collection. Requires confirmed=true in EVERY environment (dev/stg/prd).",
    {
      database: NonEmptyString,
      collection: NonEmptyString,
      confirmed: z.boolean().optional(),
    },
    withProdGuard(
      conn,
      "drop_collection",
      (a) => ({ database: a.database, collection: a.collection }),
      async (a) => {
        const client = await conn.getClient();
        const dropped = await client
          .db(a.database)
          .collection(a.collection)
          .drop();
        return { dropped };
      },
      /* alwaysConfirm */ true,
    ),
  );
}
