/**
 * Client tools: list_clients, get_client.
 *
 * Endpoint: /accounting/account/<account_id>/users/clients
 * Single client: /accounting/account/<account_id>/users/clients/<client_id>
 */

import { z } from "zod";
import type { FreshBooksClient } from "../freshbooks/client.js";
import type { Client } from "../freshbooks/types.js";

export const ListClientsInput = z
  .object({
    search: z
      .string()
      .max(200)
      .optional()
      .describe("Match organization or email."),
    page: z.number().int().min(1).default(1),
    per_page: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const GetClientInput = z
  .object({
    client_id: z.number().int().positive(),
  })
  .strict();

export async function listClients(
  client: FreshBooksClient,
  input: z.infer<typeof ListClientsInput>,
): Promise<unknown> {
  const path = `/accounting/account/${client.accountId}/users/clients`;
  const query: Record<string, string | number> = {
    page: input.page,
    per_page: input.per_page,
  };
  if (input.search) {
    query["search[organization_like]"] = input.search;
  }
  type Result = {
    clients: Client[];
    page: number;
    pages: number;
    per_page: number;
    total: number;
  };
  return client.accounting<Result>("GET", path, "", { query });
}

export async function getClient(
  client: FreshBooksClient,
  input: z.infer<typeof GetClientInput>,
): Promise<Client> {
  const path = `/accounting/account/${client.accountId}/users/clients/${input.client_id}`;
  return client.accounting<Client>("GET", path, "client");
}
