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

Add to the existing `inputSchema` in the `search_job_postings` tool registration:

```typescript
created_after: z.string().optional().describe("Postings added on or after this date (YYYY-MM-DD)"),
created_before: z.string().optional().describe("Postings added on or before this date (YYYY-MM-DD)"),
posted_after: z.string().optional().describe("LinkedIn posting date on or after (YYYY-MM-DD)"),
posted_before: z.string().optional().describe("LinkedIn posting date on or before (YYYY-MM-DD)"),
applied_after: z.string().optional().describe("Application submitted on or after (YYYY-MM-DD)"),
applied_before: z.string().optional().describe("Application submitted on or before (YYYY-MM-DD)"),
```

### Handler changes

In the handler function, destructure the 6 new params alongside the existing ones.

**created_at filters:** Since `created_at` is `timestamptz`, append time boundaries:
```typescript
if (created_after) q = q.gte("created_at", `${created_after}T00:00:00Z`);
if (created_before) q = q.lte("created_at", `${created_before}T23:59:59Z`);
```

**posted_date filters:** `posted_date` is a `DATE` column, no time conversion needed:
```typescript
if (posted_after) q = q.gte("posted_date", posted_after);
if (posted_before) q = q.lte("posted_date", posted_before);
```

**applied_date filters:** These require an inner join on `applications`, same pattern as the existing `status` filter. The join logic needs to account for three cases:
1. `status` is set (already inner joins) -- add applied_date filters to the same join
2. `applied_after/before` is set without `status` -- switch to inner join without status filter
3. Neither is set -- keep left join (existing behavior)

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

### No changes needed

- Database schema (all columns already exist)
- Response format
- Other tools
- Error handling patterns
- Tool description (update to mention date filters)

### Tool description update

Update the description to mention date filtering:

```
"Search job postings by text query (title/company/notes), status, source, URL, or date range. Shows application status if one exists. Use has_application filter to find postings with or without applications."
```

## Files to modify

1. `/Users/dfrysinger/Projects/open-brain/supabase/functions/job-hunt-mcp/index.ts` -- add params to schema, update handler logic and description
