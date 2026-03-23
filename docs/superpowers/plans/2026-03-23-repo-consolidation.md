# Repo Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge all unique content from `open-brain-customizations` into `open-brain` (the fork of OB1) and archive the customizations repo, establishing one repo as the single source of truth.

**Architecture:** Copy unique directories (launchd, scripts, lib, test, scheduled-tasks) into `extensions/job-hunt/`, copy docs into `docs/superpowers/`, update `schema.sql` to be the complete definitive schema, delete stale migrations, update all file paths in plists and installed LaunchAgents, then archive the old repo.

**Tech Stack:** Bash (file operations), SQL (schema), launchd (plist updates), GitHub CLI (archive)

**Spec:** `docs/superpowers/specs/2026-03-23-repo-consolidation-design.md`

---

### Task 1: Update extensions/job-hunt/schema.sql to complete definitive schema

**Files:**
- Modify: `/Users/dfrysinger/Projects/open-brain/extensions/job-hunt/schema.sql`

The current schema.sql is missing columns, tables, and constraint changes that were applied via migrations. Update it to reflect the full current database state.

- [ ] **Step 1: Add `has_network_connections` and `networking_status` columns to `job_postings`**

In the `job_postings` CREATE TABLE statement, add these two columns after `closing_date DATE,` and before `created_at`:

```sql
    has_network_connections BOOLEAN,
    networking_status TEXT DEFAULT 'not_started'
        CHECK (networking_status IN ('not_started', 'researched', 'outreach_in_progress', 'done')),
```

Also add `url TEXT UNIQUE,` (add the UNIQUE constraint to the existing `url TEXT,` line) and ensure `priority TEXT,` and `location TEXT,` columns are present.

- [ ] **Step 2: Add `posting_contacts` table**

After the `job_contacts` table and before the indexes section, add:

```sql
-- Table: posting_contacts
-- Junction table linking contacts to specific job postings with relationship type
CREATE TABLE IF NOT EXISTS posting_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_posting_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    job_contact_id UUID NOT NULL REFERENCES job_contacts(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL CHECK (relationship IN (
        'colleague', 'hiring_manager', 'confirmed_recruiter', 'recruiter',
        'recruiting_lead', 'network', 'mutual_intro', 'employee', 'executive'
    )),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE (job_posting_id, job_contact_id)
);
```

- [ ] **Step 3: Add `daily_stats` table**

After `posting_contacts`, add:

```sql
-- Table: daily_stats
-- Tracks daily targets and streaks for accountability
CREATE TABLE IF NOT EXISTS daily_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    track TEXT NOT NULL CHECK (track IN (
        'resume_creation', 'resume_review', 'contact_discovery',
        'outreach', 'application_submission'
    )),
    completed INTEGER NOT NULL DEFAULT 0,
    target INTEGER NOT NULL DEFAULT 5,
    deficit INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE (date, track)
);
```

- [ ] **Step 4: Add indexes for new tables**

In the indexes section, add:

```sql
CREATE INDEX IF NOT EXISTS idx_posting_contacts_posting
    ON posting_contacts(job_posting_id);
CREATE INDEX IF NOT EXISTS idx_posting_contacts_contact
    ON posting_contacts(job_contact_id);
```

- [ ] **Step 5: Add RLS for new tables**

In the RLS section, add:

```sql
ALTER TABLE posting_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY posting_contacts_policy ON posting_contacts
    FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE daily_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY daily_stats_policy ON daily_stats
    FOR ALL USING (true) WITH CHECK (true);
```

- [ ] **Step 6: Update `attribution_log` entity_type constraint**

Change the CHECK constraint on `attribution_log.entity_type` from:

```sql
    entity_type TEXT NOT NULL CHECK (entity_type IN ('job_posting', 'application')),
```

to:

```sql
    entity_type TEXT NOT NULL CHECK (entity_type IN ('job_posting', 'application', 'job_contact')),
```

- [ ] **Step 7: Verify the updated schema.sql**

