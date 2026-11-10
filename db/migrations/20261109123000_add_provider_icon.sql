-- migrate:up

ALTER TABLE providers ADD COLUMN icon text;
ALTER TABLE providers ADD CONSTRAINT providers_icon_length CHECK (
  icon IS NULL OR (btrim(icon) <> '' AND char_length(icon) <= 32)
);

-- migrate:down

ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_icon_length;
ALTER TABLE providers DROP COLUMN IF EXISTS icon;
