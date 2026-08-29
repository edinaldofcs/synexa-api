/**
 * Constantes de ferramentas do pipeline de IA (fonte única).
 *
 * - LEGACY_TOOL_NAMES: nomes legados gravados por seeds/versões antigas que
 *   NÃO correspondem a ferramentas reais; são ignorados ao carregar as tools
 *   do agente (text e voice).
 * - RAG_SEARCH_TOOL_ID: functionName da tool nativa de busca RAG.
 * - HANDOFF_TOOL_NAME: tool nativa habilitável por agente via
 *   allowed_tool_names para transferir o atendimento a um humano.
 */
export const LEGACY_TOOL_NAMES = new Set([
  'execute_api',
  'search_knowledge_base',
  'search_web',
  'set_variable',
  'save_crm_data',
  'update_crm_data',
]);

export const RAG_SEARCH_TOOL_ID = 'rag_search';

export const HANDOFF_TOOL_NAME = 'transfer_to_human';
