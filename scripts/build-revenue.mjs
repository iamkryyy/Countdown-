// Builds revenue/data.json for the Monthly Revenue widget.
// Gross revenue = what clients paid this month (Central time), before fees/refunds.
//   Stripe: succeeded charges, read live from the Stripe API.
//   Commas: rows in the Notion Transactions Log (written by the Commas -> Notion Zap).
// Secrets: STRIPE_API_KEY (restricted, read-only), NOTION_TOKEN, CALLS_KEY.
// Logs only counts and totals' presence, never client names or amounts.
import { webcrypto, createHash } from "node:crypto";
import fs from "node:fs";

const ENV = process.env;
const TZ = "America/Chicago";
const GOAL = Number(ENV.REVENUE_GOAL || 100000);
const TX_DB = "348fdff30a2183e6810f81c42b3855f6";
const OUT = ENV.OUT_PATH || "revenue/data.json";
const HASH = ENV.HASH_PATH || "revenue/data.hash";
const log = (...a) => console.log("[revenue]", ...a);

// ---------- time (Central) ----------
const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
}).formatToParts(d).map((p) => [p.type, p.value]));
function centralMidnight(y, m, d) { // UTC ms of 00:00 Central on y-m-d
  const guess = Date.UTC(y, m - 1, d, 6);
  const p = parts(new Date(guess));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - guess;
  return Date.UTC(y, m - 1, d) - offset;
}
const ymd = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const label = (d) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);

// ---------- stripe ----------
async function stripeTotals(monthStartMs, todayStartMs) {
  const key = (ENV.STRIPE_API_KEY || "").trim();
  if (!key) throw new Error("Stripe: missing STRIPE_API_KEY");
  let month = 0, today = 0, count = 0, skipped = 0, after = null;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: "100", "created[gte]": String(Math.floor(monthStartMs / 1000)) });
    if (after) q.set("starting_after", after);
    const r = await fetch("https://api.stripe.com/v1/charges?" + q, { headers: { Authorization: "Bearer " + key } });
    if (!r.ok) throw new Error("Stripe: HTTP " + r.status + (r.status === 401 ? " (key rejected)" : r.status === 403 ? " (key lacks Charges: Read)" : ""));
    const j = await r.json();
    for (const c of j.data || []) {
      if (c.status !== "succeeded" || !c.paid) continue;
      if ((c.currency || "usd").toLowerCase() !== "usd") { skipped++; continue; }
      const cents = c.amount_captured ?? c.amount ?? 0;
      month += cents; count++;
      if (c.created * 1000 >= todayStartMs) today += cents;
    }
    if (!j.has_more || !(j.data || []).length) break;
    after = j.data[j.data.length - 1].id;
  }
  if (skipped) log(`Stripe: skipped ${skipped} non-USD charge(s)`);
  log(`Stripe: ${count} paid charge(s) this month`);
  return { month: month / 100, today: today / 100 };
}

// ---------- commas (via Notion Transactions Log) ----------
async function commasTotals(monthStartDate, todayDate) {
  const token = (ENV.NOTION_TOKEN || "").trim();
  let month = 0, today = 0, count = 0, cursor;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const body = {
      page_size: 100,
      filter: { and: [
        { or: [{ property: "Processor", select: { equals: "Commas" } }, { property: "Processor", select: { equals: "FanBasis" } }] },
        { property: "Paid On", date: { on_or_after: monthStartDate } },
      ] },
    };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${TX_DB}/query`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("Notion: HTTP " + r.status + (r.status === 404 ? " (connect the Today's Calls integration to the Revenue Command Center page)" : ""));
    const j = await r.json();
    for (const row of j.results || []) {
      const p = row.properties || {};
      const type = p["Payment Type"]?.select?.name || "";
      if (/refund|chargeback/i.test(type)) continue;
      const id = (p["Charge ID"]?.rich_text || []).map((t) => t.plain_text).join("").trim();
      if (id) { if (seen.has(id)) continue; seen.add(id); }
      const amt = Number(p["Amount"]?.number || 0);
      const paid = (p["Paid On"]?.date?.start || "").slice(0, 10);
      if (!amt || !paid) continue;
      // Paid On may be a datetime; judge "today" in Central time.
      const paidDay = p["Paid On"].date.start.length > 10 ? ymd(new Date(p["Paid On"].date.start)) : paid;
      month += amt; count++;
      if (paidDay === todayDate) today += amt;
    }
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  log(`Commas: ${count} sale(s) this month`);
  return { month, today };
}

// ---------- encryption (same key as the calls widget) ----------
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
async function encrypt(obj) {
  const raw = fromB64u((ENV.CALLS_KEY || "").trim().replace(/^k=/, ""));
  if (raw.length !== 32) throw new Error("CALLS_KEY is the wrong value.");
  const key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: b64u(iv), ct: b64u(ct) };
}

// ---------- main ----------
async function main() {
  const now = new Date();
  const p = parts(now);
  const monthKey = `${p.year}-${p.month}`;
  const monthStartDate = `${monthKey}-01`;
  const todayDate = `${p.year}-${p.month}-${p.day}`;
  const monthStartMs = centralMidnight(+p.year, +p.month, 1);
  const todayStartMs = centralMidnight(+p.year, +p.month, +p.day);

  const out = { month: monthKey, goal: GOAL, today: todayDate, stripe: null, commas: null };
  const errors = [];
  try { out.stripe = await stripeTotals(monthStartMs, todayStartMs); } catch (e) { errors.push(e.message); }
  try { out.commas = await commasTotals(monthStartDate, todayDate); } catch (e) { errors.push(e.message); }
  errors.forEach((e) => log("problem:", e));
  if (!out.stripe && !out.commas) throw new Error("Both sources failed. Leaving the widget unchanged.");

  out.mtd = Math.round(((out.stripe?.month || 0) + (out.commas?.month || 0)) * 100) / 100;
  out.todayTotal = Math.round(((out.stripe?.today || 0) + (out.commas?.today || 0)) * 100) / 100;
  out.partial = errors.length ? (out.stripe ? "Commas" : "Stripe") : "";

  const hash = createHash("sha256").update(JSON.stringify(out)).digest("hex");
  const prev = fs.existsSync(HASH) ? fs.readFileSync(HASH, "utf8").trim() : "";
  if (prev === hash) { log("no change"); return; }
  fs.mkdirSync(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(await encrypt({ ...out, updated: label(now) })));
  fs.writeFileSync(HASH, hash + "\n");
  log("data.json updated" + (out.partial ? ` (${out.partial} missing this run)` : ""));
}

main().catch((e) => { console.error("[revenue] FAILED:", e.message); process.exit(1); });
