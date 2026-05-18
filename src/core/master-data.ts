import type { Database } from "bun:sqlite";
import type { InvoicePayload } from "./invoice";
import type { DocumentMetadata } from "./documents";
import { insertAuditLog } from "./actor";

export type CustomerRecord = {
  id: number;
  name: string;
  address: string | null;
  vatOrCvr: string | null;
  email: string | null;
  eanNumber: string | null;
  paymentTermsDays: number;
  defaultCurrency: string;
  notes: string | null;
  archived: number;
  createdAt: string;
};

export type VendorRecord = {
  id: number;
  name: string;
  address: string | null;
  vatOrCvr: string | null;
  defaultExpenseAccount: string | null;
  defaultVatTreatment: string | null;
  notes: string | null;
  archived: number;
  createdAt: string;
};

export type CreateCustomerInput = {
  name: string;
  address?: string;
  vatOrCvr?: string;
  email?: string;
  eanNumber?: string;
  paymentTermsDays?: number;
  defaultCurrency?: string;
  notes?: string;
};

export type CreateVendorInput = {
  name: string;
  address?: string;
  vatOrCvr?: string;
  defaultExpenseAccount?: string;
  defaultVatTreatment?: string;
  notes?: string;
};

function trimToNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCurrency(value: string | null | undefined) {
  return (trimToNull(value) ?? "DKK").toUpperCase();
}

export function createCustomer(db: Database, input: CreateCustomerInput) {
  const name = trimToNull(input.name);
  if (!name) return { ok: false, errors: ["name is required"] };
  const paymentTermsDays = Number.isInteger(input.paymentTermsDays) && Number(input.paymentTermsDays) > 0 ? Number(input.paymentTermsDays) : 30;
  const defaultCurrency = normalizeCurrency(input.defaultCurrency);
  if (!/^[A-Z]{3}$/.test(defaultCurrency)) return { ok: false, errors: ["defaultCurrency must be a 3-letter ISO code"] };

  const inserted = db.transaction(() => {
    const row = db.query(
      `INSERT INTO customers (name, address, vat_or_cvr, email, ean_number, payment_terms_days, default_currency, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, created_at`
    ).get(
      name,
      trimToNull(input.address),
      trimToNull(input.vatOrCvr),
      trimToNull(input.email),
      trimToNull(input.eanNumber),
      paymentTermsDays,
      defaultCurrency,
      trimToNull(input.notes),
    ) as { id: number; created_at: string };

    insertAuditLog(db, {
      eventType: "customer_create",
      entityType: "customer",
      entityId: row.id,
      message: `Created customer ${name}`,
    });

    return row;
  }, { immediate: true })();

  return { ok: true, customerId: inserted.id, appliedRules: ["DK-MASTER-DATA-CUSTOMER-001"], errors: [] };
}

export function listCustomers(db: Database, options: { archived?: boolean } = {}) {
  const rows = db.query(
    `SELECT id, name, address, vat_or_cvr, email, ean_number, payment_terms_days, default_currency, notes, archived, created_at
     FROM customers
     WHERE archived = CASE WHEN ? THEN archived ELSE 0 END
     ORDER BY lower(name) ASC, id ASC`
  ).all(options.archived ? 1 : 0) as Array<{
    id: number; name: string; address: string | null; vat_or_cvr: string | null; email: string | null; ean_number: string | null; payment_terms_days: number; default_currency: string; notes: string | null; archived: number; created_at: string;
  }>;

  return {
    ok: true,
    count: rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      vatOrCvr: row.vat_or_cvr,
      email: row.email,
      eanNumber: row.ean_number,
      paymentTermsDays: row.payment_terms_days,
      defaultCurrency: row.default_currency,
      notes: row.notes,
      archived: Boolean(row.archived),
      createdAt: row.created_at,
    })),
    errors: [],
  };
}

