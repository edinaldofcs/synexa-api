/**
 * Telephony Adapter Interface
 * Contrato padrão para desacoplar qualquer canal de telefonia / voz da camada de IA e orquestração.
 */

export interface TelephonyCallMetadata {
  channelId?: string;
  uniqueId?: string;
  callerNumber?: string;
  callerName?: string;
  didNumber?: string;
  queue?: string;
  campaignId?: string;
  leadId?: string;
  protocol?: string;
  customVariables?: Record<string, string | unknown>;
  [key: string]: unknown;
}

export interface ITelephonyAdapter {
  /**
   * Identificador único da sessão/chamada.
   */
  readonly id: string;

  /**
   * Nome legível do provedor de telefonia (ex: 'asterisk_fastagi', 'callflex', 'web_webrtc', 'twilio').
   */
  readonly providerName: string;

  /**
   * Metadados e variáveis da chamada/URA. Mutável: adapters em streaming
   * (WS de discador) enriquecem os metadados após o frame de identificação.
   */
  metadata: TelephonyCallMetadata;

  /**
   * Taxa de amostragem nativa de áudio enviada pelo transporte (geralmente 8000 para telefonia ou 16000 para Web).
   */
  readonly sampleRate: number;

  /**
   * Inicia o transporte e estabelece a comunicação com o canal.
   */
  start(): Promise<void>;

  /**
   * Envia um bloco de áudio PCM 16-bit LE de volta para o telefone/cliente.
   */
  sendAudio(pcm16: Buffer): Promise<void> | void;

  /**
   * Envia um dígito DTMF para a chamada (se suportado).
   */
  sendDTMF?(digit: string): Promise<void> | void;

  /**
   * Descarta áudio ainda não reproduzido (fila de saída). Chamado em
   * barge-in/interrupção para que a IA pare imediatamente de falar.
   */
  clearQueuedAudio?(): void;

  /**
   * Encerra e desliga a chamada no PBX/Telefonia.
   */
  hangup(reason?: string): Promise<void> | void;

  /**
   * Define uma variável de canal no PBX (ex: Asterisk SET VARIABLE ou CallFlex parameter).
   */
  setVariable?(key: string, value: string): Promise<void> | void;

  /**
   * Obtém o valor de uma variável da chamada.
   */
  getVariable?(key: string): string | undefined;

  /**
   * Transfere a chamada para outro ramal, fila ou número externo.
   */
  transferCall?(destination: string): Promise<boolean>;

  /**
   * Callback disparado quando um novo pacote de áudio PCM 16-bit do usuário chega do transporte.
   */
  onAudio(callback: (pcm16: Buffer) => void): void;

  /**
   * Callback disparado quando a chamada é atendida/conectada.
   */
  onCallStart(callback: () => void): void;

  /**
   * Callback disparado quando a chamada é encerrada pelo cliente ou PBX.
   */
  onCallEnd(callback: (reason?: string) => void): void;

  /**
   * Callback disparado quando um dígito DTMF é pressionado pelo usuário.
   */
  onDTMF?(callback: (digit: string) => void): void;

  /**
   * Callback disparado quando uma variável da chamada é atualizada.
   */
  onVariable?(callback: (key: string, value: string) => void): void;

  /**
   * Callback disparado em caso de erro no transporte de telefonia.
   */
  onError(callback: (err: Error) => void): void;

  /**
   * Encerra e limpa todos os recursos e sockets do adapter.
   */
  close(): Promise<void> | void;

  /**
   * Opcional: aguarda o provedor identificar a chamada (frame/handshake de
   * metadados). Usado por ingressos em streaming (WS de discador) antes de
   * rotear a chamada. Retorna false se expirar sem identificação.
   */
  waitForIdentification?(timeoutMs: number): Promise<boolean>;

  /**
   * Opcional: ingestão direta de mensagens do transporte. Usado pelo
   * ingresso WS para reproduzir mensagens recebidas antes da criação do
   * adapter (ex.: Twilio envia connected/start imediatamente ao abrir o WS).
   */
  handleRawMessage?(data: unknown, isBinary?: boolean): void;
}
