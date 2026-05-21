import { createCompany, syncCompanyFromCvr, type CreateCompanyResult } from "../core/company";
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
