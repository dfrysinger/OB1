# MCP Date Search Filters

Add date range filtering to `search_job_postings` in the job-hunt MCP server.

## Problem

The `search_job_postings` tool has no date filters. Agents and automated processes cannot query by when a posting was added, when it was posted on LinkedIn, or when the application was submitted. This limits the Gmail sync agent's ability to narrow matches, the daily status scripts' ability to find recent activity, and general pipeline queries.

## Design

Add 6 optional date parameters to `search_job_postings`:

| Param | Type | Column | Join |
|-------|------|--------|------|
| `created_after` | string (YYYY-MM-DD) | `job_postings.created_at` | none |
| `created_before` | string (YYYY-MM-DD) | `job_postings.created_at` | none |
| `posted_after` | string (YYYY-MM-DD) | `job_postings.posted_date` | none |
| `posted_before` | string (YYYY-MM-DD) | `job_postings.posted_date` | none |
| `applied_after` | string (YYYY-MM-DD) | `applications.applied_date` | inner join |
| `applied_before` | string (YYYY-MM-DD) | `applications.applied_date` | inner join |

## Implementation

### Schema changes

Add to the existing `inputSchema` in the `search_job_postings` tool registration. Use Zod regex to validate YYYY-MM-DD format:

```typescript
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

created_after: dateParam.describe("Postings added on or after this date (YYYY-MM-DD, UTC)"),
created_before: dateParam.describe("Postings added on or before this date (YYYY-MM-DD, UTC)"),
posted_after: dateParam.describe("LinkedIn posting date on or after (YYYY-MM-DD)"),
posted_before: dateParam.describe("LinkedIn posting date on or before (YYYY-MM-DD)"),
applied_after: dateParam.describe("Application submitted on or after (YYYY-MM-DD)"),
applied_before: dateParam.describe("Application submitted on or before (YYYY-MM-DD)"),
```

### Tool description update

Update the description to mention date filtering:

```
"Search job postings by text query (title/company/notes), status, source, URL, or date range. Shows application status if one exists. Use has_application filter to find postings with or without applications."
```

### Handler changes

In the handler function, destructure the 6 new params alongside the existing ones.

**Join logic:** Replace the existing `if (status) / else` block with a unified check that accounts for all inner-join triggers:

```typescript
const needsInnerJoin = !!status || !!applied_after || !!applied_before;

if (needsInnerJoin) {
  q = supabase
    .from("job_postings")
    .select("*, companies(name), applications!inner(id, status, applied_date, resume_path, cover_letter_path, created_by)");
  if (status) q = q.eq("applications.status", status);
  if (applied_after) q = q.gte("applications.applied_date", applied_after);
  if (applied_before) q = q.lte("applications.applied_date", applied_before);
} else {
  q = supabase
    .from("job_postings")
    .select("*, companies(name), applications(id, status, applied_date, resume_path, cover_letter_path, created_by)");
}
```

The remaining filters (`url`, `source`, `priority`, `created_by`, `query`, and the new date filters below) are applied after this block, same as before.

**created_at filters:** Since `created_at` is `timestamptz`, use day boundaries in UTC. For `created_before`, use `lt` on the next day to avoid sub-second precision issues:
```typescript
if (created_after) q = q.gte("created_at", `${created_after}T00:00:00Z`);
if (created_before) {
  const next = new Date(created_before);
  next.setDate(next.getDate() + 1);
  q = q.lt("created_at", `${next.toISOString().slice(0, 10)}T00:00:00Z`);
}
```

**posted_date filters:** `posted_date` is a `DATE` column, no time conversion needed:
```typescript
if (posted_after) q = q.gte("posted_date", posted_after);
if (posted_before) q = q.lte("posted_date", posted_before);
```

### Edge cases

- **`has_application: false` + `applied_after/before`:** The inner join guarantees applications exist, so `has_application: false` would return zero results. This is logically contradictory and produces an empty result set, which is acceptable behavior. No validation needed.
- **Null `posted_date` or `applied_date`:** Rows with null values are excluded when those filters are active. This is standard SQL comparison behavior.
- **UTC timezone for `created_at`:** All timestamps in the DB are UTC. The `created_after/before` params are interpreted as UTC dates. Parameter descriptions note this.

### No changes needed

- Database schema (all columns already exist)
- Response format
- Other tools
- Error handling patterns

## Files to modify

1. `/Users/dfrysinger/Projects/open-brain/supabase/functions/job-hunt-mcp/index.ts` -- add params to schema, replace join block, add date filters to handler, update description
