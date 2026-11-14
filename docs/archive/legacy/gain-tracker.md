# Position Gain Tracking and Trailing Stop-Loss Engine

## 1. Overview
The `GainTrackerService` (`src/modules/tracker/gain-tracker.service.ts`) monitors open crypto positions in real time, calculating profit and loss (PnL) metrics, maintaining dynamic peak price records, and triggering risk mitigation alerts.

---

## 2. Mathematical Formulations

### 2.1. Current Profit and Loss (PnL %)
$$\text{CurrentGainPct} = \frac{P_{\text{current}} - P_{\text{entry}}}{P_{\text{entry}}} \times 100$$

### 2.2. Peak Price Tracking
For every polling cycle $t$:
$$P_{\text{peak}} = \max(P_{\text{peak}}, P_{\text{current}})$$
$$\text{HighestGainPct} = \max(\text{HighestGainPct}, \text{CurrentGainPct})$$

### 2.3. Trailing Stop-Loss Trigger
Measures the percentage drop from the recorded all-time high of the position:
$$\text{DropFromPeakPct} = \frac{P_{\text{peak}} - P_{\text{current}}}{P_{\text{peak}}} \times 100$$

A trailing stop alert triggers when:
$$\text{HighestGainPct} > 20\% \quad \text{AND} \quad \text{DropFromPeakPct} \ge \text{trailingStopPct}$$

Where `trailingStopPct` defaults to $15.0\%$.

### 2.4. Take-Profit Milestone Triggers
The service tracks multiple upside milestones:
* **2x Milestone**: Triggered when $\text{CurrentGainPct} \ge 100\%$. Alerts the user to consider de-risking and recovering initial principal.
* **5x Milestone**: Triggered when $\text{CurrentGainPct} \ge 400\%$.
* **10x Milestone**: Triggered when $\text{CurrentGainPct} \ge 900\%$.

---

## 3. Position Lifecycle States

```
+-------------------------------------------------------------+
|                          ACTIVE                             |
| - Continuously polled against DexScreener every 60 seconds  |
| - Live PnL updated in SQLite database                       |
+------------------------------+------------------------------+
                               |
               +---------------+---------------+
               |                               |
               v                               v
+-----------------------------+ +-----------------------------+
|        STOPPED_OUT          | |           CLOSED            |
| - Triggered by trailing stop| | - Manually closed or exited |
| - High-priority alert sent  | | - Historical record retained|
+-----------------------------+ +-----------------------------+
```

---

## 4. User Interaction Methods
* **One-Click Tracking**: Clicking `[Track Position]` on any Discord gem alert immediately creates an active position with the current price as the entry baseline.
* **Manual Slash Command**:
  ```text
  /track address:<token_pair_address> entry_price:0.045 trailing_stop:12.5
  ```
* **Status Inspection**:
  ```text
  /gains
  ```
  Returns a formatted summary of all active positions, current PnL, and peak records.
