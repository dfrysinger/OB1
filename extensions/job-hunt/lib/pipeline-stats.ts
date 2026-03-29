// lib/pipeline-stats.ts
//
// Fetches all data needed by the Daily Status Agent from Supabase.
// No message formatting here — pure data retrieval.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface TrackStats {
  track: string;
  completedToday: number;
  target: number;         // includes rolling deficit
  deficit: number;        // remaining deficit to carry forward
  streak: number;         // consecutive days meeting target
  weeklyAvg: number;      // average completions over last 7 days
  lastWeekAvg: number;    // average completions over the 7 days before that
}

export interface SuggestedJob {
  id: string;
  title: string;
  company: string;
  track: string;
  reason: string;         // e.g. "high priority", "low-hanging network"
}

export interface StaleApplication {
  title: string;
  company: string;
  daysOld: number;
  applicationId: string;
}

export interface StaleQueueItem {
  title: string;
  company: string;
  daysInQueue: number;
  postingAgeDays: number | null;
  postingId: string;
}

export interface PipelineStats {
  tracks: TrackStats[];
  suggested: SuggestedJob[];        // top 5 per track for kickoff message
  staleApplications: StaleApplication[];
  staleQueue: StaleQueueItem[];
  activeInterviews: number;
  applicationsOut: number;
  draftResumes: number;             // postings with resume_path IS NULL and status = 'draft'
  totalDrafts: number;              // all postings in a workable state not yet applied
  currentPace: number;              // average app submissions per day (last 7 days)
  daysToClearBacklog: number | null;
  today: string;                    // ISO date string YYYY-MM-DD
}

export async function fetchPipelineStats(supabase: SupabaseClient): Promise<PipelineStats> {
  const today = new Date().toISOString().slice(0, 10);

  // --- Compute today's counts by track ---
  // Each track counts specific actions from the attribution_log table, which
  // records discrete events (resume added, status changed, etc.) with timestamps.
  // This avoids the overcounting bug where any unrelated update_at change on a
  // row would inflate the daily count.
  //
  // Resume creation: attribution_log "resume_added" on applications today
  // Resume review: attribution_log "status_changed" with reason "-> ready" today
  // Contact discovery: attribution_log "updated" on job_postings with networking_status -> researched
  // Outreach: attribution_log "updated" on job_postings with networking_status -> done
  // Application submission: attribution_log "status_changed" with reason "-> applied" today

  // Load existing daily_stats rows for the last 14 days
  const { data: statsRows, error: statsRowsErr } = await supabase
    .from("daily_stats")
    .select("date, track, completed, target, deficit")
    .gte("date", offsetDate(today, -14))
    .order("date", { ascending: false });
  if (statsRowsErr) throw new Error(`Failed to fetch daily_stats: ${statsRowsErr.message}`);

  const statsMap = new Map<string, typeof statsRows[0]>();
  for (const row of (statsRows ?? [])) {
    statsMap.set(`${row.date}|${row.track}`, row);
  }

  // Live counts for today (each track queries different tables)
  const [
    resumeCreationCount,
    resumeReviewCount,
    contactDiscoveryCount,
    outreachCount,
    submissionCount,
  ] = await Promise.all([
    countResumeCreations(supabase, today),
    countResumeReviews(supabase, today),
    countContactDiscoveries(supabase, today),
    countOutreach(supabase, today),
    countSubmissions(supabase, today),
  ]);

  const liveCounts: Record<string, number> = {
    resume_creation: resumeCreationCount,
    resume_review: resumeReviewCount,
    contact_discovery: contactDiscoveryCount,
    outreach: outreachCount,
    application_submission: submissionCount,
  };

  const TRACKS = [
    "resume_creation",
    "resume_review",
    "contact_discovery",
    "outreach",
    "application_submission",
  ];
  const BASE_TARGET = 5;

  const tracks: TrackStats[] = TRACKS.map((track) => {
    // Yesterday's deficit carries into today's target
    const yesterdayKey = `${offsetDate(today, -1)}|${track}`;
    const yesterday = statsMap.get(yesterdayKey);
    const carryDeficit = yesterday?.deficit ?? 0;
    const target = BASE_TARGET + carryDeficit;

    const completedToday = liveCounts[track] ?? 0;
    const deficit = Math.max(0, target - completedToday);

    // Streak: count consecutive days (going backwards) where deficit was 0
    let streak = 0;
    for (let i = 1; i <= 14; i++) {
      const key = `${offsetDate(today, -i)}|${track}`;
      const row = statsMap.get(key);
      if (!row) break;
      if (row.deficit === 0) streak++;
      else break;
    }

    // Weekly averages
    const last7 = daysRange(today, -1, -7).map(d => statsMap.get(`${d}|${track}`)?.completed ?? 0);
    const prev7 = daysRange(today, -8, -14).map(d => statsMap.get(`${d}|${track}`)?.completed ?? 0);
    const weeklyAvg = avg(last7);
    const lastWeekAvg = avg(prev7);

    return { track, completedToday, target, deficit, streak, weeklyAvg, lastWeekAvg };
  });

  // --- Suggested jobs for each track (kickoff message) ---
  const suggested = await fetchSuggestedJobs(supabase);

  // --- Stale applications (applied 14+ days ago, no response_date) ---
  const staleApplications = await fetchStaleApplications(supabase);

  // --- Stale queue items (draft/ready applications sitting too long) ---
  const staleQueue = await fetchStaleQueue(supabase);

  // --- Win tracking ---
  // Count applications in interviewing or screening status
  const { count: activeInterviews, error: activeInterviewsErr } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .in("status", ["interviewing", "screening"]);
  if (activeInterviewsErr) throw new Error(`Failed to count active interviews: ${activeInterviewsErr.message}`);

  const { count: applicationsOut, error: applicationsOutErr } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .eq("status", "applied");
  if (applicationsOutErr) throw new Error(`Failed to count applications out: ${applicationsOutErr.message}`);

  const { count: draftResumes, error: draftResumesErr } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .eq("status", "draft")
    .is("resume_path", null);
  if (draftResumesErr) throw new Error(`Failed to count draft resumes: ${draftResumesErr.message}`);

  const { count: totalDrafts, error: totalDraftsErr } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .in("status", ["draft", "ready"]);
  if (totalDraftsErr) throw new Error(`Failed to count total drafts: ${totalDraftsErr.message}`);

  // Current pace (app submissions per day, last 7 days)
  const submissionTrackRows = daysRange(today, -1, -7)
    .map(d => statsMap.get(`${d}|application_submission`)?.completed ?? 0);
  const currentPace = avg(submissionTrackRows);

  const daysToClearBacklog = currentPace > 0 && totalDrafts
    ? Math.ceil(totalDrafts / currentPace)
    : null;

  return {
    tracks,
    suggested,
    staleApplications,
    staleQueue,
    activeInterviews: activeInterviews ?? 0,
    applicationsOut: applicationsOut ?? 0,
    draftResumes: draftResumes ?? 0,
    totalDrafts: totalDrafts ?? 0,
    currentPace,
    daysToClearBacklog,
    today,
  };
}

