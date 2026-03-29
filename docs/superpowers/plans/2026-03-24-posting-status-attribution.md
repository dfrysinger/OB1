# Posting Status and Attribution Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add posting status (active/closed) and old_value/new_value attribution tracking to the job-hunt pipeline.

**Architecture:** Schema migration adds two columns to attribution_log and one to job_postings. MCP handlers are updated to log per-field changes with old/new values, filter by posting status, and expose status as updatable. Automation scripts set status=closed on confirmed expired postings.

**Tech Stack:** TypeScript, Zod, Supabase PostgREST, Deno

**Spec:** `docs/superpowers/specs/2026-03-24-posting-status-attribution-design.md`

---

### Task 1: Schema migration

**Files:**
- Modify: `extensions/job-hunt/schema.sql:21-46,229-237`

- [ ] **Step 1: Add status column to job_postings in schema.sql**

In the `job_postings` table definition (line 45, before the closing `);`), add:

```sql
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed')),
```

- [ ] **Step 2: Add old_value/new_value to attribution_log in schema.sql**

In the `attribution_log` table definition (line 236, before `created_at`), add:

```sql
    old_value TEXT,
    new_value TEXT,
```

- [ ] **Step 3: Apply schema changes to live database**

Run via Supabase SQL editor or CLI:

```sql
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed'));
ALTER TABLE attribution_log ADD COLUMN IF NOT EXISTS old_value TEXT;
ALTER TABLE attribution_log ADD COLUMN IF NOT EXISTS new_value TEXT;
```

- [ ] **Step 4: Commit**

```
git add extensions/job-hunt/schema.sql
git commit -m "feat: add status to job_postings, old_value/new_value to attribution_log"
```

---

### Task 2: Update AttributionLogEntry and buildUpdateApplicationLogs

**Files:**
- Modify: `supabase/functions/job-hunt-mcp/handlers.ts:5-77`

- [ ] **Step 1: Add old_value/new_value to AttributionLogEntry interface**

At line 10 (after `reason`), add:

```typescript
  old_value?: string | null;
  new_value?: string | null;
```

- [ ] **Step 2: Populate old_value/new_value in buildUpdateApplicationLogs**

In the status_changed log entry (line 38-44), add old_value and new_value:

```typescript
    logs.push({
      entity_type: "application",
      entity_id: application_id,
      action: "status_changed",
      actor,
      reason: actor_reason ? `${transition} — ${actor_reason}` : transition,
      old_value: current.status,
      new_value: updates.status,
    });
```

In the resume_added/resume_removed log entry (line 51-57), add:

```typescript
      old_value: current.resume_path ?? null,
      new_value: updates.resume_path ?? null,
```

In the cover_letter_added/cover_letter_removed log entry (line 64-73), add:

```typescript
      old_value: current.cover_letter_path ?? null,
      new_value: updates.cover_letter_path ?? null,
```

- [ ] **Step 3: Commit**

```
git add supabase/functions/job-hunt-mcp/handlers.ts
git commit -m "feat: add old_value/new_value to attribution log entries"
```

---

### Task 3: Update update_job_posting handler for per-field attribution

**Files:**
- Modify: `supabase/functions/job-hunt-mcp/index.ts:1389-1499`

- [ ] **Step 1: Add status to inputSchema**

