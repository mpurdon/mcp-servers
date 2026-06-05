/**
 * Item tools: list_items.
 *
 * Endpoint: /accounting/account/<account_id>/items/items
 */

import { z } from "zod";
import type { FreshBooksClient } from "../freshbooks/client.js";
import type { Item } from "../freshbooks/types.js";

export const ListItemsInput = z
  .object({
    search: z.string().max(200).optional().describe("Match item name."),
    page: z.number().int().min(1).default(1),
    per_page: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export async function listItems(
  client: FreshBooksClient,
  input: z.infer<typeof ListItemsInput>,
): Promise<unknown> {
  const path = `/accounting/account/${client.accountId}/items/items`;
  const query: Record<string, string | number> = {
    page: input.page,
    per_page: input.per_page,
  };
  if (input.search) query["search[name_like]"] = input.search;

  type Result = {
    items: Item[];
    page: number;
    pages: number;
    per_page: number;
    total: number;
  };
  return client.accounting<Result>("GET", path, "", { query });
}
