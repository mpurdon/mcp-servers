/**
 * Account info tool — returns the discovered account_id and business name.
 * Useful for verifying setup and confirming you're hitting the right tenant.
 */

import { z } from "zod";
import type { FreshBooksClient } from "../freshbooks/client.js";

export const GetAccountInfoInput = z.object({}).strict();

export async function getAccountInfo(
  client: FreshBooksClient,
  _input: z.infer<typeof GetAccountInfoInput>,
): Promise<{
  account_id: string;
  business_id: number | undefined;
  business_name: string | undefined;
}> {
  return {
    account_id: client.accountId,
    business_id: client.businessId,
    business_name: client.businessName,
  };
}
