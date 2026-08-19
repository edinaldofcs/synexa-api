ALTER TABLE "painel_clients"
  DROP COLUMN IF EXISTS "strategy",
  DROP COLUMN IF EXISTS "color",
  DROP COLUMN IF EXISTS "phone_number",
  ADD COLUMN IF NOT EXISTS "logo_icon" VARCHAR(50);
