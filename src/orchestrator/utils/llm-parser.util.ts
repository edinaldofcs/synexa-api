import { Logger } from '@nestjs/common';

const logger = new Logger('LLMParser');

export function parseStructuredResponse(content: string | null): { text: string; action: string } {
  if (!content) {
    return { text: '', action: 'speak' };
  }

  let cleaned = content.trim();

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/```$/, '').trim();
    }
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (innerError) {
        logger.error(`Falha ao parsear JSON extraído: ${(innerError as Error).message}`);
      }
    }

    logger.error(`Falha ao parsear resposta JSON do LLM: ${content}`);
    return { text: content, action: 'speak' };
  }
}
