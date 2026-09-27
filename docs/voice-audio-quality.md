# Qualidade do áudio telefônico

## Caminho e contrato

Gemini Live fornece PCM mono s16le a 24 kHz. `VoiceCallSession` entrega esse
formato aos adapters e sinaliza `finishAudio()` no fim da geração, inclusive
para saudações em cache. AudioSocket, Twilio, Vonage e CallFlex usam o pacer
compartilhado; a conversão ocorre antes da codificação do transporte.

`StreamingPcmResampler` aceita saída 8, 16 ou 24 kHz. Para 8/16 kHz usa FIR
polifásico de 255 coeficientes, janela Hamming e corte em 46,25% da taxa de
saída. O atraso de grupo é aproximadamente 5,3 ms em 8 kHz e 2,65 ms em 16 kHz.
Histórico, fase e byte parcial pertencem à instância da chamada. Em 24 kHz,
preserva as amostras sem filtragem. Não há novas dependências.

- Blocos arbitrários, inclusive com tamanho ímpar, preservam a continuidade.
- `finish()` escoa a cauda do filtro e completa somente o último frame de 20 ms
  com zeros. Também libera falas menores que os três frames do buffer inicial.
- `clear()` descarta áudio pendente e estado do filtro em interrupções.
- Música usa outro conversor, sem contaminar o histórico da fala.
- O teto da fila permanece em 15 segundos; atrasos de pelo menos um frame
  reposicionam o timer para evitar rajadas de compensação.
- O conversor estático legado permanece para outros caminhos. Não reutilizá-lo
  para saída telefônica contínua.

AudioSocket usa PCM s16le mono 8 kHz, tipo `0x10`. Esse formato não identifica
o codec SIP negociado. O campo existente `voiceData.codec` agora descreve
explicitamente o formato AudioSocket; confirmar PCMU/PCMA/Opus/etc. no Asterisk.
Não houve alteração de esquema HTTP ou banco; `finishAudio` é opcional no
contrato interno para manter compatibilidade com os demais adapters.

## Validação automatizada

Na raiz de `synexa-api`:

```powershell
npx jest --runInBand --runTestsByPath src/voice/audio/streaming-pcm-resampler.spec.ts src/voice/adapters/telephony-outbound-pacer.spec.ts src/voice/adapters/audiosocket/audiosocket.adapter.spec.ts src/voice/adapters/twilio/twilio-media-streams.adapter.spec.ts src/voice/adapters/vonage/vonage-voice.adapter.spec.ts src/voice/adapters/callflex/callflex.adapter.spec.ts src/voice/sessions/voice-call-session.spec.ts
npx tsx scripts/benchmark-telephony-audio.ts 50 5
```

Os testes verificam identidade entre conversão inteira e fragmentada, passagem
de 300–3400 Hz dentro de 1 dB, rejeição de 5/7 kHz acima de 40 dB em saída
8 kHz, silêncio, cauda, interrupção, fim idempotente, frames, limite de fila e
atrasos de timer. O benchmark usa tons locais e sinks em memória; não faz
chamadas, não usa chaves e não mede provedores, rede ou Asterisk.

Resultado local em Windows, 2026-09-27, 50 streams por 5 segundos de áudio:

| Medida | Resultado |
| --- | --- |
| Ganho a 300 / 1000 / 3400 Hz | -0,004 / -0,002 / +0,005 dB |
| Atenuação a 5000 / 7000 Hz | 67,3 / 70,0 dB |
| CPU do processo / tempo decorrido | 1032 ms / 5142 ms (~20% de um núcleo) |
| Frames enviados / descartados | 12550 / 0 |
| Falta de áudio durante geração | 0 frames |
| Fila máxima / fila restante ao terminar | 180 ms / 0 ms |
| Maior atraso do timer / ticks atrasados ≥20 ms | 36,7 ms / 177 |
| Atraso do event loop p99 | 31,5 ms |

Os atrasos medidos impedem usar este ensaio como garantia de latência ou de
capacidade da VPS. Repetir com a concorrência esperada na infraestrutura alvo.

## Observabilidade

Ao encerrar, cada pacer emite `telephony_output_summary`, com `sampleRate`,
`inputBytes`, `speechFrames`, `underflowFrames`, `droppedFrames`, `lateTicks`,
`maxLatenessMs`, `invalidPcmBytes` e `maxQueueMs`. Não registra PCM, credenciais,
transcrições ou números de telefone. `getMetrics()` também expõe `queuedMs`.

`underflowFrames` conta ticks sem áudio enquanto a geração está aberta; não
conta silêncio normal após `finish()`. `droppedFrames` conta excesso do teto de
fila, não descarte intencional por interrupção. `invalidPcmBytes` conta o byte
final sem par descartado no término de um turno.

## Validação pendente na VPS e nos softphones

Inspeção somente leitura em 2026-09-27: checkout raiz `511a2cf`, Asterisk
20.6.0; o JavaScript compilado do container `synexa-prod-voice` ainda continha
a redução sem filtro. Não havia chamadas ativas; o codec negociado não pôde
ser confirmado. Esta inspeção não implantou a correção.

Após implantação pelo procedimento `vps_deploy`:

1. Usar uma chamada controlada com a mesma fala sintética, sem dados pessoais,
   contendo vogais e sibilantes ("s", "ch", "f"). Comparar a origem PCM 24 kHz,
   a saída filtrada 8 kHz e a gravação recebida no softphone, alinhando o atraso
   e o volume. Reproduzir a mesma origem evita comparar gerações diferentes.
2. Durante a chamada, consultar `core show channel <canal>` no Asterisk para
   registrar apenas `NativeFormats`, `ReadFormat`, `WriteFormat` e tradução.
   Evitar exportar o restante do canal, que pode conter dados da chamada.
3. Repetir em Zoiper, MicroSIP e Linphone, mantendo rede, voz e ganho constantes.
   Incluir saudação curta, resposta longa, silêncio e interrupção no meio da fala.
4. Verificar os contadores de saída e as estatísticas RTP do softphone. Se a
   saída PCM estiver limpa e o recebido não, investigar tradução SIP, clipping,
   perda de pacotes e jitter sem atribuí-los ao conversor por suposição.
5. Aceitar a correção de produção apenas após ausência do chiado relatado,
   sem regressão em inteligibilidade, cortes ou tempo de interrupção.

Para reversão, restaurar a imagem anterior do serviço de voz pelo mesmo
procedimento de deploy. Não há migrações a desfazer.