At line 1411 (after the last existing param in update_job_posting's inputSchema), add:

```typescript
      status: z.enum(["active", "closed"]).optional().describe("Posting status (active or closed)"),
```

- [ ] **Step 2: Add status to the update field assembly**

In the handler, where update fields are assembled (around lines 1417-1429), add after the existing field checks:

```typescript
    if (status !== undefined) updateFields.status = status;
```

Also add `status` to the handler's destructuring.

- [ ] **Step 3: Replace single-row attribution with per-field logging**

Replace the attribution logging block (lines 1459-1486) that builds a concatenated reason string and inserts one row. Replace with per-field logging.

First, expand the pre-read query (line 1440) to fetch all updatable fields:

```typescript
        .select("networking_status, has_network_connections, priority, title, status, url, location, source, salary_min, salary_max, salary_currency, notes, posted_date, closing_date")
```

Then replace the attribution block with:

```typescript
    // Attribution: log each changed field with old/new values
    const fieldChanges: Array<{ field: string; old_val: string | null; new_val: string | null }> = [];

    const stringFields = ["title", "status", "networking_status", "priority", "url", "location", "source", "salary_currency", "notes", "posted_date", "closing_date"] as const;
    for (const field of stringFields) {
      if (updateFields[field] !== undefined && String(updateFields[field] ?? "") !== String(current?.[field] ?? "")) {
        fieldChanges.push({ field, old_val: current?.[field] ?? null, new_val: String(updateFields[field] ?? null) });
      }
    }

    const numFields = ["salary_min", "salary_max"] as const;
    for (const field of numFields) {
      if (updateFields[field] !== undefined && String(updateFields[field] ?? "") !== String(current?.[field] ?? "")) {
        fieldChanges.push({ field, old_val: current?.[field] != null ? String(current[field]) : null, new_val: updateFields[field] != null ? String(updateFields[field]) : null });
      }
    }

    if (updateFields.has_network_connections !== undefined && String(updateFields.has_network_connections) !== String(current?.has_network_connections)) {
      fieldChanges.push({ field: "has_network_connections", old_val: String(current?.has_network_connections ?? null), new_val: String(updateFields.has_network_connections) });
    }

    for (const change of fieldChanges) {
      const reason = actor_reason
        ? `${change.field}: ${change.old_val} -> ${change.new_val} — ${actor_reason}`
        : `${change.field}: ${change.old_val} -> ${change.new_val}`;
      await supabase.from("attribution_log").insert({
        entity_type: "job_posting",
        entity_id: job_posting_id,
        action: "updated",
        actor: actor ?? "unknown",
        reason,
        old_value: change.old_val,
        new_value: change.new_val,
      });
    }

    // If no individual field changes detected but update succeeded, log a generic entry
    if (fieldChanges.length === 0) {
      await supabase.from("attribution_log").insert({
        entity_type: "job_posting",
        entity_id: job_posting_id,
        action: "updated",
        actor: actor ?? "unknown",
        reason: actor_reason ?? "Fields updated",
      });
    }
```

- [ ] **Step 4: Commit**

```
git add supabase/functions/job-hunt-mcp/index.ts
git commit -m "feat: per-field attribution logging with old/new values in update_job_posting"
```

---

### Task 4: Add posting_status filter to search_job_postings

**Files:**
- Modify: `supabase/functions/job-hunt-mcp/index.ts:741-755,757`

- [ ] **Step 1: Add posting_status to inputSchema**

At line 755 (after the last existing param), add:

```typescript
      posting_status: z.enum(["active", "closed"]).optional().describe("Filter by posting status (active or closed)"),
```

- [ ] **Step 2: Add posting_status to handler destructuring**

Add `posting_status` to the destructured params on line 757.

- [ ] **Step 3: Add the filter to the query**

After the existing filter blocks (around line 795, after the `created_by` filter), add:

```typescript
      if (posting_status) q = q.eq("status", posting_status);
```

- [ ] **Step 4: Commit**

```
git add supabase/functions/job-hunt-mcp/index.ts
git commit -m "feat: add posting_status filter to search_job_postings"
```

---

### Task 5: Exclude closed postings from get_networking_queue

**Files:**
- Modify: `supabase/functions/job-hunt-mcp/index.ts:1517-1526`

- [ ] **Step 1: Add status filter to the main query**

In the `get_networking_queue` handler, on the main postings query (around line 1521), add:

```typescript
      .eq("status", "active")
```

- [ ] **Step 2: Commit**

```
git add supabase/functions/job-hunt-mcp/index.ts
git commit -m "feat: exclude closed postings from networking queue"
```

---

### Task 6: Update enrichment cron for redirect vs 404 distinction

**Files:**
- Modify: `extensions/job-hunt/scripts/enrich-job-postings.ts:115-128,282-295`

- [ ] **Step 1: Set status=closed on redirect, leave active on 404**

In the redirect detection block (lines 115-128), when `!currentUrl.includes("/jobs/view/")`:

```typescript
      // Posting redirected away — confirmed expired
      const { error: skipErr } = await supabase
        .from("job_postings")
        .update({
          enrichment_error: `Redirected to non-job page: ${currentUrl.slice(0, 200)}`,
          status: "closed",
        })
        .eq("id", posting.id);
```

Also log the status change to attribution_log:

```typescript
      await supabase.from("attribution_log").insert({
        entity_type: "job_posting",
        entity_id: posting.id,
        action: "updated",
        actor: "enrichment-cron",
        reason: "status: active -> closed — posting redirected (expired)",
        old_value: "active",
        new_value: "closed",
      });
```

For the existing "Could not extract details" case (which is a page-loaded-but-unreadable case, similar to 404), leave status unchanged. Only set `enrichment_error`.

- [ ] **Step 2: Add old_value/new_value to the enriched attribution log**

In the enriched attribution log insert (lines 282-295), add `old_value: null, new_value: null` since this is not a field change:

```typescript
      const { error: attrErr } = await supabase
        .from("attribution_log")
        .insert({
          entity_type: "job_posting",
          entity_id: posting.id,
          action: "enriched",
          actor: "enrichment-cron",
          reason: `Scraped from LinkedIn: ${enrichedFields}`,
          old_value: null,
          new_value: null,
        });
```

- [ ] **Step 3: Commit**

```
git add extensions/job-hunt/scripts/enrich-job-postings.ts
git commit -m "feat: enrichment cron sets status=closed on redirect, distinguishes from 404"
```

---

### Task 7: Update backfill script for redirect vs 404 distinction

**Files:**
- Modify: `extensions/job-hunt/scripts/backfill-posted-dates.ts:120-140`

- [ ] **Step 1: Set status=closed on redirect only**

In the redirect/404 detection block, split the behavior:

```typescript
      const isRedirect = !currentUrl.includes("/jobs/view/");
      const is404 = pageText.includes("Page not found") || pageText.includes("no longer available");

      if (isRedirect) {
        const reason = "Expired (redirected)";
        console.log(`  EXPIRED ${label} — ${reason}`);
        if (!dryRun) {
          await supabase
            .from("job_postings")
            .update({ enrichment_error: reason, status: "closed" })
            .eq("id", posting.id);
          await supabase.from("attribution_log").insert({
            entity_type: "job_posting",
            entity_id: posting.id,
            action: "updated",
            actor: "backfill-posted-dates",
            reason: "status: active -> closed — posting redirected (expired)",
            old_value: "active",
            new_value: "closed",
          });
        } else {
          console.log(`  WOULD FLAG as expired and closed`);
        }
        expired++;
      } else if (is404) {
        console.log(`  404 ${label} — page not found (leaving active)`);
        if (!dryRun) {
          await supabase
            .from("job_postings")
            .update({ enrichment_error: "Page not found (may be bad link)" })
            .eq("id", posting.id);
        } else {
          console.log(`  WOULD FLAG enrichment error (not closing)`);
        }
        skipped++;
      }
```

- [ ] **Step 2: Commit**

```
git add extensions/job-hunt/scripts/backfill-posted-dates.ts
git commit -m "feat: backfill script distinguishes redirect (close) from 404 (flag only)"
```

---

### Task 8: Migration and deploy

**Files:**
- No file changes (SQL run directly)

- [ ] **Step 1: Migrate existing expired postings**

Run via Supabase SQL editor or a script:

```sql
-- Close redirected postings (from backfill script)
UPDATE job_postings SET status = 'closed'
WHERE enrichment_error LIKE '%Expired (redirected)%'
  AND status = 'active';

-- Close redirected postings (from enrichment cron)
UPDATE job_postings SET status = 'closed'
WHERE enrichment_error LIKE '%Redirected to non-job page%'
  AND status = 'active';
```

Then log each to attribution_log:

```sql
INSERT INTO attribution_log (entity_type, entity_id, action, actor, reason, old_value, new_value)
SELECT 'job_posting', id, 'updated', 'migration', 'status: active -> closed — migrated existing expired posting', 'active', 'closed'
FROM job_postings
WHERE status = 'closed'
  AND id NOT IN (SELECT entity_id FROM attribution_log WHERE actor = 'migration' AND action = 'updated');
```

- [ ] **Step 2: Deploy the updated edge function**

```bash
cd ~/Projects/open-brain && supabase functions deploy job-hunt-mcp --no-verify-jwt
```

- [ ] **Step 3: Test posting_status filter**

Use MCP `search_job_postings` with `posting_status: "active"`. Verify closed postings are excluded.

Use `search_job_postings` with `posting_status: "closed"`. Verify only closed postings returned.

- [ ] **Step 4: Test update_job_posting status change**

Use MCP `update_job_posting` to set a test posting to `status: "closed"`. Verify the attribution_log has `old_value: "active"`, `new_value: "closed"`. Then set it back to `active`.

- [ ] **Step 5: Test get_networking_queue excludes closed**

Use MCP `get_networking_queue`. Verify no closed postings appear.

- [ ] **Step 6: Push**

```
git push
```