// --- Per-track live count helpers ---
// All helpers query the attribution_log table instead of using updated_at on
// the entity tables. This avoids overcounting when unrelated edits touch a row
// that already met the condition earlier today.

async function countResumeCreations(supabase: SupabaseClient, today: string): Promise<number> {
  // Count attribution_log entries where a resume was added to an application today.
  // Logged by buildUpdateApplicationLogs in handlers.ts with action "resume_added".
  const { count, error } = await supabase
    .from("attribution_log")
    .select("*", { count: "exact", head: true })
    .eq("entity_type", "application")
    .eq("action", "resume_added")
    .gte("created_at", `${today}T00:00:00Z`);
  if (error) throw new Error(`Failed to count resume creations: ${error.message}`);
  return count ?? 0;
}

async function countResumeReviews(supabase: SupabaseClient, today: string): Promise<number> {
  // Count attribution_log entries where an application status changed to "ready" today.
  // Logged by buildUpdateApplicationLogs with action "status_changed" and
  // reason like "draft -> ready".
  const { count, error } = await supabase
    .from("attribution_log")
    .select("*", { count: "exact", head: true })
    .eq("entity_type", "application")
    .eq("action", "status_changed")
    .ilike("reason", "%-> ready%")
    .gte("created_at", `${today}T00:00:00Z`);
  if (error) throw new Error(`Failed to count resume reviews: ${error.message}`);
  return count ?? 0;
}

async function countContactDiscoveries(supabase: SupabaseClient, today: string): Promise<number> {
  // Count attribution_log entries where a job posting's networking_status was
  // changed to "researched" today. The update_job_posting handler logs
  // action "updated" with reason containing the field names or a custom
  // actor_reason describing the change.
  const { count, error } = await supabase
    .from("attribution_log")
    .select("*", { count: "exact", head: true })
    .eq("entity_type", "job_posting")
    .eq("action", "updated")
    .ilike("reason", "%networking_status%researched%")
    .gte("created_at", `${today}T00:00:00Z`);
  if (error) throw new Error(`Failed to count contact discoveries: ${error.message}`);
  return count ?? 0;
}

