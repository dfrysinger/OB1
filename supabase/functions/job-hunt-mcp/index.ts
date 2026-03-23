import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { buildUpdateApplicationLogs } from "./handlers.ts";

function requireEnv(name: string): string {
    const value = Deno.env.get(name);
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const MCP_ACCESS_KEY = requireEnv("MCP_ACCESS_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- MCP Server Setup (module-level, NOT per-request) ---

const server = new McpServer({
  name: "job-hunt",
  version: "1.0.0",
});

// Tool 1: add_company
server.registerTool(
  "add_company",
  {
    title: "Add Company",
    description: "Add a company to track in your job search.",
    inputSchema: {
      name: z.string().describe("Company name"),
      industry: z.string().optional().describe("Industry"),
      website: z.string().optional().describe("Company website"),
      size: z.enum(["startup", "mid-market", "enterprise"]).optional().describe("Company size"),
      location: z.string().optional().describe("Location"),
      remote_policy: z.enum(["remote", "hybrid", "onsite"]).optional().describe("Remote work policy"),
      notes: z.string().optional().describe("Additional notes"),
      glassdoor_rating: z.number().min(1.0).max(5.0).optional().describe("Glassdoor rating (1.0-5.0)"),
    },
  },
  async ({ name, industry, website, size, location, remote_policy, notes, glassdoor_rating }) => {
    try {
      const { data, error } = await supabase
        .from("companies")
        .insert({
          name,
          industry: industry ?? null,
          website: website ?? null,
          size: size ?? null,
          location: location ?? null,
          remote_policy: remote_policy ?? null,
          notes: notes ?? null,
          glassdoor_rating: glassdoor_rating ?? null,
        })
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to add company: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Added company: ${name}`, company: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[add_company] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in add_company: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: add_job_posting (upsert on URL conflict, company lookup by name)
server.registerTool(
  "add_job_posting",
  {
    title: "Add Job Posting",
    description:
      "Add or update a job posting. If a URL is provided and already exists, the posting is updated (upsert). Optionally provide company_name to look up or auto-create a company.",
    inputSchema: {
      url: z.string().describe("Job posting URL (required, used for upsert)"),
      company_name: z.string().optional().describe("Company name (case-insensitive lookup; created if not found)"),
      title: z.string().optional().describe("Job title"),
      location: z.string().optional().describe("Job location"),
      source: z.enum(["linkedin", "greenhouse", "lever", "workday", "indeed", "company-site", "referral", "recruiter", "other"]).optional().describe("Where you found this posting"),
      salary_min: z.number().optional().describe("Minimum salary"),
      salary_max: z.number().optional().describe("Maximum salary"),
      notes: z.string().optional().describe("Notes about the role"),
      posted_date: z.string().optional().describe("Date posted (YYYY-MM-DD)"),
      priority: z.enum(["high", "medium", "low"]).optional().describe("Job priority"),
      salary_currency: z.string().optional().describe("Salary currency (defaults to USD)"),
      closing_date: z.string().optional().describe("Posting closing date (YYYY-MM-DD)"),
      created_by: z.string().describe("Identifier for who/what created this entry (e.g. 'gmail-sync', 'auto-resume-generator', 'claude-code')"),
      created_by_reason: z.string().optional().describe("Why this posting was created (e.g., 'LinkedIn URL shared in Slack channel')"),
    },
  },
  async ({ url, company_name, title, location, source, salary_min, salary_max, notes, posted_date, priority, salary_currency, closing_date, created_by, created_by_reason }) => {
    try {
      let company_id: string | null = null;

      if (company_name) {
        // Case-insensitive lookup
        const { data: existing, error: lookupErr } = await supabase
          .from("companies")
          .select("id")
          .ilike("name", company_name)
          .limit(1)
          .maybeSingle();

        if (lookupErr) {
          return {
            content: [{ type: "text" as const, text: `Company lookup failed: ${lookupErr.message}` }],
            isError: true,
          };
        }

        if (existing) {
          company_id = existing.id;
        } else {
          // Create the company
          const { data: newCompany, error: createErr } = await supabase
            .from("companies")
            .insert({ name: company_name })
            .select("id")
            .single();

          if (createErr) {
            return {
              content: [{ type: "text" as const, text: `Failed to create company: ${createErr.message}` }],
              isError: true,
            };
          }
          company_id = newCompany.id;
        }
      }

      // Check if posting already exists (to preserve created_by on update)
      const { data: existingPosting } = await supabase
        .from("job_postings")
        .select("id, created_by")
        .eq("url", url)
        .maybeSingle();

      const isNewPosting = !existingPosting;

      const row: Record<string, unknown> = { url };
      if (company_id != null) row.company_id = company_id;
      if (title != null) row.title = title;
      if (location != null) row.location = location;
      if (source != null) row.source = source;
      if (salary_min != null) row.salary_min = salary_min;
      if (salary_max != null) row.salary_max = salary_max;
      if (notes != null) row.notes = notes;
      if (posted_date != null) row.posted_date = posted_date;
      if (priority != null) row.priority = priority;
      if (salary_currency != null) row.salary_currency = salary_currency;
      if (closing_date != null) row.closing_date = closing_date;

      // Only set created_by on new inserts; preserve existing value on updates
      if (isNewPosting) {
        row.created_by = created_by;
      }

      const { data, error } = await supabase
        .from("job_postings")
        .upsert(row, { onConflict: "url" })
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to upsert job posting: ${error.message}` }],
          isError: true,
        };
      }

      // Log attribution for new postings
      if (isNewPosting) {
        const { error: attrErr } = await supabase.from("attribution_log").insert({
          entity_type: "job_posting",
          entity_id: data.id,
          action: "created",
          actor: created_by,
          reason: created_by_reason ?? null,
        });
        if (attrErr) console.error(`Attribution log failed: ${attrErr.message}`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Upserted job posting: ${title ?? url}`, job_posting: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[add_job_posting] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in add_job_posting: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: submit_application
server.registerTool(
  "submit_application",
  {
    title: "Submit Application",
    description: "Record a submitted job application.",
    inputSchema: {
      job_posting_id: z.string().uuid().describe("Job posting ID (UUID)"),
      status: z.enum(["draft", "ready", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn"]).optional().default("applied").describe("Application status"),
      applied_date: z.string().optional().describe("Date applied (YYYY-MM-DD)"),
      resume_version: z.string().optional().describe("Resume version used"),
      cover_letter_notes: z.string().optional().describe("Notes about cover letter"),
      referral_contact: z.string().optional().describe("Referral contact name"),
      notes: z.string().optional().describe("Additional notes"),
      resume_path: z.string().optional().describe("Path to generated resume file"),
      cover_letter_path: z.string().optional().describe("Path to cover letter file"),
      response_date: z.string().optional().describe("Date company responded (YYYY-MM-DD)"),
      created_by: z.string().describe("Identifier for who/what created this entry (e.g. 'gmail-sync', 'auto-resume-generator', 'claude-code')"),
      created_by_reason: z.string().optional().describe("Why this application was created"),
    },
  },
  async ({ job_posting_id, status, applied_date, resume_version, cover_letter_notes, referral_contact, notes, resume_path, cover_letter_path, response_date, created_by, created_by_reason }) => {
    try {
      const { data, error } = await supabase
        .from("applications")
        .insert({
          job_posting_id,
          status: status ?? "applied",
          applied_date: applied_date ?? null,
          resume_version: resume_version ?? null,
          cover_letter_notes: cover_letter_notes ?? null,
          referral_contact: referral_contact ?? null,
          notes: notes ?? null,
          resume_path: resume_path ?? null,
          cover_letter_path: cover_letter_path ?? null,
          response_date: response_date ?? null,
          created_by,
        })
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to submit application: ${error.message}` }],
          isError: true,
        };
      }

      // Log attribution
      const attributionLogs: Record<string, unknown>[] = [
        {
          entity_type: "application",
          entity_id: data.id,
          action: "created",
          actor: created_by,
          reason: created_by_reason ?? null,
        },
      ];
      if (resume_path) {
        attributionLogs.push({
          entity_type: "application",
          entity_id: data.id,
          action: "resume_added",
          actor: created_by,
          reason: created_by_reason ?? null,
        });
      }
      if (cover_letter_path) {
        attributionLogs.push({
          entity_type: "application",
          entity_id: data.id,
          action: "cover_letter_added",
          actor: created_by,
          reason: created_by_reason ?? null,
        });
      }
      const { error: attrErr } = await supabase.from("attribution_log").insert(attributionLogs);
      if (attrErr) console.error(`Attribution log failed: ${attrErr.message}`);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Application recorded successfully", application: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[submit_application] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in submit_application: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: update_application
