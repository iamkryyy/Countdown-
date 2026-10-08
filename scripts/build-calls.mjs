// Builds calls/data.json for the Today's Calls widget.
// Runs in GitHub Actions. Secrets: ICAL_URL, NOTION_TOKEN, FATHOM_API_KEY,
// ANTHROPIC_API_KEY, CALLS_KEY. Never logs secrets or client content.
import ical from "node-ical";
import { webcrypto, createHash } from "node:crypto";
import fs from "node:fs";

const ENV = process.env;
const TZ = "America/Chicago";
const ME = (ENV.MY_EMAIL || "kry@verifiedfitnessclub.com").toLowerCase();
const CLIENT_DB = "20bfdff30a2180778496cd970fef718f";
const OUT = ENV.OUT_PATH || "calls/data.json";
const HASH = ENV.HASH_PATH || "calls/data.hash";
const MODEL = ENV.CLAUDE_MODEL || "claude-sonnet-5-5";
const DEFAULT_MIN = 45;

const log = (...a) => console.log("[calls]", ...a);

// ---------- dates ----------
const dayKey = (d) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const label = (d) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);

// ---------- calendar ----------
function attendeesOf(ev) {
  const raw = ev.attendee ? (Array.isArray(ev.attendee) ? ev.attendee : [ev.attendee]) : [];
  return raw.map((a) => {
    const val = typeof a === "string" ? a : a.val || "";
    const p = (typeof a === "object" && a.params) || {};
    return { email: val.replace(/^mailto:/i, "").trim().toLowerCase(), cn: p.CN || "", status: (p.PARTSTAT || "").toUpperCase() };
  }).filter((a) => a.email.includes("@"));
}

function occurrencesToday(ev, today) {
  const out = [];
  const dur = ev.end && ev.start ? new Date(ev.end) - new Date(ev.start) : DEFAULT_MIN * 60000;
  if (ev.rrule) {
    const from = new Date(Date.now() - 2 * 864e5), to = new Date(Date.now() + 2 * 864e5);
    for (const d of ev.rrule.between(from, to, true)) {
      const key = d.toISOString().slice(0, 10);
      if (ev.exdate && Object.keys(ev.exdate).some((k) => k.startsWith(key))) continue;
      const over = ev.recurrences && Object.entries(ev.recurrences).find(([k]) => k.startsWith(key));
      const inst = over ? over[1] : { ...ev, start: d, end: new Date(d.getTime() + dur) };
      if (dayKey(new Date(inst.start)) === today) out.push(inst);
    }
  } else if (ev.start && dayKey(new Date(ev.start)) === today) {
    out.push(ev);
  }
  return out;
}

