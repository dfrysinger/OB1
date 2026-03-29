// scripts/daily-status.ts
//
// Pipeline status notifications. Accepts a --mode argument:
//   kickoff        — 12pm wake-up with today's targets and suggested jobs
//   checkin        — 6pm progress update
//   warning        — 11pm urgency alert (only sends if 50%+ of any track remains)
//   scorecard      — 1am final totals, streaks, trends
//   weekly-summary — Sunday 10am list of previous week's applications
//
// Sends to both Slack and email (Gmail SMTP).

import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSlackMessage, getCaptureChannel } from "../lib/slack.ts";
import { sendEmail } from "../lib/email.ts";
import { fetchPipelineStats, fetchWeeklySummary } from "../lib/pipeline-stats.ts";
import {
  formatKickoff,
  formatCheckin,
  formatWarning,
  formatScorecard,
  formatWeeklySummary,
  shouldSendWarning,
} from "../lib/status-messages.ts";
import { readCredential } from "../lib/credentials.ts";

async function getSupabaseClient() {
  const url = await readCredential("Open Brain - Supabase", "project_url");
  const key = await readCredential("Open Brain - Supabase", "service_role_key");
  return createClient(url, key);
}

// --- Parse --mode argument ---
function getMode(): string {
  const idx = Deno.args.indexOf("--mode");
  if (idx === -1 || idx + 1 >= Deno.args.length) {
    throw new Error("Usage: daily-status.ts --mode <kickoff|checkin|warning|scorecard|weekly-summary>");
  }
  const mode = Deno.args[idx + 1];
  if (!["kickoff", "checkin", "warning", "scorecard", "weekly-summary"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}. Must be one of: kickoff, checkin, warning, scorecard, weekly-summary`);
  }
  return mode;
}

// --- Write today's stats to daily_stats table (called at scorecard time) ---
async function persistDailyStats(supabase: ReturnType<typeof createClient>, stats: Awaited<ReturnType<typeof fetchPipelineStats>>): Promise<void> {
  for (const t of stats.tracks) {
    const { error } = await supabase
      .from("daily_stats")
      .upsert(
        {
          date: stats.today,
          track: t.track,
          completed: t.completedToday,
          target: t.target,
          deficit: t.deficit,
        },
        { onConflict: "date,track" }
      );
    if (error) {
      throw new Error(`daily_stats upsert failed for ${t.track}: ${error.message}`);
    }
  }
}

// --- Main ---
async function main() {
  const mode = getMode();
  console.log(`[${new Date().toISOString()}] daily-status running in mode: ${mode}`);

  const supabase = await getSupabaseClient();
  const channel = await getCaptureChannel();

  let payload: { slack: string; email: { subject: string; html: string } } | null = null;

  if (mode === "weekly-summary") {
    const fromIdx = Deno.args.indexOf("--from");
    const toIdx = Deno.args.indexOf("--to");
    const fromDate = fromIdx !== -1 ? Deno.args[fromIdx + 1] : undefined;
    const toDate = toIdx !== -1 ? Deno.args[toIdx + 1] : undefined;
    const summary = await fetchWeeklySummary(supabase, { from: fromDate, to: toDate });
    payload = formatWeeklySummary(summary);
  } else {
    const stats = await fetchPipelineStats(supabase);

    if (mode === "kickoff") {
      payload = formatKickoff(stats);
    } else if (mode === "checkin") {
      payload = formatCheckin(stats);
    } else if (mode === "warning") {
      if (!shouldSendWarning(stats)) {
        console.log("No tracks are 50%+ remaining. Skipping warning message.");
        return;
      }
      payload = formatWarning(stats);
    } else if (mode === "scorecard") {
      payload = formatScorecard(stats);
      await persistDailyStats(supabase, stats);
    }
  }

  if (!payload) {
    throw new Error(`No payload generated for mode: ${mode}. This is a bug in the dispatch logic.`);
  }

  let slackOk = false;
  let emailOk = false;

  // Send Slack
  try {
    await sendSlackMessage(channel, payload.slack);
    console.log("Slack message sent.");
    slackOk = true;
  } catch (err) {
    console.error("Slack send failed:", err);
  }

  // Send email
  try {
    const emailOpts: { subject: string; html: string; to?: string } = {
      subject: payload.email.subject,
      html: payload.email.html,
    };
    if (mode === "weekly-summary") {
      emailOpts.to = "daniel@frysinger.net, cheryl.loeffler@gmail.com";
    }
    await sendEmail(emailOpts);
    console.log("Email sent.");
    emailOk = true;
  } catch (err) {
    console.error("Email send failed:", err);
  }

  if (!slackOk && !emailOk) {
    console.error("FATAL: Both Slack and email delivery failed. No notification was sent.");
    Deno.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
