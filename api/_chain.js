/**
 * Live-data reader for the Gold site — dependency-free (Vercel static + serverless).
 *
 * The launch runs the airdrop model: Gold trades on Robinhood Chain, and gold
 * (PAXG) is sent to holders from a dedicated wallet on Ethereum. So "real data"
 * comes from two public places, read here with no API key:
 *
 *   - HOLDERS: the Gold token's holder count on Robinhood Chain (Blockscout).
 *   - DISTRIBUTED: every PAXG transfer OUT of the airdrop wallet on Ethereum
 *     (Blockscout) — summed for the total, newest timestamp for the countdown.
 *
 * All three addresses are public; they are constants, not secrets.
 */

const TOKEN_CA = "0x59e026843639c75c95334ad87e8b5df5d03629a0";        // Gold, Robinhood Chain
const AIRDROP_WALLET = "0x3F70109fc5a1B44F03e953760FC97f803929331F"; // sends PAXG, Ethereum
const PAXG = "0x45804880De22913dAFE09f4980848ECE6EcbAf78";           // PAX Gold, Ethereum

const RH = "https://robinhoodchain.blockscout.com/api/v2";
const ETH = "https://eth.blockscout.com/api/v2";
const INTERVAL_MS = 15 * 60 * 1000;

async function getJSON(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Every PAXG transfer OUT of the airdrop wallet, newest first, bounded. */
async function paxgOut(maxPages = 6) {
  const base = `${ETH}/addresses/${AIRDROP_WALLET}/token-transfers?type=ERC-20&filter=from`;
  let url = base;
  const out = [];
  for (let p = 0; p < maxPages; p++) {
    const d = await getJSON(url).catch(() => null);
    if (!d) break;
    for (const i of d.items || []) {
      const tk = i.token || {};
      const addr = (tk.address || tk.address_hash || "").toLowerCase();
      const from = ((i.from || {}).hash || "").toLowerCase();
      if (addr === PAXG.toLowerCase() && from === AIRDROP_WALLET.toLowerCase()) {
        out.push({
          to: (i.to || {}).hash,
          value: BigInt((i.total || {}).value || "0"),
          ts: i.timestamp,
          tx: i.transaction_hash || i.tx_hash,
        });
      }
    }
    if (!d.next_page_params) break;
    url = `${base}&${new URLSearchParams(d.next_page_params)}`;
  }
  return out;
}

function toUnits(wei) {
  const d = 10n ** 18n;
  return Number(wei / d) + Number(wei % d) / Number(d);
}

async function getStats() {
  try {
    const [tok, sends] = await Promise.all([
      getJSON(`${RH}/tokens/${TOKEN_CA}`).catch(() => null),
      paxgOut().catch(() => []),
    ]);

    const holders = tok && (tok.holders || tok.holders_count)
      ? Number(tok.holders || tok.holders_count) : null;

    let total = 0n, lastTs = null;
    const recipients = new Set();
    for (const s of sends) {
      total += s.value;
      recipients.add((s.to || "").toLowerCase());
      if (!lastTs || new Date(s.ts) > new Date(lastTs)) lastTs = s.ts;
    }

    // Persistent countdown anchor: last distribution + 15 min, rolled forward to
    // the next future slot. Derived from chain, so it never resets on reload.
    let nextDistributionMs = null, lastDistributionMs = null;
    if (lastTs) {
      lastDistributionMs = new Date(lastTs).getTime();
      let n = lastDistributionMs + INTERVAL_MS;
      const now = Date.now();
      while (n <= now) n += INTERVAL_MS;
      nextDistributionMs = n;
    }

    return {
      live: true,
      started: sends.length > 0,
      holders,
      goldDistributed: toUnits(total),
      distributions: sends.length,
      recipientsPaid: recipients.size,
      lastDistributionMs,
      nextDistributionMs,
      intervalMs: INTERVAL_MS,
      readAt: new Date().toISOString(),
    };
  } catch (e) {
    return { live: false, reason: "unreachable", error: String(e.message || e) };
  }
}

async function getDistributions(limit = 8) {
  try {
    const sends = await paxgOut(3);
    sends.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    return {
      live: true,
      distributions: sends.slice(0, limit).map((s) => ({
        to: s.to, gold: toUnits(s.value), ts: s.ts, tx: s.tx,
      })),
    };
  } catch (e) {
    return { live: false, reason: "unreachable", error: String(e.message || e), distributions: [] };
  }
}

module.exports = { getStats, getDistributions };