function todaysCalls(parsed, today) {
  const calls = [];
  for (const ev of Object.values(parsed)) {
    if (!ev || ev.type !== "VEVENT") continue;
    for (const inst of occurrencesToday(ev, today)) {
      if (inst.datetype === "date") continue; // all-day
      const summary = String(inst.summary || "");
      if ((inst.status || "").toUpperCase() === "CANCELLED" || /^cancel/i.test(summary)) continue;
      const att = attendeesOf(inst);
      if (att.find((a) => a.email === ME && a.status === "DECLINED")) continue;
      const guests = att.filter((a) => a.email !== ME && a.status !== "DECLINED");
      if (!guests.length) continue;
      calls.push({
        start: new Date(inst.start).toISOString(),
        end: inst.end ? new Date(inst.end).toISOString() : null,
        summary,
        description: String(inst.description || ""),
        guest: guests[0],
      });
    }
  }
  const seen = new Set();
  return calls
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .filter((c) => { const k = c.start + c.guest.email; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Google Apps Script feed (JSON) -> same shape node-ical produces.
const GUEST_STATUS = { YES: "ACCEPTED", OWNER: "ACCEPTED", NO: "DECLINED", MAYBE: "TENTATIVE", INVITED: "NEEDS-ACTION" };
function fromScriptFeed(text) {
  const j = JSON.parse(text);
  if (j.error) throw new Error("Calendar script refused the request: " + j.error);
  const out = {};
  (j.events || []).forEach((ev, i) => {
    const att = (ev.guests || []).map((g) => ({ val: "mailto:" + g.email, params: { PARTSTAT: GUEST_STATUS[g.status] || "NEEDS-ACTION" } }));
    if (ev.myStatus === "NO") att.push({ val: "mailto:" + ME, params: { PARTSTAT: "DECLINED" } });
    out["e" + i] = {
      type: "VEVENT", summary: ev.title || "", description: ev.description || "",
      start: new Date(ev.start), end: new Date(ev.end), datetype: ev.allDay ? "date" : "date-time",
      attendee: att.length ? att : undefined,
    };
  });
  return out;
}

// ---------- notion ----------
async function notion(path, method = "GET", body) {
  const r = await fetch("https://api.notion.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + ENV.NOTION_TOKEN.trim(), "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Notion ${method} ${path} -> ${r.status}`);
  return r.json();
}
const plain = (rt) => (rt || []).map((t) => t.plain_text || "").join("");

async function findClient(email) {
  const j = await notion(`/databases/${CLIENT_DB}/query`, "POST", {
    filter: { property: "Email", email: { equals: email } }, page_size: 5,
  });
  const page = (j.results || [])[0];
  if (!page) return null;
  const p = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    name: plain(p["Client"]?.title).trim(),
    movers: plain(p["Next Call Needle Movers"]?.rich_text),
    recording: p["Last Call Recording"]?.url || "",
  };
}

async function saveMovers(pageId, movers, recordingUrl, recordedAt) {
  await notion(`/pages/${pageId}`, "PATCH", {
    properties: {
      "Next Call Needle Movers": { rich_text: [{ text: { content: movers.map((m, i) => `${i + 1}. ${m}`).join("\n").slice(0, 1990) } }] },
      "Last Call Recording": { url: recordingUrl || null },
      "Needle Movers Updated": { date: { start: recordedAt.slice(0, 10) } },
    },
  });
}

const parseMovers = (txt) =>
  String(txt || "").split(/\n+/).map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean).slice(0, 4);

// ---------- fathom ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastFathom = 0;
async function fathomGet(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = 1500 - (Date.now() - lastFathom);
    if (wait > 0) await sleep(wait);
    lastFathom = Date.now();
    const r = await fetch(url, { headers: { "X-Api-Key": ENV.FATHOM_API_KEY.trim() } });
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after")) || 20 * (attempt + 1);
      log(`Fathom asked to slow down; waiting ${Math.min(ra, 65)}s`);
      await sleep(Math.min(ra, 65) * 1000);
      continue;
    }
    if (!r.ok) throw new Error("Fathom: HTTP " + r.status);
    const text = await r.text();
    if (!text.trim()) throw new Error("Fathom: empty reply");
    try { return JSON.parse(text); } catch { throw new Error("Fathom: reply was not JSON (" + text.length + " chars)"); }
  }
  throw new Error("Fathom: still rate-limited after retries");
}
// Fathom's list endpoint does not reliably filter by invitee, so fetch recent
// meetings once per run and match each client locally. Never use a call that
// doesn't clearly include the client.
let meetingCache = null;
async function recentMeetings() {
  if (meetingCache) return meetingCache;
  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const all = [];
  let cursor = null;
  for (let page = 0; page < 15; page++) {
    const q = new URLSearchParams({ created_after: since, include_summary: "true", include_action_items: "true" });
    if (cursor) q.set("cursor", cursor);
    const j = await fathomGet("https://api.fathom.ai/external/v1/meetings?" + q);
    all.push(...(j.items || j.meetings || []));
    cursor = j.next_cursor;
    if (!cursor) break;
  }
  log(`Fathom: ${all.length} recent meetings loaded`);
  meetingCache = all;
  return all;
}
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9@.]+/g, " ").trim();
function meetingIncludes(m, email, name) {
  const inv = m.calendar_invitees || m.invitees || [];
  const em = email.toLowerCase();
  if (inv.some((i) => String(i.email || "").toLowerCase() === em)) return true;
  const n = norm(name);
  if (n.split(" ").length < 2) return false; // need a full name to match safely
  if (inv.some((i) => norm(i.name) === n)) return true;
  return norm(m.title || m.meeting_title).includes(n);
}
async function lastFathomCall(email, name, before) {
  const meetings = await recentMeetings();
  let best = null;
  for (const m of meetings) {
    const when = m.recording_start_time || m.scheduled_start_time || m.created_at;
    if (!when || new Date(when) >= new Date(before)) continue;
    if (/group call/i.test(m.title || m.meeting_title || "")) continue;
    if (!meetingIncludes(m, email, name)) continue;
    if (!best || new Date(when) > new Date(best.when)) best = { ...m, when };
  }
  if (!best) return null;
  const summary = best.default_summary?.markdown_formatted || best.summary?.markdown_formatted || best.summary || "";
  if (!String(summary).trim() && !(best.action_items || []).length) throw new Error("Fathom: last call has no summary or action items yet");
  const actions = (best.action_items || []).map((a) => a.description || a.text || "").filter(Boolean);
  return { url: best.share_url || best.url || "", urls: [best.share_url, best.url].filter(Boolean), when: best.when, title: best.title || best.meeting_title || "", summary: String(summary), actions };
}

// ---------- claude ----------
async function makeMovers(name, call, formNotes) {
  const prompt = `You prep Kyle (KRY), a 1% Academy coach, for his next 1-on-1 with ${name}.
Below is the summary of their LAST call. Write the 4 highest-leverage things Kyle must follow up on, most important first.
Prioritize: new Power List rules, deliverables with deadlines, numbers (PCR %, weight, targets, money), and anything the client committed to.
Style: direct, specific, phrased as a follow-up check, max 140 characters each. Example: "VSL: was the Loom draft sent? If not, why, and what's the new deadline?"
${formNotes ? `\nThe client also wrote this when booking today's call (use it if relevant):\n${formNotes}\n` : ""}
Return ONLY a JSON array of exactly 4 strings. No other text.

LAST CALL (${call.when.slice(0, 10)}): ${call.title}
SUMMARY:
${call.summary.slice(0, 12000)}
ACTION ITEMS:
${call.actions.join("\n").slice(0, 3000)}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ENV.ANTHROPIC_API_KEY.trim(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error("Claude: HTTP " + r.status + " " + (await r.text()).slice(0, 160));
  const j = await r.json();
  const text = (j.content || []).map((c) => c.text || "").join("").replace(/```json|```/g, "").trim();
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b < a) throw new Error(`Claude: reply had no list (stop: ${j.stop_reason}, ${text.length} chars)`);
  let arr;
  try { arr = JSON.parse(text.slice(a, b + 1)); } catch { throw new Error("Claude: list was not valid JSON"); }
  if (!Array.isArray(arr) || !arr.length) throw new Error("Claude: empty list");
  return arr.slice(0, 4).map((s) => String(s).trim());
}

// ---------- calendly form ----------
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
function formAnswers(desc) {
  const out = [];
  for (const line of decode(desc).split(/\n+/)) {
    const m = line.match(/^(.{6,260}?[?)])\s*:\s*(.+)$/) || line.match(/^(.{3,120}?)\s*:\s*(.+)$/);
    if (!m) continue;
    const q = m[1].trim(), a = m[2].trim();
    if (/^(location|event name|need to make changes|cancel|reschedule|powered by|https?)/i.test(q) || /^https?:/i.test(a)) continue;
    out.push({ q, a });
  }
  return out;
}
const pick = (ans, re) => ans.find((x) => re.test(x.q))?.a;

function salesMovers(desc) {
  const ans = formAnswers(desc);
  const items = [
    pick(ans, /improve|area/i) && `Focus area: ${pick(ans, /improve|area/i)}`,
    pick(ans, /budget/i) && `Budget: ${pick(ans, /budget/i)}`,
    pick(ans, /start/i) && `Wants to start: ${pick(ans, /start/i)}`,
    [pick(ans, /how long|seen my content/i) && `Watching ${pick(ans, /how long|seen my content/i)}`,
     pick(ans, /city|state/i), pick(ans, /instagram/i) && `IG @${pick(ans, /instagram/i).replace(/^@/, "")}`]
      .filter(Boolean).join(" · "),
  ].filter(Boolean);
  return items.length ? items : ["New lead: no booking answers found. Review the invite before the call."];
}
function clientFormNotes(desc) {
  return formAnswers(desc).filter((x) => !/^phone|^city|^instagram/i.test(x.q)).map((x) => `${x.q}: ${x.a}`).join("\n").slice(0, 1500);
}
function nameFromSummary(summary, guest) {
  const s = summary.replace(/^(call\s*\d+|ob\s*\d*|final call)\s*\|\s*/i, "")
    .replace(/\s*(and|&|x)\s*kry\.?\s*$/i, "").replace(/^kry\.?\s*(and|&|x)\s*/i, "").trim();
  const n = s && !/kry/i.test(s) ? s : guest.cn || guest.email.split("@")[0];
  return n.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- encryption ----------
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
async function encrypt(obj) {
  const raw = fromB64u(ENV.CALLS_KEY.trim().replace(/^k=/, ""));
  if (raw.length !== 32) throw new Error(`CALLS_KEY is the wrong value (decodes to ${raw.length} bytes, expected 32). Re-paste it exactly.`);
  const key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: b64u(iv), ct: b64u(ct) };
}

// ---------- main ----------
async function main() {
  for (const k of ["ICAL_URL", "NOTION_TOKEN", "CALLS_KEY"]) if (!ENV[k]) throw new Error(`Missing secret ${k}`);
  const now = new Date(), today = dayKey(now);
  if (fromB64u(ENV.CALLS_KEY.trim().replace(/^k=/, "")).length !== 32) throw new Error("CALLS_KEY is the wrong value. Re-paste it exactly from the setup instructions.");

  const icsRes = await fetch(ENV.ICAL_URL.trim());
  if (!icsRes.ok) throw new Error("Calendar feed -> " + icsRes.status);
  const feedText = await icsRes.text();
  const parsed = feedText.trim().startsWith("{") ? fromScriptFeed(feedText) : ical.sync.parseICS(feedText);
  const all = Object.values(parsed).filter((e) => e && e.type === "VEVENT");
  const todayAll = all.flatMap((e) => occurrencesToday(e, today));
  log(`feed: ${all.length} events total, ${all.filter((e) => e.attendee).length} with guest lists, ` +
      `${all.filter((e) => /^busy$/i.test(String(e.summary || "").trim())).length} titled "Busy", ` +
      `${all.filter((e) => e.description).length} with descriptions; today: ${todayAll.length} events, ` +
      `${todayAll.filter((e) => e.attendee).length} with guests`);
  const events = todaysCalls(parsed, today);
  log(`${events.length} call(s) on ${today}`);
  const busyOnly = all.length > 10 && all.every((e) => /^busy$/i.test(String(e.summary || "").trim()));
  if (!events.length && (busyOnly || (all.length > 20 && !all.some((e) => e.attendee)))) {
    throw new Error("Calendar feed only shows free/busy, not event details. Leaving the widget unchanged.");
  }

  const calls = [];
  for (const ev of events) {
    const out = { start: ev.start, end: ev.end, name: "", type: "1-on-1", url: "", movers: [] };
    try {
      const client = await findClient(ev.guest.email);
      if (!client) {
        out.type = "Sales";
        out.name = nameFromSummary(ev.summary, ev.guest);
        out.movers = salesMovers(ev.description);
      } else {
        out.name = client.name || nameFromSummary(ev.summary, ev.guest);
        out.url = client.url;
        out.movers = parseMovers(client.movers);
        if (ENV.FATHOM_API_KEY && ENV.ANTHROPIC_API_KEY) {
          try {
            const last = await lastFathomCall(ev.guest.email, out.name, ev.start);
            if (last && last.url && !last.urls.includes(client.recording)) {
              out.movers = await makeMovers(out.name, last, clientFormNotes(ev.description));
              await saveMovers(client.id, out.movers, last.url, last.when);
              log("refreshed needle movers for one client");
            }
          } catch (e) { log("needle mover refresh skipped:", e.message); }
        }
        if (!out.movers.length) out.movers = ["No needle movers yet: no recorded call found in Fathom for this client."];
      }
    } catch (e) {
      log("lookup failed:", e.message);
      out.name = out.name || nameFromSummary(ev.summary, ev.guest);
      if (!out.movers.length) out.movers = ["Couldn't load prep for this call. Check the run log."];
    }
    calls.push(out);
  }

  const payload = { date: today, calls };
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const prev = fs.existsSync(HASH) ? fs.readFileSync(HASH, "utf8").trim() : "";
  if (prev === hash) { log("no change"); return; }
  const box = await encrypt({ ...payload, updated: label(now) });
  fs.writeFileSync(OUT, JSON.stringify(box));
  fs.writeFileSync(HASH, hash + "\n");
  log("data.json updated");
}

main().catch((e) => { console.error("[calls] FAILED:", e.message); process.exit(1); });
