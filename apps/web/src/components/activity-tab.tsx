import type { AppEvent } from "@robo/domain";
import type { Dispatch, SetStateAction } from "react";

import { api, time } from "../lib/client";
import type { Status } from "../lib/types";

export function ActivityTab({
  budgetInput,
  setBudgetInput,
  budget,
  perception,
  events,
  setError,
  refresh,
}: {
  budgetInput: string;
  setBudgetInput: Dispatch<SetStateAction<string>>;
  budget: Status["budget"];
  perception: Status["perception"];
  events: AppEvent[];
  setError: Dispatch<SetStateAction<string>>;
  refresh: () => Promise<void>;
}) {
  return (
    <div className="tab-body">
      <p className="eyebrow">SYSTEM JOURNAL</p>
      <h2>Every action, visible.</h2>
      <div className="budget-box">
        <label htmlFor="budget">Perception spending cap (USD)</label>
        <div>
          <input
            id="budget"
            type="number"
            min="0"
            max="1000"
            step=".1"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
          />
          <button
            onClick={() => {
              void api("budget", { limit: Number(budgetInput) })
                .then(refresh)
                .catch((error) => setError(error.message));
            }}
          >
            Set cap
          </button>
        </div>
        <small>
          {budget
            ? `$${budget.spent_usd.toFixed(2)} reserved / $${budget.limit_usd.toFixed(2)}`
            : "No paid compute approved"}{" "}
          ·{" "}
          {perception.configured
            ? `${perception.provider} configured`
            : "No inference endpoint"}
        </small>
      </div>
      <ol className="event-list">
        {events
          .filter((e) => !e.type.startsWith("chat."))
          .slice(-50)
          .reverse()
          .map((e) => (
            <li key={e.id}>
              <time>{time(e.time)}</time>
              <strong>{e.type}</strong>
              <details>
                <summary>Details</summary>
                <pre>{JSON.stringify(e.data, null, 2)}</pre>
              </details>
            </li>
          ))}
      </ol>
    </div>
  );
}
