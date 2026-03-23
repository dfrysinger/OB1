# Repo Consolidation: Merge open-brain-customizations into open-brain

## Problem

Two repos contain job-hunt MCP code:
- `open-brain` (fork of NateBJones-Projects/OB1) -- the deployment source
- `open-brain-customizations` -- an older repo with stale copies of function code plus unique local automation scripts

The customizations repo's function files have fallen out of sync with the fork, causing agents to edit the wrong file and deploy broken code (duplicate `update_job_posting` registration crashed the MCP server).

## Decision

Merge all unique content from `open-brain-customizations` into `open-brain` and archive the customizations repo. One repo, one source of truth.

## What Moves Where

### Move to `extensions/job-hunt/`

All unique content from customizations is job-hunt related, so it belongs alongside the extension:

| Source (customizations) | Destination (open-brain) |
|---|---|
| `launchd/*.plist` (5 files: `com.openbrain.daily-status-checkin.plist`, `com.openbrain.daily-status-kickoff.plist`, `com.openbrain.daily-status-scorecard.plist`, `com.openbrain.daily-status-warning.plist`, `com.openbrain.enrich-jobs.plist`) | `extensions/job-hunt/launchd/` |
| `scripts/*.ts` + `migration-dry-run.json` | `extensions/job-hunt/scripts/` |
| `lib/*.ts` (5 modules: email, slack, pipeline-stats, source-handlers, status-messages) | `extensions/job-hunt/lib/` |
| `test/*.test.ts` (2 files) | `extensions/job-hunt/test/` |
| `scheduled-tasks/auto-resume-generator.md` | `extensions/job-hunt/scheduled-tasks/` |

### Move to `docs/superpowers/`

| Source (customizations) | Destination (open-brain) |
|---|---|
| `docs/superpowers/plans/*` | `docs/superpowers/plans/` |
| `docs/superpowers/specs/*` | `docs/superpowers/specs/` |

### Discard (stale duplicates already in open-brain)

| File | Reason |
|---|---|
| `functions/job-hunt-mcp/index.ts` | Stale 36K copy. Deployed version is 57K in `supabase/functions/job-hunt-mcp/index.ts` |
| `functions/job-hunt-mcp/handlers.ts` | Same file exists in `supabase/functions/job-hunt-mcp/handlers.ts` |
| `functions/ingest-thought-modified.ts` | Already integrated into `supabase/functions/ingest-thought/index.ts` |
| `functions/open-brain-mcp-modified.ts` | Already integrated into `supabase/functions/open-brain-mcp/index.ts` |
| `schema/hybrid-search.sql` | Content already applied to DB and covered by main repo |
| `schema/job-hunt.sql` | Superseded by `extensions/job-hunt/schema.sql` plus migrations |
| `README.md` | References the old two-repo setup, no longer accurate |

### Update `extensions/job-hunt/schema.sql`

The current `schema.sql` is missing tables and columns that were added via `supabase/migrations/`. Update it to be the complete, definitive schema. Verified all migrations are applied to the live database.

**Missing from current schema.sql:**
- `networking_status` column on `job_postings` (text, default 'not_started')
- `has_network_connections` column on `job_postings` (boolean)
- `posting_contacts` table (junction: contacts to postings with relationship type)
- `daily_stats` table (tracking targets and streaks)
- `job_contact` added to `attribution_log` entity_type constraint
- `url` unique constraint on `job_postings`

After updating schema.sql, delete `supabase/migrations/` since those incremental patches are now captured in the definitive schema.

### Update file paths

Launchd plist files and scripts reference paths in `open-brain-customizations`. Update all paths to point to `open-brain/extensions/job-hunt/`.

Grep for:
- `open-brain-customizations`
- Any hardcoded paths to the old repo location

### Archive

1. Update `open-brain-customizations` README to say "Archived. Merged into dfrysinger/OB1."
2. Archive the GitHub repo (Settings > Archive)

## Implementation Order

1. Update `extensions/job-hunt/schema.sql` to complete schema
2. Delete `supabase/migrations/`
3. Copy unique content from customizations into `extensions/job-hunt/`
4. Copy design docs into `docs/superpowers/`
5. Update file paths in launchd plists and scripts
6. Verify nothing references `open-brain-customizations`. Grep these locations:
   - All launchd plist files for old paths
   - All scripts in `extensions/job-hunt/scripts/` for import paths
   - `~/.claude/agents/` for repo references
   - `~/.claude/scheduled-tasks/` for repo references
   - Claude Desktop config (`~/Library/Application Support/Claude/`)
   - Any `deno.json` or import maps that reference the old repo
7. Commit to open-brain fork
8. Archive customizations repo on GitHub (reversible via GitHub Settings if something breaks)

## Risks

- **Launchd plists reference old paths:** Must update in step 5 before archiving or scheduled tasks break.
- **Upstream merges:** The `extensions/job-hunt/` directory in upstream OB1 is the extension template. Our added subdirectories (launchd, scripts, lib) won't conflict since upstream doesn't have them, but the `schema.sql` and `index.ts` could conflict on upstream pulls. This is already the case with the fork's other changes and is manageable.
