ALTER TABLE public.users ADD COLUMN invitation_pending BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.companies ADD COLUMN max_concurrent_calls INTEGER NOT NULL DEFAULT 5;
ALTER TABLE public.companies ADD CONSTRAINT companies_voice_limit_check CHECK (max_concurrent_calls BETWEEN 1 AND 1000);
