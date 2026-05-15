// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import { FallbackAdapter } from './fallback_adapter.js';
import type { STT, SpeechEvent } from './stt.js';
import { FakeSTT, RecognizeSentinel, emptyAudioFrame } from './testing/fake_stt.js';

describe('FallbackAdapter', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    // Suppress unhandled rejections from SpeechStream background tasks in tests
    // where we exercise failure paths without consuming the iterator.
    process.on('unhandledRejection', () => {});
  });

  it('throws if no STT instances are provided', () => {
    expect(() => new FallbackAdapter({ sttInstances: [] })).toThrow(/at least one STT instance/);
  });

  it('throws if a non-streaming STT is provided without a VAD', () => {
    const nonStreaming = new FakeSTT({
      label: 'non-streaming',
      capabilities: { streaming: false, interimResults: false },
    });
    expect(() => new FallbackAdapter({ sttInstances: [nonStreaming] })).toThrow(
      /do not support streaming/,
    );
  });

  it('exposes provided instances and telephony-tuned defaults', () => {
    const a = new FakeSTT({ label: 'a' });
    const b = new FakeSTT({ label: 'b' });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });
    expect(adapter.sttInstances).toHaveLength(2);
    expect(adapter.sttInstances[0]).toBe(a);
    expect(adapter.sttInstances[1]).toBe(b);
    expect(adapter.maxRetryPerSTT).toBe(1);
    expect(adapter.attemptTimeoutMs).toBe(10_000);
    expect(adapter.retryIntervalMs).toBe(5_000);
    expect(adapter.status.every((s) => s.available)).toBe(true);
  });

  it('reports streaming=true even when capabilities are mixed (via StreamAdapter wrap)', () => {
    const a = new FakeSTT({ label: 'a' });
    const adapter = new FallbackAdapter({ sttInstances: [a] });
    expect(adapter.capabilities.streaming).toBe(true);
  });

  it('_recognize falls through to the next instance on error', async () => {
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIConnectionError({ message: 'primary down' }),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const result = await adapter.recognize(emptyAudioFrame());
    expect(result.alternatives?.[0]?.text).toBe('hello world');
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);

    // Observability: each STT saw exactly one recognize() attempt.
    expect((await primary.recognizeCh.next()).value).toBeInstanceOf(RecognizeSentinel);
    expect((await fallback.recognizeCh.next()).value).toBeInstanceOf(RecognizeSentinel);
  });

  it('_recognize throws APIConnectionError when every instance fails', async () => {
    const boom = new APIConnectionError({ message: 'down' });
    const a = new FakeSTT({ label: 'a', fakeException: boom });
    const b = new FakeSTT({ label: 'b', fakeException: boom });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });

    await expect(adapter.recognize(emptyAudioFrame())).rejects.toThrow(/all STTs failed/);
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(false);
  });

  it('_recognize treats non-APIError failures as fallback-worthy too', async () => {
    const a = new FakeSTT({ label: 'a', fakeException: new Error('anything') });
    const b = new FakeSTT({ label: 'b', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });

    const result = await adapter.recognize(emptyAudioFrame());
    expect(result.alternatives?.[0]?.text).toBe('hello world');
    expect(adapter.status[0]?.available).toBe(false);
  });

  it("emits 'stt_availability_changed' with { stt, available } when marking unavailable", async () => {
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIError('primary down'),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const handler = vi.fn();
    (adapter as unknown as EventEmitter).on('stt_availability_changed', handler);

    await adapter.recognize(emptyAudioFrame());

    expect(handler).toHaveBeenCalledWith({ stt: primary, available: false });
  });

  it('recognize recovery probe flips an instance back to available once it succeeds', async () => {
    // Port of Python's `test_stt_recover`. Primary starts broken, fallback
    // works. After the first recognize() marks primary unavailable, flipping
    // primary to success via updateOptions should let the background
    // recovery task mark it available again on the next recognize() call
    // (recovery is scheduled inside _recognize for every unavailable STT).
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIConnectionError({ message: 'primary down' }),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const availabilityEvents: Array<{ stt: STT; available: boolean }> = [];
    (adapter as unknown as EventEmitter).on(
      'stt_availability_changed',
      (ev: { stt: STT; available: boolean }) => {
        availabilityEvents.push(ev);
      },
    );

    await adapter.recognize(emptyAudioFrame());
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);

    // Flip primary to success and trigger another recognize — that kicks
    // off a fresh recovery task for primary.
    primary.updateOptions({ fakeException: null, fakeTranscript: 'recovered' });
    await adapter.recognize(emptyAudioFrame());

    // Recovery runs asynchronously; poll briefly for the flip.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !adapter.status[0]?.available) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(adapter.status[0]?.available).toBe(true);
    expect(availabilityEvents.map((e) => ({ stt: e.stt.label, available: e.available }))).toEqual([
      { stt: 'primary', available: false },
      { stt: 'primary', available: true },
    ]);
  });

  it('recognize emits exactly one metrics_collected event (no double-count)', async () => {
    // Regression: base STT.recognize() emits its own metrics after _recognize()
    // returns. _recognize() delegates to a child's public recognize(), which
    // also emits metrics — and those child metrics are forwarded onto the
    // adapter. Without a recognize() override, consumers see two stt_metrics
    // events per call and RECOGNITION_USAGE is double-counted.
    const primary = new FakeSTT({ label: 'primary', fakeTranscript: 'hello' });
    const adapter = new FallbackAdapter({ sttInstances: [primary] });

    const received: unknown[] = [];
    adapter.on('metrics_collected', (m) => received.push(m));

    await adapter.recognize(emptyAudioFrame());

    expect(received).toHaveLength(1);
  });

  it('forwards metrics_collected events from every child instance', () => {
    const a = new FakeSTT({ label: 'a' });
    const b = new FakeSTT({ label: 'b' });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });

    const received: unknown[] = [];
    adapter.on('metrics_collected', (m) => received.push(m));

    const metric = {
      type: 'stt_metrics',
      timestamp: Date.now(),
      requestId: 'r',
      durationMs: 10,
      label: a.label,
      audioDurationMs: 500,
      streamed: false,
    };
    a.emit('metrics_collected', metric as never);
    b.emit('metrics_collected', metric as never);

    expect(received).toHaveLength(2);
  });

  it('close detaches the forwarders so orphan events stop flowing through', async () => {
    const a = new FakeSTT({ label: 'a' });
    const adapter = new FallbackAdapter({ sttInstances: [a] });

    const received: unknown[] = [];
    adapter.on('metrics_collected', (m) => received.push(m));

    await adapter.close();

    a.emit('metrics_collected', {
      type: 'stt_metrics',
      timestamp: Date.now(),
      requestId: 'r',
      durationMs: 10,
      label: a.label,
      audioDurationMs: 500,
      streamed: false,
    } as never);

    expect(received).toHaveLength(0);
  });
});

