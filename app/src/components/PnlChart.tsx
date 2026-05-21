// Month-by-month income-vs-expense bar chart for the Overblik (P&L graph).
//
// Chart.js is registered once here. Colours are pulled from the cockpit
// design tokens (DESIGN.md palette) so the chart stays consistent with the
// rest of the SPA — no shadows, sober paper-near surfaces.

import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
  type ChartData,
  type ChartOptions,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import type { OverviewMonth } from "../lib/types";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

// DESIGN.md palette — kept in sync with app/src/styles.css tokens.
const INK_MUTED = "#4c4740";
const INCOME = "#2e5e4e"; // --color-success
const EXPENSE = "#a6332a"; // --color-accent
const BORDER = "#d8d2c6"; // --color-border

const CURRENCY = new Intl.NumberFormat("da-DK", {
  style: "currency",
  currency: "DKK",
  maximumFractionDigits: 0,
});

export function PnlChart({ months }: { months: OverviewMonth[] }) {
  const data: ChartData<"bar"> = {
    labels: months.map((m) => m.label),
    datasets: [
      {
        label: "Indtægter",
        data: months.map((m) => m.income),
        backgroundColor: INCOME,
        borderRadius: 2,
      },
      {
        label: "Udgifter",
        data: months.map((m) => m.expense),
        backgroundColor: EXPENSE,
        borderRadius: 2,
      },
    ],
  };

  const options: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        position: "top",
        align: "end",
        labels: {
          color: INK_MUTED,
          boxWidth: 12,
          boxHeight: 12,
          font: { family: "IBM Plex Sans", size: 13 },
        },
      },
      tooltip: {
        callbacks: {
          label: (ctx) =>
            `${ctx.dataset.label}: ${CURRENCY.format(Number(ctx.parsed.y))}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: INK_MUTED,
          font: { family: "IBM Plex Sans", size: 12 },
        },
      },
      y: {
        beginAtZero: true,
        grid: { color: BORDER },
        ticks: {
          color: INK_MUTED,
          font: { family: "IBM Plex Mono", size: 11 },
          callback: (value) => CURRENCY.format(Number(value)),
        },
      },
    },
  };

  return (
    <div className="pnl-chart">
      <Bar data={data} options={options} />
    </div>
  );
}
