# 🛑 Rug Detection Signal --- Reloadsol

## Purpose

Prevent rug-pull tokens from: - Appearing on Catch the Coin - Appearing
on Trending - Being used in Algo Signals - Triggering Alerts

This module runs **before UI exposure**.

---

## 1️⃣ Philosophy

Chart patterns are symptoms.\
On-chain behavior is the disease.

Phase 1 = deterministic rule engine\
Phase 2 = optional ML visual classifier\
Phase 3 = on-chain behavioral detection

We start with Phase 1.

---

## 2️⃣ Data Requirements

### Required:

- 5m OHLC (last 20--40 candles)
- Volume per candle
- Current Market Cap
- Current Liquidity
- Token Age

### Optional (Phase 3):

- Top holders %
- LP locked %
- Dev wallet activity
- Mint authority status

---

## 3️⃣ Rug Score Engine (0--100)

Each token gets a `rugScore`.

If:

rugScore \>= 80

→ Token is filtered from system.

---

## 4️⃣ Detection Components

### A. Staircase Pattern Detection (30 pts)

Artificial step-by-step controlled pump.

Conditions: - % of bullish candles in last 20 \> 70% - Average candle
gain \< 5% - Low wick variance - Price increased \> 80% over period

Max: 30 pts

---

### B. Volume Manipulation (20 pts)

Price rising without proportional volume expansion.

Conditions: - Price up \> 80% - Volume growth \< 20% - Volume variance
extremely low

Max: 20 pts

---

### C. Liquidity Risk (20 pts)

Liquidity / MarketCap \< 5%

Scoring: - \<5% → 10 pts - \<3% → 20 pts

Max: 20 pts

---

### D. Dump Detection (30 pts)

Conditions: - Single candle drop \> 40% - Max drawdown over 5 candles \>
60%

Max: 30 pts

---

## 5️⃣ Final Formula

rugScore = A + B + C + D

If rugScore \>= 80 → Filter

---

## 6️⃣ Filtering Guardrails

Apply only if: - Token age \< 48h OR - Liquidity \< \$100k

---

## 7️⃣ Output Structure

```ts
{
  rugScore: number,
  isRug: boolean,
  reasons: string[],
  breakdown: {
    staircase: number,
    volume: number,
    liquidity: number,
    dump: number
  }
}
```

---

## 8️⃣ Integration Flow

Fetch Token\
→ Fetch OHLC + Liquidity\
→ calculateRugScore()\
→ If isRug → exclude from UI + signals\
→ Else → proceed

---

## 9️⃣ Backtesting

- 50 known rugs
- 50 non-rug volatile tokens
- Tune threshold

Target: - False Positive \< 10% - True Rug Detection \> 85%

---

## Version

v1 --- Rule Engine\
v2 --- Hybrid ML\
v3 --- On-chain behavioral engine

Build v1. Deploy. Log. Iterate.
