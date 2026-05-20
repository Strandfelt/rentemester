// App shell + routing for the cockpit SPA (#171).
//
// Routes:
//   /                      portfolio overview (→ onboarding when empty)
//   /companies/new         add a company
//   /companies/:slug       per-company dashboard
//   /companies/:slug/manage  rename / archive

import { NavLink, Route, Routes, Link } from "react-router-dom";
import { PortfolioView } from "./views/PortfolioView";
import { AddCompanyView } from "./views/AddCompanyView";
import { DashboardView } from "./views/DashboardView";
import { ManageCompanyView } from "./views/ManageCompanyView";

export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>
          Rentemester <span className="brand-dot">Cockpit</span>
        </h1>
        <nav>
          <NavLink to="/" end>
            Portefølje
          </NavLink>
          <NavLink to="/companies/new">Tilføj virksomhed</NavLink>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<PortfolioView />} />
          <Route path="/companies/new" element={<AddCompanyView />} />
          <Route path="/companies/:slug" element={<DashboardView />} />
          <Route
            path="/companies/:slug/manage"
            element={<ManageCompanyView />}
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <section className="state-msg">
      <p>Siden findes ikke.</p>
      <Link className="btn secondary" to="/">
        Til porteføljen
      </Link>
    </section>
  );
}
