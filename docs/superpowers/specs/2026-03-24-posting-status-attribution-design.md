# Posting Status and Attribution Improvements

Add a `status` column to `job_postings` for tracking active vs closed postings, and add `old_value`/`new_value` columns to `attribution_log` for reversible change tracking.

## Problem

There is no queryable way to distinguish active from expired/closed job postings. The `enrichment_error` text field is the only signal, but it is not exposed through the MCP tools, mixes error messages with status flags, and cannot be filtered by agents. Additionally, the `attribution_log` table does not preserve previous field values, making it impossible to undo rogue automated changes.

## Design

### Schema changes

**job_postings:** Add `status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed'))`. All existing rows default to `active`.

**attribution_log:** Add `old_value TEXT` (nullable) and `new_value TEXT` (nullable). These store the previous and new value for field-level changes. For creates, both are null (the record itself is the source of truth). For updates, each changed field gets its own log row with structured old/new values.

`enrichment_error` remains as-is. It stores the human-readable explanation. `status` is the queryable flag.

### MCP changes

**search_job_postings:**
- Add `posting_status` filter param: `z.enum(["active", "closed"]).optional().describe("Filter by posting status (active or closed)")`.
- No default filtering. Omitting the param returns all postings. Agents pass `posting_status: "active"` to exclude closed.

**update_job_posting:**
- Add `status` as an updatable field with enum validation `["active", "closed"]`.
- The current handler already fetches `status` in its pre-read query but does not expose it as updatable. This change adds it to the input schema and update field assembly.
- Attribution logging changes from 1 row per update to N rows (one per changed field). Currently the handler builds a single concatenated reason string. The new behavior creates a separate `attribution_log` entry for each field that changed, each with its own `old_value` and `new_value`. This matches the per-field pattern already used by `buildUpdateApplicationLogs`.

**get_networking_queue:**
- Add `.eq("status", "active")` to exclude closed postings.

**get_pipeline_overview:**
- No changes. This tool queries the `applications` table, not `job_postings` directly. Application-level status (applied, interviewing, etc.) is what matters for pipeline counts.

**Attribution logging (all handlers):**
- `buildUpdateApplicationLogs` in `handlers.ts`: add `old_value` and `new_value` fields to `AttributionLogEntry` interface and populate them in each log entry.
- Job posting update attribution in `index.ts`: restructure from single concatenated row to per-field rows with `old_value`/`new_value`.
- All other `attribution_log` inserts across the codebase: include `old_value: null`/`new_value: null` for creates and actions without field changes (e.g., "enriched").

### Automation changes

**Enrichment cron (`enrich-job-postings.ts`):**
- Redirect detection uses the existing check: `!currentUrl.includes("/jobs/view/")`. When a posting redirects away from a `/jobs/view/` URL: set `status = 'closed'` and `enrichment_error`. Log to `attribution_log` with `old_value: "active"`, `new_value: "closed"`.
- When a posting returns 404 or "Page not found" (stays on the same URL but page body contains error text): set `enrichment_error` only. Leave `status = 'active'`. A 404 could be a bad link, not necessarily a closed posting. This is new behavior; the current code treats redirects and 404s identically.

**Backfill posted dates (`backfill-posted-dates.ts`):**
- Introduce the same redirect vs 404 distinction. Currently the script treats both cases the same. The new behavior: redirects (URL changes away from `/jobs/view/`) set `status = 'closed'`. 404s (URL stays but page shows "Page not found") set `enrichment_error` only.

### Migration

One-time migration applied after schema update. The enrichment cron and backfill script use different error message formats, so the migration must match both:

- Postings with `enrichment_error LIKE '%Expired (redirected)%'` (from backfill script) OR `enrichment_error LIKE '%Redirected to non-job page%'` (from enrichment cron): set `status = 'closed'`. Log each to `attribution_log` with `actor: "migration"`, `old_value: "active"`, `new_value: "closed"`.
- Postings with `enrichment_error LIKE '%Legacy import%'`: leave `status = 'active'`. These have fixable URLs that the user will recover manually.

### Edge cases

- `get_networking_queue` silently excludes closed postings. This is intentional since closed postings should not appear in the networking queue.
- `search_job_postings` with no `posting_status` filter returns everything including closed. This lets agents find closed postings when explicitly looking for them.
- `old_value`/`new_value` are TEXT columns. Non-string values (booleans, numbers) are stored as their string representation.
- The attribution logging cardinality change (1 row to N rows per update) means existing queries that count attribution rows may return higher numbers after this change. The `pipeline-stats.ts` counting functions use specific `action` and `reason` ILIKE patterns, so they should not be affected.

## Files to modify

1. `supabase/functions/job-hunt-mcp/index.ts` -- search filter, update handler, per-field attribution logging, get_networking_queue
2. `supabase/functions/job-hunt-mcp/handlers.ts` -- add old_value/new_value to AttributionLogEntry and buildUpdateApplicationLogs
3. `extensions/job-hunt/scripts/enrich-job-postings.ts` -- set status on redirect, distinguish redirect from 404, log with old/new values
4. `extensions/job-hunt/scripts/backfill-posted-dates.ts` -- same redirect vs 404 distinction, set status on redirect
5. `extensions/job-hunt/schema.sql` -- add status column to job_postings, add old_value/new_value to attribution_log
6. Migration SQL (run once) -- set status on existing redirected postings, matching both error message formats
