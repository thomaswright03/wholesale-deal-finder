// Today's 30-year fixed mortgage rate from FRED (Federal Reserve Bank of St. Louis), no key needed.
//   OBMMIC30YF: Optimal Blue 30-year conforming rate, updated every business day (preferred)
//   MORTGAGE30US: Freddie Mac weekly survey (fallback)
// Falls back to config.json's buyer.interestRate if both fail.
const SERIES = [
  { id: "OBMMIC30YF", name: "Optimal Blue 30-yr conforming (daily)" },
  { id: "MORTGAGE30US", name: "Freddie Mac 30-yr fixed (weekly)" },
];

export interface LiveRate { rate: number; date: string; source: string }

export async function fetchMortgageRate(): Promise<LiveRate | null> {
  for (const s of SERIES) {
    try {
      const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s.id}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const rows = (await res.text()).trim().split("\n").slice(1).map((r) => r.split(","));
      for (let i = rows.length - 1; i >= 0; i--) {
        const pct = Number(rows[i][1]);
        if (rows[i][1] && pct > 1 && pct < 20) return { rate: pct / 100, date: rows[i][0], source: s.name };
      }
    } catch { /* try the next series */ }
  }
  return null;
}
