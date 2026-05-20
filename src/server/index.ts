// Cockpit backend (#170) — public surface barrel.
//
// A local JSON API on Bun.serve over the workspace + core. Reads and
// workspace-management only; bookkeeping mutations stay in the agent/CLI path.

export { resolveServerConfig, DEFAULT_APP_HOST, DEFAULT_APP_PORT } from "./config";
export type { ServerConfig } from "./config";
export { startCockpitServer } from "./app";
export type { CockpitServer } from "./app";
export { handleRequest } from "./router";
export { authMiddleware, LOCALHOST_PRINCIPAL } from "./auth";
export type { Principal } from "./auth";
export { ApiError, toErrorResponse } from "./errors";
export {
  buildPortfolioOverview,
  buildCompanyDashboardData,
  resolveAsOfDate,
} from "./data";
export type { PortfolioOverview, CompanySummary } from "./data";
