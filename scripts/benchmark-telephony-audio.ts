/** Offline DSP + real-time pacer benchmark; no network, providers or customer audio. */
import { Logger } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { StreamingPcmResampler } from '../src/voice/audio/streaming-pcm-resampler';
import { TelephonyOutboundPacer } from '../src/voice/adapters/telephony-outbound-pacer';

function tone(hz: number, samples = 24000): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(
      Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / 24000)),
      i * 2,
    );
  }
  return pcm;
}
function rms(pcm: Buffer): number {
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(energy / (pcm.length / 2));
}
function measureGain(hz: number): number {
  const input = tone(hz);
  const output = new StreamingPcmResampler(8000).push(input);
  return 20 * Math.log10(rms(output.subarray(800)) / rms(input));
}

async function main(): Promise<void> {
  const calls = Number(process.argv[2] ?? 50);
  const seconds = Number(process.argv[3] ?? 5);
  if (
    !Number.isInteger(calls) ||
    calls < 1 ||
    calls > 200 ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 60
  ) {
    throw new Error(
      'Usage: npx tsx scripts/benchmark-telephony-audio.ts [calls:1..200] [seconds:1..60]',
    );
  }
  Logger.overrideLogger(false);
  const spectrum = [300, 1000, 3400, 5000, 7000].map((hz) => ({
    hz,
    gainDb: measureGain(hz),
  }));
  const audio = tone(1000, 480); // 20 ms.
  const pacers = Array.from(
    { length: calls },
    () => new TelephonyOutboundPacer(() => undefined),
  );
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const intervals: number[] = [];
  let previous = start;
  // 60ms initial buffer, matching production. Generation then feeds 20ms per tick.
  for (const pacer of pacers)
    pacer.enqueue(Buffer.concat([audio, audio, audio]));
  let frames = 3;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const now = performance.now();
      intervals.push(now - previous);
      previous = now;
      // Generate against the audio clock, not callback count: setInterval drift
      // must not artificially slow the source and masquerade as DSP starvation.
      const targetFrames = Math.min(
        seconds * 50,
        3 + Math.floor((now - start) / 20),
      );
      while (frames < targetFrames) {
        for (const pacer of pacers) pacer.enqueue(audio);
        frames++;
      }
      if (frames >= seconds * 50) {
        clearInterval(timer);
        for (const pacer of pacers) pacer.finish();
        // Keep the benchmark alive until all final frames have actually drained.
        const drain = () => {
          if (pacers.every((pacer) => pacer.getMetrics().queuedMs === 0))
            resolve();
          else setTimeout(drain, 20);
        };
        setTimeout(drain, 20);
        return;
      }
    }, 20);
  });
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const summaries = pacers.map((pacer) => pacer.getMetrics());
  for (const pacer of pacers) pacer.dispose();
  loop.disable();
  intervals.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        calls,
        seconds,
        wallMs,
        cpuMs: (cpu.user + cpu.system) / 1000,
        cpuPercentOfOneCore: (cpu.user + cpu.system) / (wallMs * 10),
        inputIntervalP95Ms: intervals[Math.floor(intervals.length * 0.95)],
        eventLoopP99Ms: loop.percentile(99) / 1e6,
        maxQueueMs: Math.max(...summaries.map((s) => s.maxQueueMs)),
        maxLatenessMs: Math.max(...summaries.map((s) => s.maxLatenessMs)),
        underflowFrames: summaries.reduce((n, s) => n + s.underflowFrames, 0),
        droppedFrames: summaries.reduce((n, s) => n + s.droppedFrames, 0),
        lateTicks: summaries.reduce((n, s) => n + s.lateTicks, 0),
        remainingQueueMs: Math.max(...summaries.map((s) => s.queuedMs)),
        speechFrames: summaries.reduce((n, s) => n + s.speechFrames, 0),
        spectrum,
      },
      null,
      2,
    ),
  );
}
void main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