server.registerTool(
  "update_application",
  {
    title: "Update Application",
    description: "Update any fields on an existing application. All fields are optional — only provided fields are updated. Pass null to clear a field.",
    inputSchema: {
      application_id: z.string().uuid().describe("Application ID (UUID)"),
      status: z.enum(["draft", "ready", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn"]).optional().describe("New application status"),
      applied_date: z.string().nullable().optional().describe("Date applied (YYYY-MM-DD). Pass null to clear."),
      resume_version: z.string().nullable().optional().describe("Resume version used. Pass null to clear."),
      resume_path: z.string().nullable().optional().describe("Path to generated resume file. Pass null to clear."),
      cover_letter_path: z.string().nullable().optional().describe("Path to cover letter file. Pass null to clear."),
      cover_letter_notes: z.string().nullable().optional().describe("Notes about cover letter. Pass null to clear."),
      referral_contact: z.string().nullable().optional().describe("Referral contact name. Pass null to clear."),
      response_date: z.string().nullable().optional().describe("Date company responded (YYYY-MM-DD). Pass null to clear."),
      notes: z.string().nullable().optional().describe("Additional notes. Pass null to clear."),
      actor: z.string().describe("Identifier for who/what is making this update (e.g. 'gmail-sync', 'auto-resume-generator', 'claude-code')"),
      actor_reason: z.string().optional().describe("Why this update is being made"),
      created_by: z.string().optional().describe("Override who created this application (for corrections)"),
    },
  },
  async ({ application_id, status, applied_date, resume_version, resume_path, cover_letter_path, cover_letter_notes, referral_contact, response_date, notes, actor, actor_reason, created_by }) => {
    try {
      // Fetch current state for change detection
      const { data: current, error: currentErr } = await supabase
        .from("applications")
        .select("status, resume_path, cover_letter_path")
        .eq("id", application_id)
        .single();
      if (currentErr) console.error(`Failed to fetch current application state: ${currentErr.message}`);

      const updateFields: Record<string, unknown> = {};
      if (status !== undefined) updateFields.status = status;
      if (applied_date !== undefined) updateFields.applied_date = applied_date;
      if (resume_version !== undefined) updateFields.resume_version = resume_version;
      if (resume_path !== undefined) updateFields.resume_path = resume_path;
      if (cover_letter_path !== undefined) updateFields.cover_letter_path = cover_letter_path;
      if (cover_letter_notes !== undefined) updateFields.cover_letter_notes = cover_letter_notes;
      if (referral_contact !== undefined) updateFields.referral_contact = referral_contact;
      if (response_date !== undefined) updateFields.response_date = response_date;
      if (notes !== undefined) updateFields.notes = notes;
      if (created_by !== undefined) updateFields.created_by = created_by;

      if (Object.keys(updateFields).length === 0) {
        return {
          content: [{ type: "text" as const, text: "No fields provided to update." }],
          isError: true,
        };
      }

      const { data, error } = await supabase
        .from("applications")
        .update(updateFields)
        .eq("id", application_id)
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to update application: ${error.message}` }],
          isError: true,
        };
      }

      // Log attribution for changes
      if (current) {
        const logs = buildUpdateApplicationLogs(
          current,
          { status, resume_path, cover_letter_path },
          application_id,
          actor,
          actor_reason,
        );
        if (logs.length > 0) {
          const { error: attrErr } = await supabase.from("attribution_log").insert(logs);
          if (attrErr) console.error(`Attribution log failed: ${attrErr.message}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Application updated successfully", application: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[update_application] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in update_application: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4b: delete_application
server.registerTool(
  "delete_application",
  {
    title: "Delete Application",
    description: "Delete an application record. Use to remove duplicates or erroneous entries.",
    inputSchema: {
      application_id: z.string().uuid().describe("Application ID (UUID)"),
    },
  },
  async ({ application_id }) => {
    try {
      // Verify exists
      const { data: existing, error: findErr } = await supabase
        .from("applications")
        .select("id")
        .eq("id", application_id)
        .single();

      if (findErr || !existing) {
        return {
          content: [{ type: "text" as const, text: `Application not found: ${application_id}` }],
          isError: true,
        };
      }

      const { error } = await supabase
        .from("applications")
        .delete()
        .eq("id", application_id);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to delete application: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Application ${application_id} deleted` }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[delete_application] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in delete_application: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4c: delete_job_posting
server.registerTool(
  "delete_job_posting",
  {
    title: "Delete Job Posting",
    description: "Delete a job posting and its associated applications. Use to remove duplicates or erroneous entries.",
    inputSchema: {
      job_posting_id: z.string().uuid().describe("Job posting ID (UUID)"),
    },
  },
  async ({ job_posting_id }) => {
    try {
      // Verify exists
      const { data: existing, error: findErr } = await supabase
        .from("job_postings")
        .select("id")
        .eq("id", job_posting_id)
        .single();

      if (findErr || !existing) {
        return {
          content: [{ type: "text" as const, text: `Job posting not found: ${job_posting_id}` }],
          isError: true,
        };
      }

      const { error } = await supabase
        .from("job_postings")
        .delete()
        .eq("id", job_posting_id);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to delete job posting: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Job posting ${job_posting_id} deleted` }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[delete_job_posting] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in delete_job_posting: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: schedule_interview
server.registerTool(
  "schedule_interview",
  {
    title: "Schedule Interview",
    description: "Schedule an interview for an application.",
    inputSchema: {
      application_id: z.string().uuid().describe("Application ID (UUID)"),
      interview_type: z.enum(["phone_screen", "technical", "behavioral", "system_design", "hiring_manager", "team", "final"]).describe("Type of interview"),
      scheduled_at: z.string().optional().describe("Interview date/time (ISO 8601)"),
      duration_minutes: z.number().optional().describe("Expected duration in minutes"),
      interviewer_name: z.string().optional().describe("Interviewer name"),
      interviewer_title: z.string().optional().describe("Interviewer title"),
      notes: z.string().optional().describe("Pre-interview prep notes"),
    },
  },
  async ({ application_id, interview_type, scheduled_at, duration_minutes, interviewer_name, interviewer_title, notes }) => {
    try {
      const { data, error } = await supabase
        .from("interviews")
        .insert({
          application_id,
          interview_type,
          scheduled_at: scheduled_at ?? null,
          duration_minutes: duration_minutes ?? null,
          interviewer_name: interviewer_name ?? null,
          interviewer_title: interviewer_title ?? null,
          status: "scheduled",
          notes: notes ?? null,
        })
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to schedule interview: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Interview scheduled successfully", interview: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[schedule_interview] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in schedule_interview: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 6: log_interview_notes
server.registerTool(
  "log_interview_notes",
  {
    title: "Log Interview Notes",
    description: "Add feedback/notes after an interview and mark it as completed.",
    inputSchema: {
      interview_id: z.string().uuid().describe("Interview ID (UUID)"),
      feedback: z.string().optional().describe("Post-interview reflection"),
      rating: z.number().min(1).max(5).optional().describe("Your assessment of how it went (1-5)"),
    },
  },
  async ({ interview_id, feedback, rating }) => {
    try {
      const { data, error } = await supabase
        .from("interviews")
        .update({
          feedback: feedback ?? null,
          rating: rating ?? null,
          status: "completed",
        })
        .eq("id", interview_id)
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to log interview notes: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Interview notes logged and status updated to completed", interview: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[log_interview_notes] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in log_interview_notes: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 7: get_pipeline_overview
server.registerTool(
  "get_pipeline_overview",
  {
    title: "Pipeline Overview",
    description: "Get a dashboard summary: total applications, counts by status, upcoming interviews (next 7 days).",
    inputSchema: {},
  },
  async () => {
    try {
      // Get application counts by status
      const { data: applications, error: appError } = await supabase
        .from("applications")
        .select("status");

      if (appError) {
        return {
          content: [{ type: "text" as const, text: `Failed to get applications: ${appError.message}` }],
          isError: true,
        };
      }

      const statusCounts: Record<string, number> = {};
      for (const app of applications ?? []) {
        statusCounts[app.status] = (statusCounts[app.status] ?? 0) + 1;
      }

      // Get upcoming interviews (next 7 days)
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      const { data: upcomingInterviews, error: interviewError } = await supabase
        .from("interviews")
        .select(`
          *,
          applications!inner(
            *,
            job_postings!inner(
              *,
              companies!inner(*)
            )
          )
        `)
        .eq("status", "scheduled")
        .gte("scheduled_at", new Date().toISOString())
        .lte("scheduled_at", futureDate.toISOString())
        .order("scheduled_at", { ascending: true });

      if (interviewError) {
        return {
          content: [{ type: "text" as const, text: `Failed to get upcoming interviews: ${interviewError.message}` }],
          isError: true,
        };
      }

      const result = {
        total_applications: (applications ?? []).length,
        status_breakdown: statusCounts,
        upcoming_interviews_count: (upcomingInterviews ?? []).length,
        upcoming_interviews: upcomingInterviews ?? [],
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[get_pipeline_overview] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in get_pipeline_overview: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 8: get_upcoming_interviews
server.registerTool(
  "get_upcoming_interviews",
  {
    title: "Upcoming Interviews",
    description: "List interviews in the next N days with full company/role context.",
    inputSchema: {
      days_ahead: z.number().optional().default(14).describe("Number of days to look ahead (default: 14)"),
    },
  },
  async ({ days_ahead }) => {
    try {
      const daysToCheck = days_ahead ?? 14;
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + daysToCheck);

      const { data, error } = await supabase
        .from("interviews")
        .select(`
          *,
          applications!inner(
            *,
            job_postings!inner(
              *,
              companies!inner(*)
            )
          )
        `)
        .eq("status", "scheduled")
        .gte("scheduled_at", new Date().toISOString())
        .lte("scheduled_at", futureDate.toISOString())
        .order("scheduled_at", { ascending: true });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to get upcoming interviews: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: (data ?? []).length, interviews: data ?? [] }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[get_upcoming_interviews] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in get_upcoming_interviews: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 9: search_job_postings (NEW)
server.registerTool(
  "search_job_postings",
  {
    title: "Search Job Postings",
    description: "Search job postings by text query (title/company/notes), status, source, or exact URL. Shows application status if one exists. Use has_application filter to find postings with or without applications.",
    inputSchema: {
      query: z.string().optional().describe("Text search across title, company name, and notes (case-insensitive)"),
      status: z.enum(["draft", "ready", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn"]).optional().describe("Filter by application status"),
      source: z.enum(["linkedin", "greenhouse", "lever", "workday", "indeed", "company-site", "referral", "recruiter", "other"]).optional().describe("Filter by posting source"),
      url: z.string().optional().describe("Exact URL match"),
      priority: z.enum(["high", "medium", "low"]).optional().describe("Filter by job priority"),
      has_application: z.boolean().optional().describe("Filter by whether an application exists. true = only postings with applications, false = only postings without applications"),
      created_by: z.string().optional().describe("Filter by who created the posting (filters job_postings.created_by)"),
    },
  },
  async ({ query, status, source, url, priority, has_application, created_by }) => {
    try {
      // Build select based on whether status filter is needed
      let q;
      if (status) {
        // Inner join — only postings with matching application status
        q = supabase
          .from("job_postings")
          .select("*, companies(name), applications!inner(id, status, applied_date, resume_path, cover_letter_path, created_by)")
          .eq("applications.status", status);
      } else {
        // Left join — all postings, applications if they exist
        q = supabase
          .from("job_postings")
          .select("*, companies(name), applications(id, status, applied_date, resume_path, cover_letter_path, created_by)");
      }

      if (url) {
        q = q.eq("url", url);
      }

      if (source) {
        q = q.eq("source", source);
      }

      if (priority) {
        q = q.eq("priority", priority);
      }

      if (created_by) {
        q = q.eq("created_by", created_by);
      }

      if (query) {
        // Escape PostgREST special characters in the query
        const safeQuery = query.replace(/[%_.,()\\]/g, '\\$&');

        // Find companies matching the query
        const { data: matchingCos, error: coErr } = await supabase
          .from("companies")
          .select("id")
          .ilike("name", `%${safeQuery}%`);
        if (coErr) {
          console.error("Company search error:", coErr);
        }
        const coIds = (matchingCos ?? []).map((c: any) => c.id);

        const filters: string[] = [
          `title.ilike.%${safeQuery}%`,
          `notes.ilike.%${safeQuery}%`,
        ];
        if (coIds.length > 0) {
          filters.push(`company_id.in.(${coIds.join(",")})`);
        }
        q = q.or(filters.join(","));
      }

      const { data, error } = await q.order("created_at", { ascending: false });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${error.message}` }],
          isError: true,
        };
      }

      let results = data ?? [];

      // Filter by has_application if specified (can't do this in PostgREST for empty arrays)
      if (has_application === true) {
        results = results.filter((p: any) => p.applications && p.applications.length > 0);
      } else if (has_application === false) {
        results = results.filter((p: any) => !p.applications || p.applications.length === 0);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: results.length, job_postings: results }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[search_job_postings] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in search_job_postings: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 10: link_contact_to_professional_crm
server.registerTool(
  "link_contact_to_professional_crm",
  {
    title: "Link Contact to Professional CRM",
    description: "Link a job contact to the Professional CRM, creating a professional_contacts record. If the update fails after insert, the inserted record is cleaned up.",
    inputSchema: {
      job_contact_id: z.string().uuid().describe("Job contact ID (UUID)"),
    },
  },
  async ({ job_contact_id }) => {
    try {
      // Get the job contact
      const { data: jobContact, error: contactError } = await supabase
        .from("job_contacts")
        .select("*")
        .eq("id", job_contact_id)
        .single();

      if (contactError) {
        return {
          content: [{ type: "text" as const, text: `Failed to retrieve job contact: ${contactError.message}` }],
          isError: true,
        };
      }

      if (!jobContact) {
        return {
          content: [{ type: "text" as const, text: "Job contact not found" }],
          isError: true,
        };
      }

      // Check if already linked
      if (jobContact.professional_crm_contact_id) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ message: "Contact already linked to Professional CRM", job_contact: jobContact, already_linked: true }, null, 2) }],
        };
      }

      // Get company name if linked
      let companyName: string | null = null;
      if (jobContact.company_id) {
        const { data: company } = await supabase
          .from("companies")
          .select("name")
          .eq("id", jobContact.company_id)
          .single();
        companyName = company?.name ?? null;
      }

      // Create professional contact
      const { data: professionalContact, error: crmError } = await supabase
        .from("professional_contacts")
        .insert({
          name: jobContact.name,
          company: companyName,
          title: jobContact.title ?? null,
          email: jobContact.email ?? null,
          phone: jobContact.phone ?? null,
          linkedin_url: jobContact.linkedin_url ?? null,
          how_we_met: `Job search - ${jobContact.role_in_process ?? "contact"}`,
          tags: ["job-hunt", jobContact.role_in_process ?? "contact"],
          notes: jobContact.notes ?? null,
          last_contacted: jobContact.last_contacted ?? null,
        })
        .select()
        .single();

      if (crmError) {
        return {
          content: [{ type: "text" as const, text: `Failed to create professional contact: ${crmError.message}` }],
          isError: true,
        };
      }

      // Update job contact with link
      const { data: updatedJobContact, error: updateError } = await supabase
        .from("job_contacts")
        .update({ professional_crm_contact_id: professionalContact.id })
        .eq("id", job_contact_id)
        .select()
        .single();

      if (updateError) {
        // Compensating action: delete the professional contact we just created
        const { error: deleteErr } = await supabase
          .from("professional_contacts")
          .delete()
          .eq("id", professionalContact.id);

        if (deleteErr) {
          console.error("CRITICAL: Failed to clean up orphaned professional contact:", professionalContact.id, deleteErr);
          return {
            content: [{ type: "text" as const, text: `Link failed AND cleanup failed. Orphaned record ID: ${professionalContact.id}. Manual cleanup required.` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Failed to link contact (rolled back professional contact): ${updateError.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Linked ${jobContact.name} to Professional CRM`, job_contact: updatedJobContact, professional_contact: professionalContact }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[link_contact_to_professional_crm] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in link_contact_to_professional_crm: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 11: get_attribution_history
server.registerTool(
  "get_attribution_history",
  {
    title: "Get Attribution History",
    description: "Get the full attribution history for a job posting or application. Returns all logged actions (created, resume_added, status_changed, etc.) in chronological order.",
    inputSchema: {
      entity_type: z.enum(["job_posting", "application", "job_contact"]).describe("Type of entity"),
      entity_id: z.string().uuid().describe("ID of the posting or application"),
    },
  },
  async ({ entity_type, entity_id }) => {
    try {
      const { data, error } = await supabase
        .from("attribution_log")
        .select("*")
        .eq("entity_type", entity_type)
        .eq("entity_id", entity_id)
        .order("created_at", { ascending: true });
      if (error) {
        return { content: [{ type: "text" as const, text: `Failed to get history: ${error.message}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: data?.length ?? 0, history: data }, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  }
);

// Tool: add_job_contact
server.registerTool(
  "add_job_contact",
  {
    title: "Add Job Contact",
    description: "Add a contact to your job search. Optionally link to a specific posting with a relationship type.",
    inputSchema: {
      name: z.string().describe("Contact name"),
      company_id: z.string().uuid().describe("Company ID (UUID)"),
      created_by: z.string().describe("Who is creating this contact"),
      title: z.string().optional().describe("Contact's job title"),
      linkedin_url: z.string().optional().describe("LinkedIn profile URL"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      role_in_process: z.enum(["recruiter", "hiring_manager", "referral", "interviewer", "other"]).optional().describe("Role in the hiring process"),
      notes: z.string().optional().describe("Notes about this contact"),
      job_posting_id: z.string().uuid().optional().describe("Link to a specific posting"),
      relationship: z.enum([
        "colleague", "hiring_manager", "confirmed_recruiter", "recruiter",
        "recruiting_lead", "network", "mutual_intro", "employee", "executive"
      ]).optional().describe("Relationship to the posting (required if job_posting_id provided)"),
    },
  },
  async ({ name, company_id, created_by, title, linkedin_url, email, phone, role_in_process, notes, job_posting_id, relationship }) => {
    try {
      const { data: contact, error } = await supabase
        .from("job_contacts")
        .insert({
          name,
          company_id,
          title: title ?? null,
          linkedin_url: linkedin_url ?? null,
          email: email ?? null,
          phone: phone ?? null,
          role_in_process: role_in_process ?? null,
          notes: notes ?? null,
        })
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to add contact: ${error.message}` }],
          isError: true,
        };
      }

      // Create junction record if posting specified
      if (job_posting_id && relationship) {
        const { error: junctionErr } = await supabase
          .from("posting_contacts")
          .insert({
            job_posting_id,
            job_contact_id: contact.id,
            relationship,
          });
        if (junctionErr) {
          console.warn(`Junction insert failed: ${junctionErr.message}`);
        }
      }

      // Attribution log
      const { error: attrErr } = await supabase.from("attribution_log").insert({
        entity_type: "job_contact",
        entity_id: contact.id,
        action: "created",
        actor: created_by,
        reason: null,
      });
      if (attrErr) console.error(`Attribution log failed: ${attrErr.message}`);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Added contact: ${name}`, contact }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[add_job_contact] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in add_job_contact: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool: search_job_contacts
server.registerTool(
  "search_job_contacts",
  {
    title: "Search Job Contacts",
    description: "Find contacts by company, posting, role, or name search.",
    inputSchema: {
      company_id: z.string().uuid().optional().describe("Filter by company"),
      job_posting_id: z.string().uuid().optional().describe("Filter by posting (via posting_contacts junction)"),
      role_in_process: z.enum(["recruiter", "hiring_manager", "referral", "interviewer", "other"]).optional().describe("Filter by role"),
      query: z.string().optional().describe("Text search on name, title, and notes (case-insensitive)"),
      limit: z.number().optional().default(20),
    },
  },
  async ({ company_id, job_posting_id, role_in_process, query, limit }) => {
    try {
      if (job_posting_id) {
        // Query through the junction table
        let q = supabase
          .from("posting_contacts")
          .select("relationship, job_contact_id, job_contacts(id, name, title, email, phone, linkedin_url, role_in_process, notes, last_contacted, company_id, companies(name))")
          .eq("job_posting_id", job_posting_id)
          .limit(limit);

        const { data, error } = await q;
        if (error) {
          return {
            content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ count: data?.length ?? 0, contacts: data }, null, 2) }],
        };
      }

      // Direct query on job_contacts
      let q = supabase
        .from("job_contacts")
        .select("*, companies(name)")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (company_id) q = q.eq("company_id", company_id);
      if (role_in_process) q = q.eq("role_in_process", role_in_process);
      if (query) {
        const safeQuery = query.replace(/[%_.,()\\]/g, '\\$&');
        q = q.or(`name.ilike.%${safeQuery}%,title.ilike.%${safeQuery}%,notes.ilike.%${safeQuery}%`);
      }

      const { data, error } = await q;
      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: data?.length ?? 0, contacts: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[search_job_contacts] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in search_job_contacts: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool: update_job_contact
server.registerTool(
  "update_job_contact",
  {
    title: "Update Job Contact",
    description: "Update fields on an existing contact.",
    inputSchema: {
      job_contact_id: z.string().uuid().describe("Contact ID (UUID)"),
      actor: z.string().describe("Who is making this update"),
      name: z.string().optional().describe("Contact name"),
      title: z.string().nullable().optional().describe("Job title. Pass null to clear."),
      linkedin_url: z.string().nullable().optional().describe("LinkedIn URL. Pass null to clear."),
      email: z.string().nullable().optional().describe("Email. Pass null to clear."),
      phone: z.string().nullable().optional().describe("Phone. Pass null to clear."),
      role_in_process: z.enum(["recruiter", "hiring_manager", "referral", "interviewer", "other"]).nullable().optional().describe("Role in process. Pass null to clear."),
      notes: z.string().nullable().optional().describe("Notes. Pass null to clear."),
      last_contacted: z.string().nullable().optional().describe("Last contacted date (ISO 8601). Pass null to clear."),
    },
  },
  async ({ job_contact_id, actor, name, title, linkedin_url, email, phone, role_in_process, notes, last_contacted }) => {
    try {
      const updateFields: Record<string, unknown> = {};
      if (name !== undefined) updateFields.name = name;
      if (title !== undefined) updateFields.title = title;
      if (linkedin_url !== undefined) updateFields.linkedin_url = linkedin_url;
      if (email !== undefined) updateFields.email = email;
      if (phone !== undefined) updateFields.phone = phone;
      if (role_in_process !== undefined) updateFields.role_in_process = role_in_process;
      if (notes !== undefined) updateFields.notes = notes;
      if (last_contacted !== undefined) updateFields.last_contacted = last_contacted;

      if (Object.keys(updateFields).length === 0) {
        return {
          content: [{ type: "text" as const, text: "No fields to update" }],
        };
      }

      const { data, error } = await supabase
        .from("job_contacts")
        .update(updateFields)
        .eq("id", job_contact_id)
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to update contact: ${error.message}` }],
          isError: true,
        };
      }

      const { error: attrErr } = await supabase.from("attribution_log").insert({
        entity_type: "job_contact",
        entity_id: job_contact_id,
        action: "updated",
        actor,
        reason: `Updated fields: ${Object.keys(updateFields).join(", ")}`,
      });
      if (attrErr) console.error(`Attribution log failed: ${attrErr.message}`);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Updated contact ${data.name}`, contact: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[update_job_contact] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in update_job_contact: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool: delete_job_contact
server.registerTool(
  "delete_job_contact",
  {
    title: "Delete Job Contact",
    description: "Permanently delete a contact and all its posting links.",
    inputSchema: {
      job_contact_id: z.string().uuid().describe("Contact ID (UUID)"),
      actor: z.string().describe("Who is deleting this contact"),
    },
  },
  async ({ job_contact_id, actor }) => {
    try {
      // Verify exists
      const { data: existing, error: findErr } = await supabase
        .from("job_contacts")
        .select("id, name")
        .eq("id", job_contact_id)
        .single();

      if (findErr || !existing) {
        return {
          content: [{ type: "text" as const, text: `Contact not found: ${job_contact_id}` }],
          isError: true,
        };
      }

      // posting_contacts cascade-deletes via FK, but log it
      const { error } = await supabase
        .from("job_contacts")
        .delete()
        .eq("id", job_contact_id);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to delete: ${error.message}` }],
          isError: true,
        };
      }

      const { error: attrErr } = await supabase.from("attribution_log").insert({
        entity_type: "job_contact",
        entity_id: job_contact_id,
        action: "deleted",
        actor,
        reason: `Deleted contact: ${existing.name}`,
      });
      if (attrErr) console.error(`Attribution log failed: ${attrErr.message}`);

      return {
        content: [{ type: "text" as const, text: `Deleted contact ${existing.name} (${job_contact_id})` }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[delete_job_contact] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in delete_job_contact: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool: link_contact_to_posting
server.registerTool(
  "link_contact_to_posting",
  {
    title: "Link Contact to Posting",
    description: "Link an existing contact to a job posting with a relationship type.",
    inputSchema: {
      job_contact_id: z.string().uuid().describe("Contact ID"),
      job_posting_id: z.string().uuid().describe("Posting ID"),
      relationship: z.enum([
        "colleague", "hiring_manager", "confirmed_recruiter", "recruiter",
        "recruiting_lead", "network", "mutual_intro", "employee", "executive"
      ]).describe("How this contact relates to this posting"),
    },
  },
  async ({ job_contact_id, job_posting_id, relationship }) => {
    try {
      const { data, error } = await supabase
        .from("posting_contacts")
        .insert({ job_contact_id, job_posting_id, relationship })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          return {
            content: [{ type: "text" as const, text: "Contact is already linked to this posting" }],
          };
        }
        return {
          content: [{ type: "text" as const, text: `Failed to link: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Linked contact to posting", link: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[link_contact_to_posting] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in link_contact_to_posting: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool: unlink_contact_from_posting
server.registerTool(
  "unlink_contact_from_posting",
  {
    title: "Unlink Contact from Posting",
    description: "Remove the link between a contact and a posting without deleting the contact.",
    inputSchema: {
      job_contact_id: z.string().uuid().describe("Contact ID"),
      job_posting_id: z.string().uuid().describe("Posting ID"),
    },
  },
  async ({ job_contact_id, job_posting_id }) => {
    try {
      const { error } = await supabase
        .from("posting_contacts")
        .delete()
        .eq("job_contact_id", job_contact_id)
        .eq("job_posting_id", job_posting_id);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to unlink: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: "Unlinked contact from posting" }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[unlink_contact_from_posting] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in unlink_contact_from_posting: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool: update_job_posting
server.registerTool(
  "update_job_posting",
  {
    title: "Update Job Posting",
    description: "Update fields on an existing job posting. Used to set networking_status, has_network_connections, priority, and other fields.",
    inputSchema: {
      job_posting_id: z.string().uuid().describe("Posting ID (UUID)"),
      actor: z.string().describe("Who is making this update"),
      actor_reason: z.string().optional().describe("Why this update is being made"),
      networking_status: z.enum(["not_started", "researched", "outreach_in_progress", "done"]).optional().describe("Networking pipeline status"),
      has_network_connections: z.boolean().optional().describe("Whether LinkedIn showed network connections for this posting"),
      priority: z.enum(["high", "medium", "low"]).nullable().optional().describe("Job priority"),
      title: z.string().optional().describe("Job title"),
      url: z.string().nullable().optional().describe("Job posting URL"),
      location: z.string().optional().describe("Location"),
      source: z.enum(["linkedin", "greenhouse", "lever", "workday", "indeed", "company-site", "referral", "recruiter", "other"]).optional().describe("Where you found this posting"),
      salary_min: z.number().nullable().optional().describe("Minimum salary"),
      salary_max: z.number().nullable().optional().describe("Maximum salary"),
      salary_currency: z.string().optional().describe("Salary currency"),
      notes: z.string().nullable().optional().describe("Notes"),
      posted_date: z.string().nullable().optional().describe("Date posted (YYYY-MM-DD)"),
      closing_date: z.string().nullable().optional().describe("Closing date (YYYY-MM-DD)"),
    },
  },
  async ({ job_posting_id, actor, actor_reason, networking_status, has_network_connections, priority, title, url, location, source, salary_min, salary_max, salary_currency, notes, posted_date, closing_date }) => {
    try {
      const updateFields: Record<string, unknown> = {};
      if (networking_status !== undefined) updateFields.networking_status = networking_status;
      if (has_network_connections !== undefined) updateFields.has_network_connections = has_network_connections;
      if (priority !== undefined) updateFields.priority = priority;
      if (title !== undefined) updateFields.title = title;
      if (url !== undefined) updateFields.url = url;
      if (location !== undefined) updateFields.location = location;
      if (source !== undefined) updateFields.source = source;
      if (salary_min !== undefined) updateFields.salary_min = salary_min;
      if (salary_max !== undefined) updateFields.salary_max = salary_max;
      if (salary_currency !== undefined) updateFields.salary_currency = salary_currency;
      if (notes !== undefined) updateFields.notes = notes;
      if (posted_date !== undefined) updateFields.posted_date = posted_date;
      if (closing_date !== undefined) updateFields.closing_date = closing_date;

      if (Object.keys(updateFields).length === 0) {
        return {
          content: [{ type: "text" as const, text: "No fields to update" }],
        };
      }

      // Fetch current state for change detection in attribution logging
      const { data: current, error: currentErr } = await supabase
        .from("job_postings")
        .select("networking_status, has_network_connections, priority, title, status")
        .eq("id", job_posting_id)
        .single();
      if (currentErr) console.error(`Failed to fetch current posting state: ${currentErr.message}`);

      const { data, error } = await supabase
        .from("job_postings")
        .update(updateFields)
        .eq("id", job_posting_id)
        .select("*, companies(name)")
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to update posting: ${error.message}` }],
          isError: true,
        };
      }

      // Build descriptive reason with old -> new transitions for key fields
      // Always include structured transitions so pipeline-stats ILIKE queries match
      const changes: string[] = [];
      if (networking_status !== undefined) {
        const oldVal = current?.networking_status ?? "unknown";
        changes.push(`networking_status: ${oldVal} -> ${networking_status}`);
      }
      if (priority !== undefined) {
        const oldVal = current?.priority ?? "unknown";
        changes.push(`priority: ${oldVal} -> ${priority}`);
      }
      const otherFields = Object.keys(updateFields).filter(f => f !== "networking_status" && f !== "priority");
      if (otherFields.length > 0) {
        changes.push(`Updated: ${otherFields.join(", ")}`);
      }
      let reason = changes.join("; ");
      if (actor_reason) {
        reason = reason ? `${reason} — ${actor_reason}` : actor_reason;
      }

      const { error: attrErr } = await supabase.from("attribution_log").insert({
        entity_type: "job_posting",
        entity_id: job_posting_id,
        action: "updated",
        actor,
        reason,
      });
      if (attrErr) console.error(`Attribution log failed: ${attrErr.message}`);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Updated posting: ${data.title ?? data.url}`, job_posting: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[update_job_posting] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in update_job_posting: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool: get_networking_queue
server.registerTool(
  "get_networking_queue",
  {
    title: "Get Networking Queue",
    description: "Get job postings grouped by networking status for pipeline management. Returns contact counts, network connection flag, and application status.",
    inputSchema: {
      networking_status: z.enum(["not_started", "researched", "outreach_in_progress", "done"]).optional().describe("Filter by networking status"),
      has_contacts: z.boolean().optional().describe("true = only postings with contacts, false = only postings without"),
      has_network_connections: z.boolean().optional().describe("Filter by whether LinkedIn showed network connections"),
      limit: z.number().optional().default(50),
    },
  },
  async ({ networking_status, has_contacts, has_network_connections, limit }) => {
    try {
      let q = supabase
        .from("job_postings")
        .select("id, title, url, location, priority, has_network_connections, networking_status, created_at, companies(name), applications(id, status)")
        .order("priority", { ascending: true })
        .limit(limit);

      if (networking_status) q = q.eq("networking_status", networking_status);
      if (has_network_connections !== undefined) q = q.eq("has_network_connections", has_network_connections);

      const { data, error } = await q;
      if (error) {
        return {
          content: [{ type: "text" as const, text: `Queue error: ${error.message}` }],
          isError: true,
        };
      }

      // Get contact counts per posting via posting_contacts
      const postingIds = (data ?? []).map((p: { id: string }) => p.id);
      let contactCounts: Record<string, number> = {};

      if (postingIds.length > 0) {
        const { data: junctions } = await supabase
          .from("posting_contacts")
          .select("job_posting_id")
          .in("job_posting_id", postingIds);

        for (const j of junctions ?? []) {
          contactCounts[j.job_posting_id] = (contactCounts[j.job_posting_id] || 0) + 1;
        }
      }

      // Filter by has_contacts if specified
      let results = (data ?? []).map((p: Record<string, unknown>) => ({
        ...p,
        contact_count: contactCounts[p.id as string] || 0,
      }));

      if (has_contacts === true) {
        results = results.filter((p: { contact_count: number }) => p.contact_count > 0);
      } else if (has_contacts === false) {
        results = results.filter((p: { contact_count: number }) => p.contact_count === 0);
      }

      // Group by status for summary
      const statusCounts: Record<string, number> = {};
      for (const p of results) {
        const s = (p.networking_status as string) ?? "not_started";
        statusCounts[s] = (statusCounts[s] || 0) + 1;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          total: results.length,
          by_status: statusCounts,
          postings: results,
        }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[get_networking_queue] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in get_networking_queue: ${message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth Check ---

const app = new Hono();

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
