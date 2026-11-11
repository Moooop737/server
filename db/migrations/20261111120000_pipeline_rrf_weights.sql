-- migrate:up

UPDATE pipeline_defs
SET nodes = (
  SELECT jsonb_agg(
    CASE
      WHEN node->>'component' = 'rrf_fusion'
        THEN jsonb_set(node, '{config}', (node->'config') || '{"a_weight": 1, "b_weight": 1}'::jsonb)
      ELSE node
    END
  )
  FROM jsonb_array_elements(nodes) AS node
),
updated_at = now()
WHERE id = 'default';

-- migrate:down

UPDATE pipeline_defs
SET nodes = (
  SELECT jsonb_agg(
    CASE
      WHEN node->>'component' = 'rrf_fusion'
        THEN jsonb_set(node, '{config}', (node->'config') - 'a_weight' - 'b_weight')
      ELSE node
    END
  )
  FROM jsonb_array_elements(nodes) AS node
),
updated_at = now()
WHERE id = 'default';
