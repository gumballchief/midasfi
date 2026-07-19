"use strict";

/**
 * Build the recipient list from ON-CHAIN data, not a hand-typed file.
 *
 * Used two ways:
 *   - CLI:   TOKEN_CA=0x... node holders.js        (writes recipients.json once)
 *   - Auto:  airdrop.js calls buildRecipients() at the start of every cycle, so
 *            the list stays current with no manual step.
 *
 * Keeps wallets at/above the threshold, drops contracts (pools, lockers, curves
 * — not people), drops the EXCLUDE list, and by default has NO cap on how many
 * wallets can receive.
 */

const fs = require("fs");
const path = require("path");

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

/**
 * @returns {Promise<{recipients:string[], token:object, dropped:object}>}
 */
async function buildRecipients(opts = {}) {
  const token = (opts.token || process.env.TOKEN_CA || "").trim();
  const threshold = Number(opts.threshold ?? process.env.THRESHOLD ?? 50_000);
  const exclude = new Set(
    (opts.exclude || process.env.EXCLUDE || "").split(",").map(a => a.trim().toLowerCase()).filter(Boolean)
  );
  // 0 or unset means no ceiling — everyone who qualifies is included.
  const max = Number(opts.max ?? process.env.MAX_RECIPIENTS ?? 0);
  const explorer = (opts.explorer || process.env.EXPLORER || "https://robinhoodchain.blockscout.com/api/v2").replace(/\/$/, "");

  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("set TOKEN_CA to the token contract address");

  const tok = await getJSON(`${explorer}/tokens/${token}`);
  if (tok.message === "Not found") throw new Error(`no token at ${token} on this chain`);
  const decimals = BigInt(tok.decimals || 18);
  const thresholdWei = BigInt(threshold) * 10n ** decimals;

  const qualifying = [];
  const dropped = { belowThreshold: 0, contracts: 0, excluded: 0 };
  let url = `${explorer}/tokens/${token}/holders`;

  for (let page = 0; page < 500; page++) {
    const data = await getJSON(url);
    let belowFound = false;
    for (const item of data.items || []) {
      if (BigInt(item.value || "0") < thresholdWei) { dropped.belowThreshold++; belowFound = true; continue; }
      const a = item.address || {};
      const addr = (a.hash || "").toLowerCase();
      if (!addr) continue;
      if (a.is_contract) { dropped.contracts++; continue; }
      if (exclude.has(addr)) { dropped.excluded++; continue; }
      qualifying.push(a.hash);
    }
    if (belowFound || !data.next_page_params) break; // sorted desc: stop at first sub-threshold
    url = `${explorer}/tokens/${token}/holders?${new URLSearchParams(data.next_page_params)}`;
  }

  let recipients = qualifying;
  if (max > 0 && recipients.length > max) recipients = recipients.slice(0, max);
  return { recipients, token: tok, dropped, threshold };
}

/** CLI: write recipients.json and report. */
async function cli() {
  const { recipients, token, dropped, threshold } = await buildRecipients();
  console.log(`token: ${token.name} (${token.symbol})`);
  console.log(`threshold: ${threshold.toLocaleString()} ${token.symbol}`);
  if (recipients.length === 0) throw new Error("zero qualifying wallets — check TOKEN_CA and THRESHOLD");
  fs.writeFileSync(path.join(__dirname, "recipients.json"), JSON.stringify({
    _source: { token: process.env.TOKEN_CA, threshold, generatedAt: new Date().toISOString() },
    recipients,
  }, null, 2));
  console.log(`recipients.json written: ${recipients.length} wallets`);
  console.log(`dropped: ${dropped.belowThreshold} below threshold, ${dropped.contracts} contracts, ${dropped.excluded} excluded`);
}

if (require.main === module) cli().catch(e => { console.error("FAILED:", e.message); process.exit(1); });

module.exports = { buildRecipients };