async function countOutreach(supabase: SupabaseClient, today: string): Promise<number> {
  // Count attribution_log entries where a job posting's networking_status was
  // changed to "done" today, indicating outreach was completed.
  const { count, error } = await supabase
    .from("attribution_log")
    .select("*", { count: "exact", head: true })
    .eq("entity_type", "job_posting")
    .eq("action", "updated")
    .ilike("reason", "%networking_status%done%")
    .gte("created_at", `${today}T00:00:00Z`);
  if (error) throw new Error(`Failed to count outreach: ${error.message}`);
  return count ?? 0;
}

async function countSubmissions(supabase: SupabaseClient, today: string): Promise<number> {
  // Count attribution_log entries where an application status changed to "applied" today.
  // Logged by buildUpdateApplicationLogs with action "status_changed" and
  // reason like "ready -> applied".
  const { count, error } = await supabase
    .from("attribution_log")
    .select("*", { count: "exact", head: true })
    .eq("entity_type", "application")
    .eq("action", "status_changed")
    .ilike("reason", "%-> applied%")
    .gte("created_at", `${today}T00:00:00Z`);
  if (error) throw new Error(`Failed to count submissions: ${error.message}`);
  return count ?? 0;
}

// --- Suggested jobs ---

async function fetchSuggestedJobs(supabase: SupabaseClient): Promise<SuggestedJob[]> {
  const suggested: SuggestedJob[] = [];

  // Resume creation: top 5 draft applications with no resume, by priority
  const { data: noResume, error: noResumeErr } = await supabase
    .from("applications")
    .select("id, job_postings(id, title, companies(name), priority, has_network_connections)")
    .eq("status", "draft")
    .is("resume_path", null)
    .order("created_at", { ascending: true })
    .limit(5);
  if (noResumeErr) throw new Error(`Failed to fetch suggested resume creations: ${noResumeErr.message}`);
  for (const row of (noResume ?? [])) {
    const jp = row.job_postings as Record<string, unknown>;
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: jp?.title as string ?? "Untitled",
      company,
      track: "resume_creation",
      reason: "draft with no resume",
    });
  }

  // Resume review: top 5 draft applications with a resume (awaiting review)
  const { data: needsReview, error: needsReviewErr } = await supabase
    .from("applications")
    .select("id, job_postings(title, companies(name))")
    .eq("status", "draft")
    .not("resume_path", "is", null)
    .limit(5);
  if (needsReviewErr) throw new Error(`Failed to fetch suggested resume reviews: ${needsReviewErr.message}`);
  for (const row of (needsReview ?? [])) {
    const jp = row.job_postings as Record<string, unknown>;
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: jp?.title as string ?? "Untitled",
      company,
      track: "resume_review",
      reason: "draft resume awaiting approval",
    });
  }

  // Contact discovery: postings with has_network_connections = true and status = not_started
  const { data: networkReady, error: networkReadyErr } = await supabase
    .from("job_postings")
    .select("id, title, companies(name)")
    .eq("networking_status", "not_started")
    .eq("has_network_connections", true)
    .limit(5);
  if (networkReadyErr) throw new Error(`Failed to fetch suggested contact discoveries: ${networkReadyErr.message}`);
  for (const row of (networkReady ?? [])) {
    const company = (row.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: row.title ?? "Untitled",
      company,
      track: "contact_discovery",
      reason: "has network connections on LinkedIn",
    });
  }

  // Outreach: postings with networking_status = researched
  const { data: researched, error: researchedErr } = await supabase
    .from("job_postings")
    .select("id, title, companies(name)")
    .eq("networking_status", "researched")
    .limit(5);
  if (researchedErr) throw new Error(`Failed to fetch suggested outreach: ${researchedErr.message}`);
  for (const row of (researched ?? [])) {
    const company = (row.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: row.title ?? "Untitled",
      company,
      track: "outreach",
      reason: "contacts researched, ready to message",
    });
  }

  // Application submission: top 5 'ready' applications
  const { data: readyApps, error: readyAppsErr } = await supabase
    .from("applications")
    .select("id, job_postings(title, companies(name))")
    .eq("status", "ready")
    .limit(5);
  if (readyAppsErr) throw new Error(`Failed to fetch suggested submissions: ${readyAppsErr.message}`);
  for (const row of (readyApps ?? [])) {
    const jp = row.job_postings as Record<string, unknown>;
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: jp?.title as string ?? "Untitled",
      company,
      track: "application_submission",
      reason: "resume approved, ready to submit",
    });
  }

  return suggested;
}

