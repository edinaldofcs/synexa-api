import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface TabulationResult {
  code: string;
  notes: string;
  confidence: number;
}

@Injectable()
export class TabulationService {
  private readonly logger = new Logger(TabulationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Obtém a chave do Gemini (prioridade: provider_credentials do cliente > env GEMINI_API_KEY)
   */
  private async getGeminiApiKey(clientId?: string): Promise<string | null> {
    if (clientId) {
      try {
        const cred = await this.prisma.provider_credentials.findFirst({
          where: { client_id: clientId, provider: 'gemini', status: 'active' },
        });
        if (cred?.api_key_enc && !cred.api_key_enc.startsWith('enc:')) {
          return cred.api_key_enc;
        }
      } catch (e) {
        this.logger.warn(`Erro ao buscar provider_credentials para cliente ${clientId}: ${(e as Error).message}`);
      }
    }
    return (
      this.configService.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY ||
      null
    );
  }

  /**
   * Tabula uma conversa analisando todo o histórico e focando no desfecho da última interação
   */
  async tabulateConversation(conversationId: string): Promise<{
    success: boolean;
    track_id?: string | null;
    notes?: string;
    tabulated_by: string;
  }> {
    const conv = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: { created_at: 'asc' },
        },
      },
    });

    if (!conv || !conv.client_id) {
      throw new NotFoundException(`Conversa ${conversationId} não encontrada ou sem cliente vinculado.`);
    }

    const tracks = await this.prisma.painel_tracks.findMany({
      where: { client_id: conv.client_id, is_active: true },
      orderBy: [{ display_order: 'asc' }, { created_at: 'asc' }],
    });

    if (tracks.length === 0) {
      this.logger.warn(`Cliente ${conv.client_id} não possui trilhas/tabulações ativas cadastradas.`);
      return { success: false, notes: 'Sem tabulações cadastradas', tabulated_by: 'none' };
    }

    const messages = conv.messages || [];
    if (messages.length === 0) {
      this.logger.debug(`Conversa ${conversationId} não tem mensagens para tabular.`);
      return { success: false, notes: 'Conversa vazia', tabulated_by: 'none' };
    }

    // Identificar a última mensagem do usuário
    const userMessages = messages.filter(
      (m) => m.sender_type === 'user' || m.sender_type === 'customer',
    );
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';

    // Montar histórico textual completo da conversa
    const formattedTranscript = messages
      .map((m, idx) => {
        const sender =
          m.sender_type === 'user' || m.sender_type === 'customer'
            ? 'CLIENTE'
            : m.sender_type === 'ai' || m.sender_type === 'agent'
              ? 'ASSISTENTE'
              : 'OPERADOR_HUMANO';
        return `[#${idx + 1} ${sender}]: ${m.content || '(sem texto)'}`;
      })
      .join('\n');

    // Montar catálogo de opções de tabulação
    const optionsSummary = tracks
      .map((t) => {
        const examplesStr = Array.isArray(t.examples) && t.examples.length > 0
          ? ` (Exemplos: ${t.examples.slice(0, 4).join(', ')})`
          : '';
        return `- Código: "${t.code}" | Categoria: "${t.category || 'Geral'}" | Nome: "${t.label}"\n  Descrição: ${t.description}${examplesStr}`;
      })
      .join('\n\n');

    let result: TabulationResult | null = null;
    const apiKey = await this.getGeminiApiKey(conv.client_id);

    if (apiKey) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
          model: 'gemini-1.5-flash',
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        });

        const prompt = `Você é um especialista em auditoria e tabulação de atendimentos.
Sua missão é classificar este atendimento escolhendo estritamente uma das opções de tabulação disponíveis.

REGRAS:
1. Analise todo o histórico da conversa para compreender o contexto global.
2. Dê peso determinante para a ÚLTIMA interação e solicitação final do cliente (o desfecho do contato).
3. Escolha o "code" exato de uma das opções de tabulação fornecidas.
4. Responda APENAS com um objeto JSON válido no formato:
{
  "code": "codigo_exato_da_opcao",
  "notes": "Resumo executivo em 1 ou 2 frases justificando a escolha e o desfecho",
  "confidence": 0.95
}

--- CATÁLOGO DE TABULAÇÕES DISPONÍVEIS ---
${optionsSummary}

--- HISTÓRICO COMPLETO DA CONVERSA ---
${formattedTranscript}

Última mensagem do cliente: "${lastUserMessage}"`;

        const response = await model.generateContent(prompt);
        const text = response.response.text();
        result = JSON.parse(text) as TabulationResult;
      } catch (err) {
        this.logger.warn(
          `Falha ao tabular com Gemini para conversa ${conversationId}: ${(err as Error).message}. Usando fallback heurístico.`,
        );
      }
    }

    // Fallback heurístico caso a chamada da IA não esteja disponível ou falhe
    if (!result || !result.code) {
      result = this.fallbackKeywordMatching(lastUserMessage, formattedTranscript, tracks);
    }

    // Encontrar a track correspondente
    const matchedTrack =
      tracks.find((t) => t.code.toLowerCase() === result?.code?.toLowerCase()) ||
      tracks.find((t) => t.label.toLowerCase() === result?.code?.toLowerCase()) ||
      tracks[0];

    // Preservar histórico anterior se for uma retabulação
    const previousHistory = Array.isArray(conv.tabulation_history)
      ? (conv.tabulation_history as any[])
      : [];

    let updatedHistory = previousHistory;
    if (conv.tabulated_at) {
      updatedHistory = [
        ...previousHistory,
        {
          track_id: conv.track_id,
          tabulated_at: conv.tabulated_at,
          tabulated_by: conv.tabulated_by,
          notes: conv.tabulation_notes,
        },
      ];
    }

    await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        track_id: matchedTrack.id,
        tabulation_notes: result.notes || `Tabulado automaticamente como ${matchedTrack.label}`,
        tabulated_at: new Date(),
        tabulated_by: 'ai',
        tabulation_history: updatedHistory,
      },
    });

    this.logger.log(
      `Conversa ${conversationId} tabulada com sucesso como "${matchedTrack.label}" (${matchedTrack.code}).`,
    );

    return {
      success: true,
      track_id: matchedTrack.id,
      notes: result.notes,
      tabulated_by: 'ai',
    };
  }

  /**
   * Tabulação manual pelo operador humano
   */
  async manualTabulate(
    conversationId: string,
    trackId: string,
    notes?: string,
    operatorId?: string,
    companyId?: string,
  ) {
    const conv = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
    });

    if (!conv || (companyId && conv.company_id !== companyId)) {
      throw new NotFoundException('Conversa não encontrada');
    }

    const track = await this.prisma.painel_tracks.findUnique({
      where: { id: trackId },
    });

    if (!track) {
      throw new NotFoundException(`Tabulação ${trackId} não encontrada`);
    }

    const previousHistory = Array.isArray(conv.tabulation_history)
      ? (conv.tabulation_history as any[])
      : [];

    let updatedHistory = previousHistory;
    if (conv.tabulated_at) {
      updatedHistory = [
        ...previousHistory,
        {
          track_id: conv.track_id,
          tabulated_at: conv.tabulated_at,
          tabulated_by: conv.tabulated_by,
          notes: conv.tabulation_notes,
        },
      ];
    }

    return this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        track_id: track.id,
        tabulation_notes: notes || `Tabulado manualmente como ${track.label}`,
        tabulated_at: new Date(),
        tabulated_by: operatorId || 'operator',
        tabulation_history: updatedHistory,
      },
      include: {
        painel_tracks: true,
      },
    });
  }

  /**
   * Fallback heurístico baseado em palavras-chave e exemplos
   */
  private fallbackKeywordMatching(
    lastUserMsg: string,
    fullTranscript: string,
    tracks: Array<{ id: string; code: string; label: string; description: string; examples?: any }>,
  ): TabulationResult {
    const textTarget = (lastUserMsg + ' ' + fullTranscript).toLowerCase();

    let bestScore = -1;
    let selectedTrack = tracks[0];

    for (const track of tracks) {
      let score = 0;
      const codeTerms = track.code.toLowerCase().split('_');
      for (const term of codeTerms) {
        if (term.length > 2 && textTarget.includes(term)) score += 3;
      }
      const labelTerms = track.label.toLowerCase().split(' ');
      for (const term of labelTerms) {
        if (term.length > 2 && textTarget.includes(term)) score += 2;
      }

      if (Array.isArray(track.examples)) {
        for (const ex of track.examples) {
          if (typeof ex === 'string') {
            const exTerms = ex.toLowerCase().split(' ');
            for (const t of exTerms) {
              if (t.length > 3 && textTarget.includes(t)) score += 1;
            }
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        selectedTrack = track;
      }
    }

    return {
      code: selectedTrack.code,
      notes: `Classificado com base em padrões textuais da última interação: ${selectedTrack.label}`,
      confidence: bestScore > 0 ? 0.7 : 0.4,
    };
  }
}
