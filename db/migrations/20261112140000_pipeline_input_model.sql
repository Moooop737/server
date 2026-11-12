-- migrate:up

UPDATE pipeline_defs
SET nodes = (
  SELECT jsonb_agg(
    CASE
      WHEN Node->>'id' = 'q'
        THEN jsonb_set(Node, '{inputs}', '{"query": "input.query"}'::jsonb)
      WHEN Node->>'id' = 'embed'
        THEN jsonb_set(Node, '{inputs}', '{"text": "q.text", "model": "input.model"}'::jsonb)
      ELSE Node
    END
  )
  FROM jsonb_array_elements(nodes) AS Node
)
WHERE id = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(nodes) AS Item WHERE Item->>'id' = 'input'
  );

UPDATE pipeline_defs
SET nodes = '[{"id":"input","component":"input","config":{},"inputs":{},"position":{"x":160,"y":-240}}]'::jsonb || nodes,
    updated_at = now()
WHERE id = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(nodes) AS Item WHERE Item->>'id' = 'input'
  );

-- migrate:down

UPDATE pipeline_defs
SET nodes = (
  SELECT jsonb_agg(Item)
  FROM jsonb_array_elements(nodes) AS Item
  WHERE Item->>'id' <> 'input'
),
updated_at = now()
WHERE id = 'default';

UPDATE pipeline_defs
SET nodes = (
  SELECT jsonb_agg(
    CASE
      WHEN Node->>'id' = 'q'
        THEN jsonb_set(Node, '{inputs}', '{}'::jsonb)
      WHEN Node->>'id' = 'embed'
        THEN jsonb_set(Node, '{inputs}', '{"text": "q.text"}'::jsonb)
      ELSE Node
    END
  )
  FROM jsonb_array_elements(nodes) AS Node
),
updated_at = now()
WHERE id = 'default';
