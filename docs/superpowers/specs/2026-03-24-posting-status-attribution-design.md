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
- Log `old_value`/`new_value` on every field change in the attribution log.

**get_networking_queue:**
- Add `.eq("status", "active")` to exclude closed postings.

**get_pipeline_overview:**
- Add `.eq("status", "active")` to exclude closed postings from counts.

**Attribution logging (all handlers):**
- `buildUpdateApplicationLogs` in `handlers.ts`: add `old_value` and `new_value` to each `AttributionLogEntry`.
- Job posting update attribution in `index.ts`: add `old_value` and `new_value` for each changed field.
- All `attribution_log` inserts across the codebase: include `old_value`/`new_value` where applicable. For creates and actions without field changes (e.g., "enriched"), pass null for both.

### Automation changes

**Enrichment cron (`enrich-job-postings.ts`):**
- When a posting redirects with `trk=expired_jd_redirect` in the URL: set `status = 'closed'` and `enrichment_error`. Log to `attribution_log` with `old_value: "active"`, `new_value: "closed"`.
- When a posting returns 404 or "Page not found": set `enrichment_error` only. Leave `status = 'active'`. A 404 could be a bad link, not necessarily a closed posting.

**Backfill posted dates (`backfill-posted-dates.ts`):**
- Same redirect vs 404 distinction as the enrichment cron.

### Migration

One-time migration applied during schema update:
- 14 postings with `enrichment_error LIKE '%Expired (redirected)%'`: set `status = 'closed'`. Log each to `attribution_log` with `actor: "migration"`, `old_value: "active"`, `new_value: "closed"`.
- 5 postings with `enrichment_error LIKE '%Legacy import%'`: leave `status = 'active'`. These have fixable URLs that the user will recover manually.

### Edge cases

- `get_networking_queue` and `get_pipeline_overview` silently exclude closed postings. This is intentional since closed postings should not appear in active pipeline views.
- `search_job_postings` with no `posting_status` filter returns everything including closed. This lets agents find closed postings when explicitly looking for them.
- `old_value`/`new_value` are TEXT columns. Non-string values (booleans, numbers) are stored as their string representation.

## Files to modify

1. `supabase/functions/job-hunt-mcp/index.ts` -- schema filter, update handler, attribution logging, get_networking_queue, get_pipeline_overview
2. `supabase/functions/job-hunt-mcp/handlers.ts` -- add old_value/new_value to AttributionLogEntry and buildUpdateApplicationLogs
3. `extensions/job-hunt/scripts/enrich-job-postings.ts` -- set status on redirect, log with old/new values
4. `extensions/job-hunt/scripts/backfill-posted-dates.ts` -- same redirect vs 404 distinction
5. `extensions/job-hunt/schema.sql` -- add status column and attribution columns
6. Migration SQL (run once) -- set status on existing expired postings
