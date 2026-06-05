/**
 * Lightweight typings for the FreshBooks accounting API. Not exhaustive —
 * just the fields we actually read or send.
 */

export interface User {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string;
  business_memberships?: BusinessMembership[];
}

export interface BusinessMembership {
  id: number;
  role: string;
  business: {
    id: number;
    name: string;
    account_id: string;
  };
}

export interface InvoiceLine {
  // FreshBooks accepts either string-decimal cost or { amount, code } shape.
  type?: number;
  name?: string;
  description?: string;
  qty?: string | number;
  unit_cost?: { amount: string; code: string };
  taxName1?: string;
  taxAmount1?: string;
  taxName2?: string;
  taxAmount2?: string;
}

export interface Invoice {
  id?: number;
  invoiceid?: number;
  invoice_number?: string;
  customerid?: number;
  organization?: string;
  fname?: string;
  lname?: string;
  email?: string;
  status?: number;
  v3_status?: string;
  amount?: { amount: string; code: string };
  outstanding?: { amount: string; code: string };
  paid?: { amount: string; code: string };
  currency_code?: string;
  language?: string;
  terms?: string;
  notes?: string;
  create_date?: string;
  due_date?: string;
  due_offset_days?: number;
  lines?: InvoiceLine[];
}

export interface Client {
  id: number;
  userid?: number;
  fname?: string;
  lname?: string;
  organization?: string;
  email?: string;
  currency_code?: string;
  language?: string;
  vis_state?: number;
}

export interface Item {
  id?: number;
  itemid?: number;
  name?: string;
  description?: string;
  unit_cost?: { amount: string; code: string };
  qty?: string;
  vis_state?: number;
}

export interface Pagination {
  page: number;
  pages: number;
  per_page: number;
  total: number;
}

export interface ListResponse {
  // FreshBooks list responses look like { invoices: [...], page, pages, per_page, total }
  page: number;
  pages: number;
  per_page: number;
  total: number;
  // The collection key varies (invoices, clients, items). Caller picks it.
  [key: string]: unknown;
}
