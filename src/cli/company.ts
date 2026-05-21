import {
  createCompany,
  getCompanySettings,
  setCompanyProfile,
  syncCompanyFromCvr,
  type CreateCompanyResult,
} from "../core/company";
import { migrate } from "../core/db";
import {
  initWorkspace,
  listWorkspaceCompanies,
  resolveConfiguredWorkspaceRoot,
  resolveWorkspaceRoot,
  workspaceExists,
} from "../core/workspace";
import { openCommandDb } from "../cli-dispatch";
import type { CommandContext, CommandDispatch } from "../cli-dispatch";

/**
 * Resolves the workspace root for `company` commands.
 *
 * `company` commands are workspace-scoped, so `RENTEMESTER_WORKSPACE` (or
 * `--workspace`) is required — there is no per-company `--company` here.
 */
function requireWorkspaceRoot(ctx: CommandContext): string {
  const fromFlag = ctx.trimToNull(ctx.arg("--workspace"));
  let root: string | null;
  try {
    root = fromFlag ? resolveWorkspaceRoot(fromFlag) : resolveConfiguredWorkspaceRoot();
  } catch (error) {
    return ctx.fatal(error instanceof Error ? error.message : String(error));
  }
  if (!root) {
    return ctx.fatal(
      "no workspace configured: pass --workspace <dir> or set RENTEMESTER_WORKSPACE",
    );
  }
  return root;
}

export function register(dispatch: CommandDispatch): void {
  dispatch.on("company", "add", (ctx) => {
    const workspaceRoot = requireWorkspaceRoot(ctx);
    const name = ctx.trimToNull(ctx.arg("--name"));
    if (!name) {
      return ctx.fatal("company add requires --name <text>");
    }

    // First-run onboarding: a missing workspace is created on the spot, so
    // the first `company add` doubles as guided workspace bootstrap. This is
    // deterministic — no interactive prompts — for agent/script use.
    const firstRun = !workspaceExists(workspaceRoot);
    if (firstRun) initWorkspace(workspaceRoot);

    let result: CreateCompanyResult;
    try {
      result = createCompany(workspaceRoot, {
        name,
        slug: ctx.trimToNull(ctx.arg("--slug")) ?? undefined,
        cvr: ctx.arg("--cvr"),
        fiscalYearStartMonth: ctx.arg("--fiscal-year-start-month"),
        fiscalYearLabelStrategy: ctx.arg("--fiscal-year-label-strategy"),
        // #221: capture the company's own identity + payment details once.
        address: ctx.trimToNull(ctx.arg("--address")) ?? undefined,
        postalCode: ctx.trimToNull(ctx.arg("--postal-code")) ?? undefined,
        city: ctx.trimToNull(ctx.arg("--city")) ?? undefined,
        paymentTermsDays: ctx.arg("--payment-terms"),
        payment: {
          bankName: ctx.trimToNull(ctx.arg("--bank-name")) ?? undefined,
          registrationNo: ctx.trimToNull(ctx.arg("--bank-reg")) ?? undefined,
          accountNo: ctx.trimToNull(ctx.arg("--bank-account")) ?? undefined,
          iban: ctx.trimToNull(ctx.arg("--iban")) ?? undefined,
        },
      });
    } catch (error) {
      return ctx.fatal(error instanceof Error ? error.message : String(error));
    }

    ctx.emitResult({
      ok: true,
      message: firstRun
        ? `Created workspace and company '${result.slug}'`
        : `Created company '${result.slug}'`,
      workspace: workspaceRoot,
      workspaceCreated: firstRun,
      slug: result.slug,
      name: result.name,
      companyRoot: result.companyRoot,
      ledger: result.dbPath,
    });
  });

  dispatch.on("company", "sync-cvr", async (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const result = await syncCompanyFromCvr(db);
    ctx.emitResult(result as unknown as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  // #221: the editable company profile. The owner sets their own identity
  // (name, address, CVR) and payment details (bank account / IBAN, payment
  // terms) once here; every subsequently-issued invoice and its PDF inherit
  // them automatically. Only the flags actually passed are changed.
  dispatch.on("company", "set-profile", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const hasFlag = (name: string) => ctx.arg(name) !== undefined;
    const payment = {
      bankName: ctx.trimToNull(ctx.arg("--bank-name")) ?? undefined,
      registrationNo: ctx.trimToNull(ctx.arg("--bank-reg")) ?? undefined,
      accountNo: ctx.trimToNull(ctx.arg("--bank-account")) ?? undefined,
      iban: ctx.trimToNull(ctx.arg("--iban")) ?? undefined,
    };
    const result = setCompanyProfile(db, {
      name: hasFlag("--name") ? ctx.arg("--name") : undefined,
      cvr: hasFlag("--cvr") ? ctx.arg("--cvr") : undefined,
      address: hasFlag("--address") ? ctx.arg("--address") : undefined,
      postalCode: hasFlag("--postal-code") ? ctx.arg("--postal-code") : undefined,
      city: hasFlag("--city") ? ctx.arg("--city") : undefined,
      paymentTermsDays: hasFlag("--payment-terms") ? ctx.arg("--payment-terms") : undefined,
      payment,
    });
    ctx.emitResult(result as unknown as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("company", "profile", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const settings = getCompanySettings(db);
    ctx.emitResult({
      ok: true,
      profile: {
        name: settings.name,
        cvr: settings.cvr,
        address: settings.address,
        postalCode: settings.postalCode,
        city: settings.city,
        paymentTermsDays: settings.paymentTermsDays,
      },
    });
    db.close();
  });

  dispatch.on("company", "list", (ctx) => {
    const workspaceRoot = requireWorkspaceRoot(ctx);
    const companies = workspaceExists(workspaceRoot)
      ? listWorkspaceCompanies(workspaceRoot)
      : [];
    ctx.emitResult({
      ok: true,
      message:
        companies.length === 0
          ? "Workspace has no companies yet"
          : `${companies.length} ${companies.length === 1 ? "company" : "companies"}: ` +
            companies.map((c) => c.slug).join(", "),
      workspace: workspaceRoot,
      count: companies.length,
      companies: companies.map((c) => ({
        slug: c.slug,
        name: c.name,
        createdAt: c.createdAt,
        archived: c.archived,
      })),
    });
  });
}
