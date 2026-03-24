// scripts/backfill-daily-stats.ts
//
// One-time script to back-fill daily_stats from attribution_log history.
// Counts the same events as pipeline-stats.ts for each of the last N days.

import { createClient } from "npm:@supabase/supabase-js@2";

const DAYS_BACK = 14;
const BASE_TARGET = 5;

async function readOp(item: string, field: string): Promise<string> {
  const proc = new Deno.Command("bash", {
    args: ["-c", `OP_SERVICE_ACCOUNT_TOKEN=$(textutil -convert txt -stdout ~/1password\\ service.rtf) op item get "${item}" --vault ClawdBot --fields label=${field} --reveal`],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`1Password lookup failed for ${item}/${field}: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const url = await readOp("Open Brain - Supabase", "project_url");
  const key = await readOp("Open Brain - Supabase", "service_role_key");
  const supabase = createClient(url, key);

  const today = new Date().toISOString().slice(0, 10);

  const tracks = [
    {
      name: "resume_creation",
      entity_type: "application",
      action: "resume_added",
      reason_pattern: null,
    },
    {
      name: "resume_review",
      entity_type: "application",
      action: "status_changed",
      reason_pattern: "%-> ready%",
    },
    {
      name: "contact_discovery",
      entity_type: "job_posting",
      action: "updated",
      reason_pattern: "%networking_status%researched%",
    },
    {
      name: "outreach",
      entity_type: "job_posting",
      action: "updated",
      reason_pattern: "%networking_status%done%",
    },
    {
      name: "application_submission",
      entity_type: "application",
      action: "status_changed",
      reason_pattern: "%-> applied%",
    },
  ];

  let inserted = 0;
  let skipped = 0;

  for (let d = DAYS_BACK; d >= 0; d--) {
    const date = offsetDate(today, -d);
    const dayStart = `${date}T00:00:00Z`;
    const dayEnd = `${date}T23:59:59Z`;

    for (const track of tracks) {
      let query = supabase
        .from("attribution_log")
        .select("*", { count: "exact", head: true })
        .eq("entity_type", track.entity_type)
        .eq("action", track.action)
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd);

      if (track.reason_pattern) {
        query = query.ilike("reason", track.reason_pattern);
      }

      const { count, error } = await query;
      if (error) {
        console.error(`Query failed for ${track.name} on ${date}: ${error.message}`);
        continue;
      }

      const completed = count ?? 0;
      const deficit = Math.max(0, BASE_TARGET - completed);

      const { error: upsertErr } = await supabase
        .from("daily_stats")
        .upsert(
          { date, track: track.name, completed, target: BASE_TARGET, deficit },
          { onConflict: "date,track" }
        );

      if (upsertErr) {
        console.error(`Upsert failed for ${track.name} on ${date}: ${upsertErr.message}`);
        continue;
      }

      if (completed > 0) {
        console.log(`${date} ${track.name}: ${completed} completed`);
        inserted++;
      } else {
        skipped++;
      }
    }
  }

  console.log(`Done. ${inserted} rows with activity, ${skipped} rows with 0 completions.`);
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