Read back the file and confirm:
- `job_postings` has `has_network_connections`, `networking_status`, and `url UNIQUE`
- `posting_contacts` table exists with relationship CHECK constraint
- `daily_stats` table exists with track CHECK constraint
- Indexes for new tables exist
- RLS policies for new tables exist
- `attribution_log` entity_type includes `job_contact`

---

### Task 2: Delete stale migrations

**Files:**
- Delete: `/Users/dfrysinger/Projects/open-brain/supabase/migrations/20260320000000_job_hunt.sql`
- Delete: `/Users/dfrysinger/Projects/open-brain/supabase/migrations/20260322000000_source_attribution.sql`
- Delete: `/Users/dfrysinger/Projects/open-brain/supabase/migrations/20260323000000_networking_pipeline.sql`
- Delete: `/Users/dfrysinger/Projects/open-brain/supabase/migrations/20260323010000_rename_connection_count.sql`

All migrations have been verified as applied to the live database. The definitive schema.sql now captures the complete state.

- [ ] **Step 1: Delete all 4 migration files**

```bash
rm /Users/dfrysinger/Projects/open-brain/supabase/migrations/20260320000000_job_hunt.sql
rm /Users/dfrysinger/Projects/open-brain/supabase/migrations/20260322000000_source_attribution.sql
rm /Users/dfrysinger/Projects/open-brain/supabase/migrations/20260323000000_networking_pipeline.sql
rm /Users/dfrysinger/Projects/open-brain/supabase/migrations/20260323010000_rename_connection_count.sql
```

- [ ] **Step 2: Verify migrations directory is empty or gone**

```bash
ls /Users/dfrysinger/Projects/open-brain/supabase/migrations/
```

Expected: empty directory or "No such file or directory"

---

### Task 3: Copy unique content from customizations into open-brain

**Files:**
- Create directories: `extensions/job-hunt/{launchd,scripts,lib,test,scheduled-tasks}`
- Copy files from `~/Projects/open-brain-customizations/` to corresponding `extensions/job-hunt/` subdirectories

- [ ] **Step 1: Create target directories**

```bash
mkdir -p /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/launchd
mkdir -p /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scripts
mkdir -p /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/lib
mkdir -p /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/test
mkdir -p /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scheduled-tasks
```

- [ ] **Step 2: Copy launchd plists (5 files)**

```bash
cp /Users/dfrysinger/Projects/open-brain-customizations/launchd/*.plist /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/launchd/
```

Expected files: `com.openbrain.daily-status-{checkin,kickoff,scorecard,warning}.plist`, `com.openbrain.enrich-jobs.plist`

- [ ] **Step 3: Copy scripts (3 .ts files + 1 .json)**

```bash
cp /Users/dfrysinger/Projects/open-brain-customizations/scripts/daily-status.ts /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scripts/
cp /Users/dfrysinger/Projects/open-brain-customizations/scripts/enrich-job-postings.ts /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scripts/
cp /Users/dfrysinger/Projects/open-brain-customizations/scripts/migrate-thoughts-to-jobs.ts /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scripts/
cp /Users/dfrysinger/Projects/open-brain-customizations/scripts/migration-dry-run.json /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scripts/
```

- [ ] **Step 4: Copy lib modules (5 .ts files)**

```bash
cp /Users/dfrysinger/Projects/open-brain-customizations/lib/*.ts /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/lib/
```

Expected files: `email.ts`, `pipeline-stats.ts`, `slack.ts`, `source-handlers.ts`, `status-messages.ts`

- [ ] **Step 5: Copy test files (2 .test.ts files)**

```bash
cp /Users/dfrysinger/Projects/open-brain-customizations/test/*.test.ts /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/test/
```

Expected files: `ingest-attribution.test.ts`, `migrate-attribution.test.ts`

- [ ] **Step 6: Copy scheduled-tasks**

```bash
cp /Users/dfrysinger/Projects/open-brain-customizations/scheduled-tasks/auto-resume-generator.md /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scheduled-tasks/
```

