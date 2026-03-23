-- Networking Pipeline: new columns, tables, and indexes

-- Add networking columns to job_postings
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS connection_count INTEGER;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS networking_status TEXT DEFAULT 'not_started'
    CHECK (networking_status IN ('not_started', 'researched', 'outreach_in_progress', 'done'));

-- Junction table: contacts linked to specific postings
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

CREATE INDEX IF NOT EXISTS idx_posting_contacts_posting
    ON posting_contacts(job_posting_id);
CREATE INDEX IF NOT EXISTS idx_posting_contacts_contact
    ON posting_contacts(job_contact_id);

-- RLS
ALTER TABLE posting_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY posting_contacts_policy ON posting_contacts
    FOR ALL USING (true) WITH CHECK (true);

-- Daily stats for tracking targets and streaks
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

ALTER TABLE daily_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY daily_stats_policy ON daily_stats
    FOR ALL USING (true) WITH CHECK (true);

-- Expand attribution_log to support job_contact entity type
ALTER TABLE attribution_log DROP CONSTRAINT IF EXISTS attribution_log_entity_type_check;
ALTER TABLE attribution_log ADD CONSTRAINT attribution_log_entity_type_check
    CHECK (entity_type IN ('job_posting', 'application', 'job_contact'));
