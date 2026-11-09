-- migrate:up

ALTER TABLE providers ADD COLUMN options jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE providers ADD CONSTRAINT providers_options_object CHECK (jsonb_typeof(options) = 'object');

-- migrate:down

ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_options_object;
ALTER TABLE providers DROP COLUMN IF EXISTS options;
