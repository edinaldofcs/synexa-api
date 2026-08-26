-- Remove nomes legados de ferramentas (de seeds/versões antigas) que não
-- correspondem a ferramentas reais. As tools disponíveis devem ser apenas
-- as selecionadas no formulário do agente.

UPDATE painel_agents
SET allowed_tool_names = (
  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
  FROM jsonb_array_elements_text(allowed_tool_names::jsonb) AS elem
  WHERE elem NOT IN ('execute_api', 'search_knowledge_base', 'search_web')
)
WHERE allowed_tool_names IS NOT NULL
  AND jsonb_typeof(allowed_tool_names::jsonb) = 'array'
  AND allowed_tool_names::jsonb ?| ARRAY['execute_api', 'search_knowledge_base', 'search_web'];
