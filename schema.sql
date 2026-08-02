# Database schema for claude-bros (PostgreSQL)

-- Run this once to initialize the database
-- docker compose exec db psql -U bros -d claude_bros -f schema.sql

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    role TEXT DEFAULT '',
    scope TEXT DEFAULT '',
    status TEXT DEFAULT 'idle',
    status_at TIMESTAMPTZ,
    joined_at TIMESTAMPTZ DEFAULT now(),
    last_seen TIMESTAMPTZ DEFAULT now(),
    briefed_at TIMESTAMPTZ,
    hosts TEXT[] DEFAULT '{}'
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq BIGINT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    text TEXT NOT NULL,
    ts TIMESTAMPTZ DEFAULT now(),
    read_by JSONB DEFAULT '{}',
    reply_to UUID REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    owner TEXT,
    goal TEXT,
    depends_on TEXT[],
    active_form TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal);

-- Findings table
CREATE TABLE IF NOT EXISTS findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    finding_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    severity TEXT DEFAULT 'info',
    target TEXT,
    evidence TEXT,
    repro TEXT,
    status TEXT DEFAULT 'unverified',
    by_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_by ON findings(by_agent);

-- Goals table
CREATE TABLE IF NOT EXISTS goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Files table (for file_review tracking)
CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path TEXT UNIQUE NOT NULL,
    verdict TEXT DEFAULT 'unreviewed',
    note TEXT,
    reviews JSONB DEFAULT '[]',
    findings JSONB DEFAULT '[]',
    lines TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Environment variables table
CREATE TABLE IF NOT EXISTS env_vars (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Counters table
CREATE TABLE IF NOT EXISTS counters (
    kind TEXT PRIMARY KEY,
    value BIGINT NOT NULL DEFAULT 0
);

-- Insert default counters
INSERT INTO counters (kind, value) VALUES
    ('message', 0), ('task', 0), ('finding', 0), ('goal', 0), ('seq', 0)
ON CONFLICT (kind) DO NOTHING;

-- Aliases table
CREATE TABLE IF NOT EXISTS aliases (
    alias TEXT PRIMARY KEY,
    target TEXT NOT NULL
);

-- Digests table
CREATE TABLE IF NOT EXISTS digests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Log table
CREATE TABLE IF NOT EXISTS logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    meta JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);