describe('FallbackSpeechStream (streaming path)', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    process.on('unhandledRejection', () => {});
  });

  it('forwards events from the primary without triggering fallback when it succeeds', async () => {
    const primary = new FakeSTT({ label: 'primary', fakeTranscript: 'hello world' });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const availabilityChanges: Array<{ stt: STT; available: boolean }> = [];
    (adapter as unknown as EventEmitter).on(
      'stt_availability_changed',
      (ev: { stt: STT; available: boolean }) => {
        availabilityChanges.push(ev);
      },
    );

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.map((e) => e.alternatives?.[0]?.text)).toEqual(['hello world']);
    expect(availabilityChanges).toEqual([]);
    expect(adapter.status[0]?.available).toBe(true);
    expect(adapter.status[1]?.available).toBe(true);
  });

  it('stream switches to the secondary provider when the primary errors', async () => {
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIError('primary down'),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({
      sttInstances: [primary, fallback],
      maxRetryPerSTT: 0, // no retries — primary fails once, move on
    });

    const availabilityChanges: Array<{ stt: STT; available: boolean }> = [];
    (adapter as unknown as EventEmitter).on(
      'stt_availability_changed',
      (ev: { stt: STT; available: boolean }) => {
        availabilityChanges.push(ev);
      },
    );

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.map((e) => e.alternatives?.[0]?.text)).toEqual(['hello world']);
    expect(availabilityChanges).toContainEqual({ stt: primary, available: false });
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);

    // Both providers saw a stream attempt via the observability channel.
    expect((await primary.streamCh.next()).done).toBe(false);
    expect((await fallback.streamCh.next()).done).toBe(false);
  });

  it('stream marks every instance unavailable when all children fail', async () => {
    const err = new APIError('down');
    const a = new FakeSTT({ label: 'a', fakeException: err });
    const b = new FakeSTT({ label: 'b', fakeException: err });
    const adapter = new FallbackAdapter({ sttInstances: [a, b], maxRetryPerSTT: 0 });

    // Adapter's base SpeechStream.mainTask re-throws after emitting 'error';
    // swallow to keep the test harness quiet.
    adapter.on('error', () => {});

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events).toEqual([]);
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(false);
  });

  it('does not engage fallback when close() races with child events', async () => {
    // Regression: SpeechStream.close() synchronously closes this.queue and
    // aborts. If a child event arrives while run() is still iterating, the
    // next `this.queue.put(ev)` throws "Queue is closed", lands in the catch
    // block, and gets logged as "unexpected error, switching to next STT" —
    // flipping the primary to unavailable and then doing the same to the
    // fallback. Guard: shutdown detection short-circuits the loop silently.
    const primary = new FakeSTT({ label: 'primary', fakeTranscript: 'first' });
    const fallback = new FakeSTT({ label: 'fallback' });
    const adapter = new FallbackAdapter({
      sttInstances: [primary, fallback],
      maxRetryPerSTT: 0,
    });

    const availabilityChanges: Array<{ stt: STT; available: boolean }> = [];
    (adapter as unknown as EventEmitter).on(
      'stt_availability_changed',
      (ev: { stt: STT; available: boolean }) => availabilityChanges.push(ev),
    );

    const stream = adapter.stream();

    // Consume the first transcript so we know the child is live.
    const first = await stream.next();
    expect(first.value?.alternatives?.[0]?.text).toBe('first');

    // Inject a follow-up event from the primary that will land after close().
    const [primaryStream] = await Promise.all([primary.streamCh.next()]);
    expect(primaryStream.done).toBe(false);

    // Close the parent while the primary is still alive. The primary may
    // still push events into its queue; the parent must absorb that quietly.
    stream.close();
    primaryStream.value!.sendFakeTranscript('post-close');

    // Drain to completion — the adapter must exit silently.
    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(availabilityChanges).toEqual([]);
    expect(adapter.status[0]?.available).toBe(true);
    expect(adapter.status[1]?.available).toBe(true);
  });

  it('settles recovery probes when the stream exits (success path)', async () => {
    // Regression: tryRecoverStream pushes a probe onto this.recoveringStreams
    // and stores its task on adapter.status[i].recoveringStreamTask. The probe
    // reads from the forwarder, but the forwarder dies when run() returns —
    // so without an explicit close, the probe's input never EOFs and the
    // recovery task hangs forever. The finally block in run() must close
    // probes on every exit path.
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIError('primary down'),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({
      sttInstances: [primary, fallback],
      maxRetryPerSTT: 0,
    });

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    // Primary errored → a recovery task was started for it.
    expect(adapter.status[0]?.recoveringStreamTask).not.toBeNull();

    // The finally block should have closed the probe and the task should
    // complete promptly (not hang).
    const task = adapter.status[0]!.recoveringStreamTask!;
    const settled = await Promise.race([
      task.result.then(() => 'done' as const).catch(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    expect(settled).toBe('done');
    expect(task.done).toBe(true);
  });

  it('settles recovery probes when the stream is closed (shutdown path)', async () => {
    // Mirror of the success-path test but exiting via stream.close() instead
    // of input EOF. Both paths must drain probes.
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIError('primary down'),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({
      sttInstances: [primary, fallback],
      maxRetryPerSTT: 0,
    });

    const stream = adapter.stream();
    stream.endInput();

    // Consume the fallback's first event so primary's recovery probe is up.
    const first = await stream.next();
    expect(first.value?.alternatives?.[0]?.text).toBe('hello world');
    expect(adapter.status[0]?.recoveringStreamTask).not.toBeNull();

    stream.close();

    // Drain to settle.
    for await (const _ of stream) {
      // discard
    }

    const task = adapter.status[0]!.recoveringStreamTask!;
    const settled = await Promise.race([
      task.result.then(() => 'done' as const).catch(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    expect(settled).toBe('done');
    expect(task.done).toBe(true);
  });

  it('ends the fallback child when input EOF arrives before failover', async () => {
    // Regression: if endInput() is called on the adapter (input EOF) before
    // the primary errors, the forwarder exits having only seen the primary.
    // The fallback child elected afterwards never receives endInput(), so
    // a provider whose run() drains input hangs forever. Guard: on election
    // after the forwarder has finished, immediately end the child's input.
    // FakeRecognizeStream drains input by default, matching a real provider.
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIError('primary down'),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({
      sttInstances: [primary, fallback],
      maxRetryPerSTT: 0,
    });

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    const collect = (async () => {
      for await (const ev of stream) events.push(ev);
    })();

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 1_000),
    );
    const outcome = await Promise.race([collect.then(() => 'ok' as const), timeout]);

    expect(outcome).toBe('ok');
    expect(events.map((e) => e.alternatives?.[0]?.text)).toEqual(['hello world']);
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);
  });
});