export function createVendor(db: Database, input: CreateVendorInput) {
  const name = trimToNull(input.name);
  if (!name) return { ok: false, errors: ["name is required"] };

  const inserted = db.transaction(() => {
    const row = db.query(
      `INSERT INTO vendors (name, address, vat_or_cvr, default_expense_account, default_vat_treatment, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id, created_at`
    ).get(
      name,
      trimToNull(input.address),
      trimToNull(input.vatOrCvr),
      trimToNull(input.defaultExpenseAccount),
      trimToNull(input.defaultVatTreatment),
      trimToNull(input.notes),
    ) as { id: number; created_at: string };

    insertAuditLog(db, {
      eventType: "vendor_create",
      entityType: "vendor",
      entityId: row.id,
      message: `Created vendor ${name}`,
    });

    return row;
  }, { immediate: true })();

  return { ok: true, vendorId: inserted.id, appliedRules: ["DK-MASTER-DATA-VENDOR-001"], errors: [] };
}

export function listVendors(db: Database, options: { archived?: boolean } = {}) {
  const rows = db.query(
    `SELECT id, name, address, vat_or_cvr, default_expense_account, default_vat_treatment, notes, archived, created_at
     FROM vendors
     WHERE archived = CASE WHEN ? THEN archived ELSE 0 END
     ORDER BY lower(name) ASC, id ASC`
  ).all(options.archived ? 1 : 0) as Array<{
    id: number; name: string; address: string | null; vat_or_cvr: string | null; default_expense_account: string | null; default_vat_treatment: string | null; notes: string | null; archived: number; created_at: string;
  }>;

  return {
    ok: true,
    count: rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      vatOrCvr: row.vat_or_cvr,
      defaultExpenseAccount: row.default_expense_account,
      defaultVatTreatment: row.default_vat_treatment,
      notes: row.notes,
      archived: Boolean(row.archived),
      createdAt: row.created_at,
    })),
    errors: [],
  };
}

export function getCustomerById(db: Database, id: number) {
  return db.query(
    `SELECT id, name, address, vat_or_cvr, email, ean_number, payment_terms_days, default_currency, notes, archived, created_at
     FROM customers WHERE id = ? LIMIT 1`
  ).get(id) as {
    id: number; name: string; address: string | null; vat_or_cvr: string | null; email: string | null; ean_number: string | null; payment_terms_days: number; default_currency: string; notes: string | null; archived: number; created_at: string;
  } | null;
}

export function getVendorById(db: Database, id: number) {
  return db.query(
    `SELECT id, name, address, vat_or_cvr, default_expense_account, default_vat_treatment, notes, archived, created_at
     FROM vendors WHERE id = ? LIMIT 1`
  ).get(id) as {
    id: number; name: string; address: string | null; vat_or_cvr: string | null; default_expense_account: string | null; default_vat_treatment: string | null; notes: string | null; archived: number; created_at: string;
  } | null;
}

export function resolveInvoiceMasterData(db: Database, payload: InvoicePayload, options: { customerId?: number | null }) {
  if (!options.customerId) return { ok: true, payload };
  const customer = getCustomerById(db, options.customerId);
  if (!customer || customer.archived) return { ok: false, errors: [`customer ${options.customerId} does not exist`] };
  return {
    ok: true,
    payload: {
      ...payload,
      buyer: {
        name: trimToNull(payload.buyer?.name) ?? customer.name,
        address: trimToNull(payload.buyer?.address) ?? customer.address ?? undefined,
        vatOrCvr: trimToNull(payload.buyer?.vatOrCvr) ?? customer.vat_or_cvr ?? undefined,
      },
      currency: trimToNull(payload.currency) ?? customer.default_currency,
      dueDate: trimToNull(payload.dueDate) ?? (trimToNull(payload.issueDate) && customer.payment_terms_days > 0 ? addDays(payload.issueDate!, customer.payment_terms_days) : undefined),
    },
  };
}

function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function resolveDocumentMasterData(db: Database, metadata: DocumentMetadata, options: { vendorId?: number | null }) {
  if (!options.vendorId) return { ok: true, metadata };
  const vendor = getVendorById(db, options.vendorId);
  if (!vendor || vendor.archived) return { ok: false, errors: [`vendor ${options.vendorId} does not exist`] };
  return {
    ok: true,
    metadata: {
      ...metadata,
      sender: {
        name: trimToNull(metadata.sender?.name) ?? vendor.name,
        address: trimToNull(metadata.sender?.address) ?? vendor.address ?? undefined,
        vatOrCvr: trimToNull(metadata.sender?.vatOrCvr) ?? vendor.vat_or_cvr ?? undefined,
      },
    },
  };
}
