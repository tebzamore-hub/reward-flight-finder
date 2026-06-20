#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";

const SEATS_AERO_KEY       = process.env.SEATS_AERO_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SEATS_API  = "https://seats.aero/partnerapi";
const BATCH_SIZE = 500;

const ALL_SOURCES = [
  "american", "qatar", "virginatlantic", "flyingblue",
  "aeroplan", "united", "delta", "alaska",
  "singaporeair", "emirates", "velocity", "turkish", "jetblue", "cathay",
];

const args      = process.argv.slice(2);
const DRY_RUN   = args.includes("--dry-run");
const sourceArg = args.find(a => a.startsWith("--sources="));
const SOURCES   = sourceArg
  ? sourceArg.replace("--sources=", "").split(",").map(s => s.trim())
  : ALL_SOURCES;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function log(msg, level = "info") {
  const prefix = { info: "ℹ", ok: "✓", err: "✗", warn: "⚠" }[level] || "·";
  console.log(`[${new Date().toISOString()}] ${prefix} ${msg}`);
}

async function fetchAvailability(source) {
  log(`Fetching ${source}…`);
  const params = new URLSearchParams({ source, take: "1000" });
  const resp = await fetch(`${SEATS_API}/availability?${params}`, {
    headers: { "Partner-Authorization": SEATS_AERO_KEY },
  });
  if (!resp.ok) throw new Error(`seats.aero ${resp.status}: ${await resp.text()}`);
  const remaining = resp.headers.get("X-RateLimit-Remaining");
  if (remaining) log(`API calls remaining today: ${remaining}`);
  const data = await resp.json();
  log(`${(data.data||[]).length} records for ${source}`, "ok");
  return data.data || [];
}

function transform(r, source) {
  return {
    id:                 r.ID,
    source,
    origin:             r.Route?.OriginAirport      || "",
    destination:        r.Route?.DestinationAirport || "",
    origin_region:      r.Route?.OriginRegion       || "",
    destination_region: r.Route?.DestinationRegion  || "",
    distance_mi:        r.Route?.Distance           || null,
    date:               r.Date                      || null,
    y_available: r.YAvailable || false,
    y_miles:     r.YAvailable ? (parseInt(r.YMileageCost) || null) : null,
    y_seats:     r.YRemainingSeats || null,
    y_airlines:  r.YAirlines || null,
    y_direct:    r.YDirect   || false,
    w_available: r.WAvailable || false,
    w_miles:     r.WAvailable ? (parseInt(r.WMileageCost) || null) : null,
    w_seats:     r.WRemainingSeats || null,
    w_airlines:  r.WAirlines || null,
    w_direct:    r.WDirect   || false,
    j_available: r.JAvailable || false,
    j_miles:     r.JAvailable ? (parseInt(r.JMileageCost) || null) : null,
    j_seats:     r.JRemainingSeats || null,
    j_airlines:  r.JAirlines || null,
    j_direct:    r.JDirect   || false,
    f_available: r.FAvailable || false,
    f_miles:     r.FAvailable ? (parseInt(r.FMileageCost) || null) : null,
    f_seats:     r.FRemainingSeats || null,
    f_airlines:  r.FAirlines || null,
    f_direct:    r.FDirect   || false,
    seats_updated_at: r.UpdatedAt || null,
    cached_at:        new Date().toISOString(),
  };
}

async function upsertAll(rows) {
  if (DRY_RUN) { log(`[DRY RUN] Would upsert ${rows.length} rows`); return rows.length; }
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { error } = await supabase
      .from("reward_availability")
      .upsert(rows.slice(i, i + BATCH_SIZE), { onConflict: "id" });
    if (error) throw new Error(`Supabase upsert: ${error.message}`);
    total += Math.min(BATCH_SIZE, rows.length - i);
    log(`  Upserted ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length}`);
  }
  return total;
}

async function deleteStale() {
  if (DRY_RUN) { log("[DRY RUN] Would delete stale rows"); return 0; }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { count, error } = await supabase
    .from("reward_availability")
    .delete({ count: "exact" })
    .lt("date", yesterday.toISOString().split("T")[0]);
  if (error) throw new Error(`Delete stale: ${error.message}`);
  log(`Deleted ${count || 0} stale rows`, "ok");
  return count || 0;
}

async function startLog(sources) {
  if (DRY_RUN) return null;
  const { data, error } = await supabase
    .from("refresh_log").insert({ sources, status: "running" }).select("id").single();
  if (error) { log(`Refresh log error: ${error.message}`, "warn"); return null; }
  return data.id;
}

async function finishLog(id, { rowsUpserted, rowsDeleted, status, errorMsg }) {
  if (!id || DRY_RUN) return;
  await supabase.from("refresh_log").update({
    finished_at: new Date().toISOString(),
    rows_upserted: rowsUpserted,
    rows_deleted:  rowsDeleted,
    status,
    error_msg: errorMsg || null,
  }).eq("id", id);
}

async function main() {
  log("=== Reward Flight Refresh ===");
  log(`Sources: ${SOURCES.join(", ")}`);
  if (!SEATS_AERO_KEY)       { log("Missing SEATS_AERO_KEY", "err"); process.exit(1); }
  if (!SUPABASE_URL)         { log("Missing SUPABASE_URL", "err"); process.exit(1); }
  if (!SUPABASE_SERVICE_KEY) { log("Missing SUPABASE_SERVICE_KEY", "err"); process.exit(1); }

  const logId = await startLog(SOURCES);
  let totalUpserted = 0, totalDeleted = 0, hasError = false, errorMsg = "";

  for (const source of SOURCES) {
    try {
      const raw  = await fetchAvailability(source);
      const rows = raw.map(r => transform(r, source)).filter(r => r.id && r.date);
      totalUpserted += await upsertAll(rows);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      log(`Error for ${source}: ${e.message}`, "err");
      hasError = true; errorMsg += `${source}: ${e.message}\n`;
    }
  }

  try { totalDeleted = await deleteStale(); } catch(e) { log(e.message, "warn"); }

  await finishLog(logId, {
    rowsUpserted: totalUpserted, rowsDeleted: totalDeleted,
    status: hasError ? "error" : "success", errorMsg,
  });

  log(`=== Done: ${totalUpserted} upserted, ${totalDeleted} deleted ===`, "ok");
  if (hasError) process.exit(1);
}

main().catch(e => { log(e.message, "err"); process.exit(1); });