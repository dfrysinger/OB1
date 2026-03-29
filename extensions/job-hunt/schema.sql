-- Extension 6: Job Hunt Pipeline
-- Schema for tracking job search: companies, postings, applications, interviews, contacts

-- Table: companies
-- Organizations you're tracking in your job search
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    name TEXT NOT NULL,
    industry TEXT,
    website TEXT,
    size TEXT CHECK (size IN ('startup', 'mid-market', 'enterprise') OR size IS NULL),
    location TEXT,
    remote_policy TEXT CHECK (remote_policy IN ('remote', 'hybrid', 'onsite') OR remote_policy IS NULL),
    notes TEXT,
    glassdoor_rating DECIMAL(2,1) CHECK (glassdoor_rating >= 1.0 AND glassdoor_rating <= 5.0 OR glassdoor_rating IS NULL),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: job_postings
-- Specific roles at companies
CREATE TABLE IF NOT EXISTS job_postings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID,
    created_by TEXT DEFAULT 'legacy' NOT NULL,
    title TEXT,
    url TEXT UNIQUE,
    salary_min INTEGER,
    salary_max INTEGER,
    salary_currency TEXT DEFAULT 'USD',
    requirements TEXT[],
    nice_to_haves TEXT[],
    notes TEXT,
    source TEXT CHECK (source IN ('linkedin', 'company-site', 'referral', 'recruiter', 'other', 'greenhouse', 'lever', 'workday', 'indeed') OR source IS NULL),
    priority TEXT,
    location TEXT,
    enrichment_error TEXT,
    posted_date DATE,
    closing_date DATE,
    has_network_connections BOOLEAN,
    networking_status TEXT DEFAULT 'not_started'
        CHECK (networking_status IN ('not_started', 'researched', 'outreach_in_progress', 'done')),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: applications
-- Your submitted applications
CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_posting_id UUID REFERENCES job_postings(id) ON DELETE CASCADE NOT NULL,
    user_id UUID,
    created_by TEXT DEFAULT 'legacy' NOT NULL,
    status TEXT DEFAULT 'applied' CHECK (status IN ('draft', 'ready', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn')),
    applied_date DATE,
    response_date DATE,
    resume_version TEXT,
    resume_path TEXT,
    cover_letter_path TEXT,
    cover_letter_notes TEXT,
    referral_contact TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: interviews
-- Scheduled and completed interviews
CREATE TABLE IF NOT EXISTS interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES applications(id) ON DELETE CASCADE NOT NULL,
    user_id UUID,
    interview_type TEXT CHECK (interview_type IN ('phone_screen', 'technical', 'behavioral', 'system_design', 'hiring_manager', 'team', 'final')),
    scheduled_at TIMESTAMPTZ,
    duration_minutes INTEGER,
    interviewer_name TEXT,
    interviewer_title TEXT,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
    notes TEXT, -- pre-interview prep notes
    feedback TEXT, -- post-interview reflection
    rating INTEGER CHECK (rating >= 1 AND rating <= 5 OR rating IS NULL), -- your assessment of how it went
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: job_contacts
-- People associated with your job search
CREATE TABLE IF NOT EXISTS job_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    title TEXT,
    email TEXT,
    phone TEXT,
    linkedin_url TEXT,
    role_in_process TEXT CHECK (role_in_process IN ('recruiter', 'hiring_manager', 'referral', 'interviewer', 'other') OR role_in_process IS NULL),
    professional_crm_contact_id UUID, -- FK to Extension 5's professional_contacts table (not enforced by DB, managed by application)
    notes TEXT,
    last_contacted TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

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

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_companies_user_id
    ON companies(user_id);

CREATE INDEX IF NOT EXISTS idx_job_postings_company_id
    ON job_postings(company_id);

CREATE INDEX IF NOT EXISTS idx_applications_user_status
    ON applications(user_id, status);

CREATE INDEX IF NOT EXISTS idx_applications_job_posting
    ON applications(job_posting_id);

CREATE INDEX IF NOT EXISTS idx_interviews_application_scheduled
    ON interviews(application_id, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_interviews_user_scheduled
    ON interviews(user_id, scheduled_at)
    WHERE scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_contacts_user_company
    ON job_contacts(user_id, company_id);

CREATE INDEX IF NOT EXISTS idx_posting_contacts_posting
    ON posting_contacts(job_posting_id);
CREATE INDEX IF NOT EXISTS idx_posting_contacts_contact
    ON posting_contacts(job_contact_id);

-- Row Level Security (RLS)
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_contacts ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only see their own data
CREATE POLICY companies_user_policy ON companies
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY job_postings_user_policy ON job_postings
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY applications_user_policy ON applications
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY interviews_user_policy ON interviews
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY job_contacts_user_policy ON job_contacts
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

ALTER TABLE posting_contacts ENABLE ROW LEVEL SECURITY;
-- Open RLS: single-user system, access controlled at MCP server layer
CREATE POLICY posting_contacts_policy ON posting_contacts
    FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE daily_stats ENABLE ROW LEVEL SECURITY;
-- Open RLS: single-user system, access controlled at MCP server layer
CREATE POLICY daily_stats_policy ON daily_stats
    FOR ALL USING (true) WITH CHECK (true);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to update updated_at columns
DROP TRIGGER IF EXISTS update_companies_updated_at ON companies;
CREATE TRIGGER update_companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_applications_updated_at ON applications;
CREATE TRIGGER update_applications_updated_at
    BEFORE UPDATE ON applications
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Table: attribution_log
-- Tracks which actor (human or agent) created or changed records
CREATE TABLE IF NOT EXISTS attribution_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('job_posting', 'application', 'job_contact')),
    entity_id UUID NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    old_value TEXT,
    new_value TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attribution_log_entity
    ON attribution_log(entity_type, entity_id);

ALTER TABLE attribution_log ENABLE ROW LEVEL SECURITY;

-- Open RLS: single-user system, access controlled at MCP server layer
CREATE POLICY attribution_log_user_policy ON attribution_log
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Sample data (optional - uncomment to insert examples)
-- INSERT INTO companies (user_id, name, industry, size, remote_policy) VALUES
-- (auth.uid(), 'TechCorp', 'Enterprise Software', 'enterprise', 'remote');
