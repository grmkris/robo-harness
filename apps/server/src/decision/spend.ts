import { db } from "../store";
import { DecideFailure, type Rate, type SpendMeter } from "./jev";

db.exec(
  "CREATE TABLE IF NOT EXISTS decision_spend(id INTEGER PRIMARY KEY CHECK(id=1),calls INTEGER NOT NULL DEFAULT 0,spent_usd REAL NOT NULL DEFAULT 0)"
);
db.exec("INSERT OR IGNORE INTO decision_spend(id) VALUES(1)");

/** Operator cap on cumulative Jev spend across runs (USD). */
const jevBudgetUsd = (): number => {
  const value = Number(process.env["ROBO_JEV_BUDGET_USD"] ?? 10);
  return Number.isFinite(value) && value >= 0 ? value : 10;
};

interface SpendRow {
  calls: number;
  spent_usd: number;
}

const row = (): SpendRow =>
  db
    .query<SpendRow, []>(
      "SELECT calls,spent_usd FROM decision_spend WHERE id=1"
    )
    .get() ?? { calls: 0, spent_usd: 0 };

/** Persistent meter: a restart cannot reset the cumulative cap. */
export const sqliteMeter = (rate: Rate): SpendMeter => ({
  rate,
  reserve: () => {
    const limit = jevBudgetUsd();
    const current = row();
    if (current.spent_usd + 4000 * rate.input > limit) {
      throw new DecideFailure(
        "budget",
        `Jev budget exhausted ($${current.spent_usd.toFixed(6)} of $${limit})`
      );
    }
    db.run("UPDATE decision_spend SET calls=calls+1 WHERE id=1");
  },
  record: (usd) => {
    db.query("UPDATE decision_spend SET spent_usd=spent_usd+? WHERE id=1").run(
      usd
    );
  },
  summary: () => {
    const current = row();
    return {
      calls: current.calls,
      usd: current.spent_usd,
      limit_usd: jevBudgetUsd(),
    };
  },
});

export const spendSummary = () => {
  const current = row();
  return {
    calls: current.calls,
    usd: current.spent_usd,
    limit_usd: jevBudgetUsd(),
  };
};