- [ ] **Step 7: Verify file counts**

```bash
ls /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/launchd/ | wc -l   # expect 5
ls /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scripts/ | wc -l   # expect 4
ls /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/lib/ | wc -l       # expect 5
ls /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/test/ | wc -l      # expect 2
ls /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scheduled-tasks/ | wc -l  # expect 1
```

---

### Task 4: Copy design docs into docs/superpowers/

**Files:**
- Create: `docs/superpowers/plans/` directory
- Copy: 2 plan files, 2 spec files from customizations

- [ ] **Step 1: Create plans directory and copy docs**

```bash
mkdir -p /Users/dfrysinger/Projects/open-brain/docs/superpowers/plans
cp /Users/dfrysinger/Projects/open-brain-customizations/docs/superpowers/plans/*.md /Users/dfrysinger/Projects/open-brain/docs/superpowers/plans/
cp /Users/dfrysinger/Projects/open-brain-customizations/docs/superpowers/specs/*.md /Users/dfrysinger/Projects/open-brain/docs/superpowers/specs/
```

- [ ] **Step 2: Verify docs copied**

```bash
ls /Users/dfrysinger/Projects/open-brain/docs/superpowers/plans/   # expect 2 files
ls /Users/dfrysinger/Projects/open-brain/docs/superpowers/specs/   # expect 3 files (2 copied + 1 existing consolidation spec)
```

---

### Task 5: Update file paths in launchd plists and scripts

**Files:**
- Modify: all 5 plist files in `extensions/job-hunt/launchd/`
- Modify: all 5 installed plist files in `~/Library/LaunchAgents/`

All plist files currently reference `/Users/dfrysinger/Projects/open-brain-customizations/scripts/`. Update to `/Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scripts/`.

The script import paths (`../lib/slack.ts`, etc.) are relative and will work correctly in the new location without changes.

- [ ] **Step 1: Update paths in repo plist files**

For each of the 5 plist files in `/Users/dfrysinger/Projects/open-brain/extensions/job-hunt/launchd/`, replace all occurrences of:
```
/Users/dfrysinger/Projects/open-brain-customizations/scripts/
```
with:
```
/Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scripts/
```

Also replace any occurrences of:
```
/Users/dfrysinger/Projects/open-brain-customizations/
```
with:
```
/Users/dfrysinger/Projects/open-brain/extensions/job-hunt/
```

- [ ] **Step 2: Verify no old paths remain in repo plists**

```bash
grep -r "open-brain-customizations" /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/launchd/
```

Expected: no output (no matches)

- [ ] **Step 3: Unload old plists from launchd, copy updated plists, reload**