// --- Stale applications ---

async function fetchStaleApplications(supabase: SupabaseClient): Promise<StaleApplication[]> {
  const cutoff = offsetDate(new Date().toISOString().slice(0, 10), -14);
  const { data, error } = await supabase
    .from("applications")
    .select("id, applied_date, job_postings(title, companies(name))")
    .eq("status", "applied")
    .is("response_date", null)
    .lte("applied_date", cutoff)
    .order("applied_date", { ascending: true })
    .limit(5);
  if (error) throw new Error(`Failed to fetch stale applications: ${error.message}`);

  return (data ?? []).map((row) => {
    const jp = row.job_postings as Record<string, unknown>;
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    const daysOld = row.applied_date
      ? Math.floor((Date.now() - new Date(row.applied_date).getTime()) / 86400000)
      : 0;
    return {
      title: jp?.title as string ?? "Untitled",
      company,
      daysOld,
      applicationId: row.id,
    };
  });
}

// --- Stale queue items (jobs sitting in draft/ready too long without applying) ---

async function fetchStaleQueue(supabase: SupabaseClient): Promise<StaleQueueItem[]> {
  const cutoff = offsetDate(new Date().toISOString().slice(0, 10), -7);
  const { data, error } = await supabase
    .from("applications")
    .select("id, created_at, job_postings(id, title, posted_date, companies(name))")
    .in("status", ["draft", "ready"])
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(`Failed to fetch stale queue: ${error.message}`);

  return (data ?? []).map((row) => {
    const jp = row.job_postings as Record<string, unknown>;
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    const daysInQueue = Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000);
    const postedDate = jp?.posted_date as string | null;
    const postingAgeDays = postedDate
      ? Math.floor((Date.now() - new Date(postedDate).getTime()) / 86400000)
      : null;
    return {
      title: jp?.title as string ?? "Untitled",
      company,
      daysInQueue,
      postingAgeDays,
      postingId: jp?.id as string ?? row.id,
    };
  });
}

// --- Weekly application summary ---

export interface WeeklyApplication {
  appliedDate: string;
  company: string;
  title: string;
  url: string;
}

export interface WeeklySummary {
  weekStart: string;
  weekEnd: string;
  applications: WeeklyApplication[];
}

export async function fetchWeeklySummary(
  supabase: SupabaseClient,
  opts?: { from?: string; to?: string },
): Promise<WeeklySummary> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dayOfWeek = today.getDay(); // 0 = Sunday

  const defaultStart = offsetDate(todayStr, -(dayOfWeek + 7));
  const rangeStart = opts?.from ?? defaultStart;
  const rangeEnd = opts?.to ?? (opts?.from ? todayStr : offsetDate(defaultStart, 6));

  const { data, error } = await supabase
    .from("applications")
    .select("applied_date, job_postings(title, url, companies(name))")
    .not("applied_date", "is", null)
    .gte("applied_date", rangeStart)
    .lte("applied_date", rangeEnd)
    .order("applied_date", { ascending: true });

  if (error) throw new Error(`Failed to fetch weekly applications: ${error.message}`);
  if (!data) throw new Error("Supabase returned null data with no error for weekly applications query");

  const applications: WeeklyApplication[] = [];
  let incompleteCount = 0;

  for (const row of data) {
    const jp = row.job_postings as Record<string, unknown>;
    if (!jp) {
      console.warn(`Application row missing job_postings join data (applied_date: ${row.applied_date})`);
      incompleteCount++;
      continue;
    }
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    applications.push({
      appliedDate: row.applied_date as string,
      company,
      title: jp?.title as string ?? "Untitled",
      url: jp?.url as string ?? "",
    });
  }

  if (incompleteCount > 0) {
    console.warn(`${incompleteCount} application(s) had missing join data in weekly summary`);
  }

  return { weekStart: rangeStart, weekEnd: rangeEnd, applications };
}

// --- Utility helpers ---

export function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysRange(today: string, from: number, to: number): string[] {
  const result: string[] = [];
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  for (let i = start; i <= end; i++) {
    result.push(offsetDate(today, i));
  }
  return result;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
