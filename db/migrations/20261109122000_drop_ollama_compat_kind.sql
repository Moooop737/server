-- migrate:up

ALTER TABLE providers DROP CONSTRAINT providers_kind_check;
ALTER TABLE providers DROP CONSTRAINT providers_base_url_check;

UPDATE providers SET kind = 'openai-compatible' WHERE kind = 'ollama-compat';

ALTER TABLE providers ADD CONSTRAINT providers_kind_check CHECK (
  kind IN ('deepseek', 'dashscope', 'openai-compatible', 'ollama')
);

ALTER TABLE providers ADD CONSTRAINT providers_base_url_check CHECK (
  (kind IN ('deepseek', 'dashscope') AND base_url IS NULL)
  OR (kind IN ('openai-compatible', 'ollama') AND base_url IS NOT NULL)
);

-- migrate:down

ALTER TABLE providers DROP CONSTRAINT providers_kind_check;
ALTER TABLE providers DROP CONSTRAINT providers_base_url_check;

ALTER TABLE providers ADD CONSTRAINT providers_kind_check CHECK (
  kind IN ('deepseek', 'dashscope', 'openai-compatible', 'ollama', 'ollama-compat')
);

ALTER TABLE providers ADD CONSTRAINT providers_base_url_check CHECK (
  (kind IN ('deepseek', 'dashscope') AND base_url IS NULL)
  OR (kind IN ('openai-compatible', 'ollama', 'ollama-compat') AND base_url IS NOT NULL)
);