The currently installed plists in `~/Library/LaunchAgents/` reference old paths. Unload them, copy the updated versions, and reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.openbrain.daily-status-kickoff.plist
launchctl unload ~/Library/LaunchAgents/com.openbrain.daily-status-checkin.plist
launchctl unload ~/Library/LaunchAgents/com.openbrain.daily-status-warning.plist
launchctl unload ~/Library/LaunchAgents/com.openbrain.daily-status-scorecard.plist
launchctl unload ~/Library/LaunchAgents/com.openbrain.enrich-jobs.plist
```

Then copy updated plists:
```bash
cp /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/launchd/*.plist ~/Library/LaunchAgents/
```

Then reload:
```bash
launchctl load ~/Library/LaunchAgents/com.openbrain.daily-status-kickoff.plist
launchctl load ~/Library/LaunchAgents/com.openbrain.daily-status-checkin.plist
launchctl load ~/Library/LaunchAgents/com.openbrain.daily-status-warning.plist
launchctl load ~/Library/LaunchAgents/com.openbrain.daily-status-scorecard.plist
launchctl load ~/Library/LaunchAgents/com.openbrain.enrich-jobs.plist
```

- [ ] **Step 4: Verify installed plists have correct paths**

```bash
grep -r "open-brain-customizations" ~/Library/LaunchAgents/com.openbrain.*.plist
```

Expected: no output (no matches)

```bash
grep "open-brain/extensions" ~/Library/LaunchAgents/com.openbrain.daily-status-kickoff.plist
```

Expected: shows the new path

---

### Task 6: Verify no references to old repo remain

**Files:**
- Read-only verification across multiple locations

- [ ] **Step 1: Check all scripts and lib files for old paths**

```bash
grep -r "open-brain-customizations" /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/
```

Expected: no output

- [ ] **Step 2: Check Claude agent files**

```bash
grep -r "open-brain-customizations" ~/.claude/agents/
```

Expected: no output

- [ ] **Step 3: Check Claude Desktop config**

```bash
grep -r "open-brain-customizations" ~/Library/Application\ Support/Claude/ 2>/dev/null
```

Expected: no output or directory not found

- [ ] **Step 4: Check for any deno.json or import maps**

```bash
find /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/ -name "deno.json" -o -name "import_map.json"
```

If any exist, verify they don't reference old paths.

- [ ] **Step 5: Check memory files for stale references**

```bash
grep -r "open-brain-customizations" ~/.claude/projects/-Users-dfrysinger-*/memory/
```

If matches found, note them for manual update.

---

### Task 7: Commit to open-brain fork

**Files:**
- All changes from Tasks 1-5

- [ ] **Step 1: Stage all changes**

From `/Users/dfrysinger/Projects/open-brain/`:

```bash
git add extensions/job-hunt/launchd/ extensions/job-hunt/scripts/ extensions/job-hunt/lib/ extensions/job-hunt/test/ extensions/job-hunt/scheduled-tasks/
git add extensions/job-hunt/schema.sql
git add docs/superpowers/plans/ docs/superpowers/specs/
git add -f supabase/migrations/  # force-add the deletions since supabase/ is gitignored
```

Note: `supabase/` directory is gitignored. Use `git add -f` for migration deletions, or use `git rm` if the files were previously force-added.

- [ ] **Step 2: Verify staged changes look correct**

```bash
git -C /Users/dfrysinger/Projects/open-brain status
git -C /Users/dfrysinger/Projects/open-brain diff --cached --stat
```

Expected: new files in extensions/job-hunt/{launchd,scripts,lib,test,scheduled-tasks}, modified schema.sql, deleted migration files, new docs

- [ ] **Step 3: Commit**

Write commit message to a temp file and commit:

Message: "feat: consolidate open-brain-customizations into extensions/job-hunt\n\nMerge all unique content from the customizations repo into the main\nfork. Moves launchd plists, scripts, lib modules, tests, and scheduled\ntasks into extensions/job-hunt/. Updates schema.sql to be the complete\ndefinitive schema and deletes stale migration files. Updates all file\npaths in launchd plists.\n\nCloses the two-repo split that was causing stale file edits and\nduplicate function registrations."

- [ ] **Step 4: Push**

```bash
git -C /Users/dfrysinger/Projects/open-brain push origin feat/job-hunt-linkedin-capture
```

---

### Task 8: Archive customizations repo

**Files:**
- Modify: `/Users/dfrysinger/Projects/open-brain-customizations/README.md`

- [ ] **Step 1: Update README to indicate archived status**

Replace the contents of `/Users/dfrysinger/Projects/open-brain-customizations/README.md` with:

```markdown
# open-brain-customizations (ARCHIVED)

This repo has been merged into [dfrysinger/OB1](https://github.com/dfrysinger/OB1) under `extensions/job-hunt/`.

All scripts, lib modules, launchd plists, and tests now live in the main Open Brain fork. This repo is archived and should not receive new commits.
```

- [ ] **Step 2: Commit and push the README update**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add README.md
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "chore: mark repo as archived, merged into dfrysinger/OB1"
git -C /Users/dfrysinger/Projects/open-brain-customizations push
```

- [ ] **Step 3: Archive the GitHub repo**

```bash
gh repo archive dfrysinger/open-brain-customizations --yes
```

This is reversible via GitHub Settings if something breaks.
