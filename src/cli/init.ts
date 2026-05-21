import { existsSync } from "node:fs";
import { companyPaths } from "../core/paths";
import {
  initialiseCompanyVolume,
  summariseCompanyVolume,
  type CompanyOnboardingSummary,
} from "../core/company";
import {
  registerCompanyDirIntoWorkspace,
  resolveConfiguredWorkspaceRoot,
  resolveWorkspaceRoot,
  type WorkspaceAutoRegisterResult,
} from "../core/workspace";
import type { CommandContext, CommandDispatch } from "../cli-dispatch";

const MONTH_NAMES_DA = [
  "januar",
  "februar",
  "marts",
  "april",
  "maj",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "december",
];

const FISCAL_LABEL_DA: Record<string, string> = {
  "end-year": "navngives efter slutåret",
  "start-year": "navngives efter startåret",
  span: "navngives som spænd (fx 2025/2026)",
};

/**
 * Resolves the workspace root that an `init` invocation should register into.
 *
 * `init` is the legacy single-company path, so a workspace is *optional*:
 * `--workspace <dir>` wins, otherwise `RENTEMESTER_WORKSPACE`. Returns null
 * when neither is set — `init` then behaves exactly as before. An unsafe
 * value is fatal (parse error) so a traversal payload cannot relocate things.
 */
function resolveInitWorkspaceRoot(ctx: CommandContext): string | null {
  const fromFlag = ctx.trimToNull(ctx.arg("--workspace"));
  try {
    return fromFlag ? resolveWorkspaceRoot(fromFlag) : resolveConfiguredWorkspaceRoot();
  } catch (error) {
    ctx.fatal(error instanceof Error ? error.message : String(error));
  }
}

/** Renders the human-readable onboarding block printed after a successful `init`. */
function buildOnboardingLines(
  root: string,
  summary: CompanyOnboardingSummary,
  registration: WorkspaceAutoRegisterResult | null,
): string[] {
  const monthName = MONTH_NAMES_DA[summary.fiscalYearStartMonth - 1] ?? `måned ${summary.fiscalYearStartMonth}`;
  const fiscalLabel = FISCAL_LABEL_DA[summary.fiscalYearLabelStrategy] ?? summary.fiscalYearLabelStrategy;
  const lines: string[] = [];

  lines.push("");
  lines.push(`Virksomheden '${summary.name}' er klar.`);
  lines.push("");
  lines.push("Oprettet:");
  lines.push(`  - Virksomhedsmappe: ${root}`);
  lines.push(`  - Hovedbog (ledger): ${companyPaths(root).db}`);
  lines.push(`  - Standardkontoplan: ${summary.accountCount} konti (resultat, balance, moms)`);
  if (registration?.status === "registered") {
    lines.push(`  - Registreret i Cockpit-workspacet som '${registration.slug}'`);
  } else if (registration?.status === "already-registered") {
    lines.push(`  - Allerede registreret i Cockpit-workspacet som '${registration.slug}'`);
  }

  lines.push("");
  lines.push("Tjek disse indstillinger — de er svære at ændre senere:");
  lines.push(`  - Regnskabsår: starter 1. ${monthName} (${fiscalLabel})`);
  lines.push(
    `  - Momsperiode: kvartal (Rentemester antager kvartalsmoms). Afregner du`,
  );
  lines.push(
    `    måneds- eller halvårsmoms, så afstem dine momsperioder efter det.`,
  );
  lines.push(`  - CVR: ${summary.cvr ?? "ikke sat — sæt det med 'init --cvr <DK########>'"}`);

  lines.push("");
  lines.push("Næste skridt:");
  if (!summary.cvr) {
    lines.push("  1. Sæt CVR-nummeret, så fakturaer og rapporter er korrekte.");
    lines.push("  2. Hent virksomhedens stamdata: 'rentemester company sync-cvr --company <sti>'.");
    lines.push("  3. Opret din første kunde: 'rentemester customer create --company <sti> ...'.");
    lines.push("  4. Bogfør dit første bilag, eller udsted din første faktura.");
  } else {
    lines.push("  1. Hent virksomhedens stamdata: 'rentemester company sync-cvr --company <sti>'.");
    lines.push("  2. Opret din første kunde: 'rentemester customer create --company <sti> ...'.");
    lines.push("  3. Bogfør dit første bilag, eller udsted din første faktura.");
  }
  lines.push("");
  lines.push("Se kontoplanen med: 'rentemester accounts list --company <sti>'.");

  return lines;
}

export function register(dispatch: CommandDispatch): void {
  dispatch.on("init", null, (ctx) => {
    const root = ctx.companyRoot();
    const workspaceRoot = resolveInitWorkspaceRoot(ctx);

    let summary: CompanyOnboardingSummary;
    try {
      initialiseCompanyVolume(root, {
        cvr: ctx.arg("--cvr"),
        fiscalYearStartMonth: ctx.arg("--fiscal-year-start-month"),
        fiscalYearLabelStrategy: ctx.arg("--fiscal-year-label-strategy"),
      });
      summary = summariseCompanyVolume(root);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }

    // #216: when the company directory lives inside a configured workspace,
    // also register it in the workspace manifest so the Cockpit sees it.
    // registerCompanyDirIntoWorkspace never throws, so this can never break
    // `init` for a `--company` path that is not a workspace member.
    let registration: WorkspaceAutoRegisterResult | null = null;
    if (workspaceRoot) {
      registration = registerCompanyDirIntoWorkspace(workspaceRoot, root, {
        name: summary.name,
      });
    }

    ctx.emitResult({
      ok: true,
      message: `Initialized Rentemester company at ${root}`,
      companyRoot: root,
      ledger: companyPaths(root).db,
      accountCount: summary.accountCount,
      cvr: summary.cvr,
      fiscalYearStartMonth: summary.fiscalYearStartMonth,
      fiscalYearLabelStrategy: summary.fiscalYearLabelStrategy,
      vatPeriod: summary.vatPeriod,
      workspace: workspaceRoot,
      workspaceRegistered: registration?.status === "registered",
      workspaceSlug:
        registration && registration.status !== "outside-workspace"
          ? registration.slug
          : undefined,
    });

    // The structured JSON above stays machine-stable for agents; the rich
    // onboarding block (#214) is human-output only.
    if (ctx.outputFormat === "human") {
      for (const line of buildOnboardingLines(root, summary, registration)) {
        console.log(line);
      }
    }
  });

  dispatch.on("system", "healthcheck", (ctx) => {
    const p = companyPaths(ctx.companyRoot());
    const checks: Array<[string, boolean]> = [
      ["company_root", existsSync(p.root)],
      ["data_dir", existsSync(p.data)],
      ["ledger", existsSync(p.db)],
      ["documents", existsSync(p.documentsInbox)],
      ["config", existsSync(p.config)],
    ];
    let ok = true;
    for (const [name, pass] of checks) {
      console.log(`${pass ? "OK" : "FAIL"} ${name}`);
      if (!pass) ok = false;
    }
    if (!ok) process.exit(1);
  });
}
