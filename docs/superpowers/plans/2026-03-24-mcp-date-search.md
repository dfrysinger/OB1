# MCP Date Search Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 6 date filter parameters to `search_job_postings` in the job-hunt MCP server.

**Architecture:** Add `created_after`, `created_before`, `posted_after`, `posted_before`, `applied_after`, `applied_before` params with Zod regex validation. Replace the existing join block to unify status and applied_date inner-join logic. Apply date filters as PostgREST `gte`/`lte`/`lt` calls.

**Tech Stack:** TypeScript, Zod, Supabase PostgREST, Deno

**Spec:** `docs/superpowers/specs/2026-03-24-mcp-date-search-design.md`

---

### Task 1: Add date params to schema

**Files:**
- Modify: `supabase/functions/job-hunt-mcp/index.ts:740-749`

- [ ] **Step 1: Add date params to inputSchema**

At line 748 (after `created_by`), add:

```typescript
      created_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Postings added on or after this date (YYYY-MM-DD, UTC)"),
      created_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Postings added on or before this date (YYYY-MM-DD, UTC)"),
      posted_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("LinkedIn posting date on or after (YYYY-MM-DD)"),
      posted_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("LinkedIn posting date on or before (YYYY-MM-DD)"),
      applied_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Application submitted on or after (YYYY-MM-DD)"),
      applied_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Application submitted on or before (YYYY-MM-DD)"),
```

- [ ] **Step 2: Update tool description**

Change line 740 from:
```
"Search job postings by text query (title/company/notes), status, source, or exact URL. Shows application status if one exists. Use has_application filter to find postings with or without applications."
```
To:
```
"Search job postings by text query (title/company/notes), status, source, URL, or date range. Shows application status if one exists. Use has_application filter to find postings with or without applications."
```

- [ ] **Step 3: Update handler destructuring**

Change line 751 from:
```typescript
  async ({ query, status, source, url, priority, has_application, created_by }) => {
```
To:
```typescript
  async ({ query, status, source, url, priority, has_application, created_by, created_after, created_before, posted_after, posted_before, applied_after, applied_before }) => {
```

- [ ] **Step 4: Commit**

```
git add supabase/functions/job-hunt-mcp/index.ts
git commit -m "feat: add date filter params to search_job_postings schema"
```

---

### Task 2: Replace join block and add date filters

**Files:**
- Modify: `supabase/functions/job-hunt-mcp/index.ts:753-782`

- [ ] **Step 1: Replace the join block**

Replace lines 753-766 (the existing `if (status) / else` block):

```typescript
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
```

With:

```typescript
      // Build select — inner join when filtering by application fields
      const needsInnerJoin = !!status || !!applied_after || !!applied_before;
      let q;
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

- [ ] **Step 2: Add created_at and posted_date filters**

After the `created_by` filter block (after line 782), add:

```typescript
      if (created_after) q = q.gte("created_at", `${created_after}T00:00:00Z`);
      if (created_before) {
        const next = new Date(created_before);
        next.setDate(next.getDate() + 1);
        q = q.lt("created_at", `${next.toISOString().slice(0, 10)}T00:00:00Z`);
      }

      if (posted_after) q = q.gte("posted_date", posted_after);
      if (posted_before) q = q.lte("posted_date", posted_before);
```

- [ ] **Step 3: Commit**

```
git add supabase/functions/job-hunt-mcp/index.ts
git commit -m "feat: implement date filters in search_job_postings handler"
```

---

### Task 3: Deploy and test

**Files:**
- No file changes

- [ ] **Step 1: Deploy the updated edge function**

```bash
cd ~/Projects/open-brain
supabase functions deploy job-hunt-mcp --no-verify-jwt
```

- [ ] **Step 2: Test created_after filter**

Use the MCP tool `search_job_postings` with `created_after: "2026-03-23"`. Verify only postings created on or after March 23 are returned.

- [ ] **Step 3: Test posted_before filter**

Use `search_job_postings` with `posted_before: "2026-03-10"`. Verify only postings with `posted_date` on or before March 10 are returned. Postings with null `posted_date` should be excluded.

- [ ] **Step 4: Test applied_after filter**

Use `search_job_postings` with `applied_after: "2026-03-20"`. Verify only postings with applications submitted on or after March 20 are returned (inner join behavior).

- [ ] **Step 5: Test combined filters**

Use `search_job_postings` with `status: "applied"` and `applied_after: "2026-03-01"`. Verify both filters apply to the same inner join.

- [ ] **Step 6: Test invalid date format**

Use `search_job_postings` with `created_after: "yesterday"`. Verify Zod validation rejects it with an error.

- [ ] **Step 7: Commit and push**

```
git push
```
