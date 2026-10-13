/**
 * test/test_adversarial_stream.js
 *
 * Empirical Adversarial Serial Stream Simulator & Resynchronization Stress Harness
 * for Array 364X / 3600 Protocol Engine (lib/array_protocol.js).
 *
 * Zero external dependencies - uses Node.js native test runner (node:test, node:assert/strict).
 *
 * Execution:
 *   & "D:\programok_kiírni\IO-LINK\NODERED\node.exe" --test test/test_adversarial_stream.js
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../lib/array_protocol');

// ============================================================================
// Helper Utilities & Golden Frame Generators
// ============================================================================

/**
 * Deterministic pseudo-random number generator (LCG) for reproducible fuzzing.
 */
function createPRNG(seed = 123456789) {
  let s = seed >>> 0;
  return function next(min = 0, max = 1) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    const norm = s / 4294967296;
    return min + Math.floor(norm * (max - min + 1));
  };
}

/**
 * Builds a diverse catalog of 20 distinct valid 26-byte frames across all protocol commands,
 * explicitly including edge cases such as addresses equal to 0xAA, payloads with embedded 0xAA,
 * and checksums equal to 0xAA.
 */
function generateGoldenFrameCatalog() {
  const frames = [];

  // Frame 0: Official Example 1 (0x80 Set Operating Parameters)
  frames.push(protocol.encodeSetParameters(0x00, {
    maxCurrent_mA: 3000,
    maxVoltage_mV: 36000,
    maxPower_10mW: 10800,
    setVoltage_mV: 3000,
    newAddress: 0x00
  }));

  // Frame 1: Official Example 2 (0x81 Telemetry Query)
  frames.push(protocol.encodeTelemetryQuery(0x00));

  // Frame 2: Official Example 3A (0x82 Control: Output ON, Remote Mode)
  frames.push(protocol.encodeControl(0x00, { outputOn: true, remoteMode: true }));

  // Frame 3: Official Example 3B (0x82 Control: Output OFF, Remote Mode)
  frames.push(protocol.encodeControl(0x00, { outputOn: false, remoteMode: true }));

  // Frame 4: Official Example 4 (0x82 Control: Output OFF, Local Mode)
  frames.push(protocol.encodeControl(0x00, { outputOn: false, remoteMode: false }));

  // Frame 5: Official ACK (0x12)
  frames.push(protocol.encodeResponse(0x00, true));

  // Frame 6: Official NAK (0x12)
  frames.push(protocol.encodeResponse(0x00, false));

  // Frame 7: Model Query (0x8C)
  frames.push(protocol.encodeModelQuery(0x00));

  // Frame 8: Model Response (0x8C)
  frames.push(protocol.encodeModelResponse(0x00, {
    serialNumber: '000045',
    model: '3645A',
    rawVersion: 203
  }));

  // Frame 9: High Voltage 72V Model 3646A
  frames.push(protocol.encodeSetParameters(0x01, {
    maxCurrent_mA: 1500,
    maxVoltage_mV: 72000,
    maxPower_10mW: 10800,
    setVoltage_mV: 72000,
    newAddress: 0x01
  }));

  // Frame 10: Zero Setpoints at Address 0xFE
  frames.push(protocol.encodeSetParameters(0xFE, {
    maxCurrent_mA: 0,
    maxVoltage_mV: 0,
    maxPower_10mW: 0,
    setVoltage_mV: 0,
    newAddress: 0xFE
  }));

  // Frame 11: Telemetry Response - CV Mode
  frames.push(protocol.encodeTelemetry(0x00, {
    current_mA: 500,
    voltage_mV: 12000,
    power_W: 6.0,
    maxCurrent_mA: 3000,
    maxVoltage_mV: 36000,
    maxPower_W: 108.0,
    setVoltage_mV: 12000,
    outputOn: true,
    mode: 'CV',
    remote: true
  }));

  // Frame 12: Telemetry Response - CC Mode with OPP
  frames.push(protocol.encodeTelemetry(0x02, {
    current_mA: 3000,
    voltage_mV: 5000,
    power_W: 15.0,
    maxCurrent_mA: 3000,
    maxVoltage_mV: 36000,
    maxPower_W: 108.0,
    setVoltage_mV: 12000,
    outputOn: true,
    mode: 'CC',
    overPower: true,
    remote: true
  }));

  // Frame 13: EMBEDDED 0xAA in Setpoint (setVoltage = 43690 mV = 0xAAAA LE: AA AA 00 00)
  frames.push(protocol.encodeSetParameters(0x00, {
    maxCurrent_mA: 3000,
    maxVoltage_mV: 60000,
    maxPower_10mW: 10800,
    setVoltage_mV: 43690,
    newAddress: 0x00
  }));

  // Frame 14: EMBEDDED 0xAA in Current Limit (170 mA = 0x00AA LE: AA 00)
  frames.push(protocol.encodeSetParameters(0x00, {
    maxCurrent_mA: 170,
    maxVoltage_mV: 36000,
    maxPower_10mW: 10800,
    setVoltage_mV: 5000,
    newAddress: 0x00
  }));

  // Frame 15: Target Device Address IS 0xAA
  frames.push(protocol.encodeControl(0xAA, { outputOn: true, remoteMode: true }));

  // Frame 16: Telemetry Query to Address 0xAA
  frames.push(protocol.encodeTelemetryQuery(0xAA));

  // Frame 17: Parameter set with Address 0xAA and newAddress 0xAA
  frames.push(protocol.encodeSetParameters(0xAA, {
    maxCurrent_mA: 2500,
    maxVoltage_mV: 30000,
    maxPower_10mW: 7500,
    setVoltage_mV: 15000,
    newAddress: 0xAA
  }));

  // Frame 18: Synthetic Valid Frame with MULTIPLE embedded 0xAA bytes throughout payload
  const multiAAPayload = Buffer.alloc(22, 0xAA);
  frames.push(protocol.buildFrame(0xAA, 0x80, multiAAPayload));

  // Frame 19: Valid Frame engineered such that the Checksum byte equals exactly 0xAA
  // Checksum = (0xAA + 0x00 + 0x82 + p0 + p1... + p21) & 0xFF == 0xAA
  // 0xAA + 0x82 = 0x12C. 0x12C & 0xFF = 0x2C.
  // We need sum(payload) & 0xFF = 0xAA - 0x2C = 0x7E (126).
  const chkAAPayload = Buffer.alloc(22, 0);
  chkAAPayload[0] = 0x7E;
  const f19 = protocol.buildFrame(0x00, 0x82, chkAAPayload);
  assert.equal(f19[25], 0xAA, 'Sanity check: f19 checksum must be exactly 0xAA');
  frames.push(f19);

  return frames;
}

/**
 * Creates a stream of N frames by cycling through the golden frame catalog.
 */
function createGoldenStream(count = 100) {
  const catalog = generateGoldenFrameCatalog();
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push(catalog[i % catalog.length]);
  }
  return frames;
}

/**
 * Slices a continuous Buffer into chunks of fixed or variable sizes.
 *
 * @param {Buffer} buffer
 * @param {number|number[]} chunkSize - Fixed size, or array of cycling sizes.
 * @returns {Buffer[]}
 */
function sliceBuffer(buffer, chunkSize) {
  const chunks = [];
  let offset = 0;
  let patternIdx = 0;

  while (offset < buffer.length) {
    let size;
    if (Array.isArray(chunkSize)) {
      size = chunkSize[patternIdx % chunkSize.length];
      patternIdx++;
    } else {
      size = chunkSize;
    }
    const end = Math.min(offset + size, buffer.length);
    chunks.push(buffer.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

/**
 * Ingests an array of chunks into FrameChunkAssembler and returns all collected frames.
 */
function ingestChunks(assembler, chunks) {
  let collected = [];
  for (const chunk of chunks) {
    const extracted = assembler.push(chunk);
    if (extracted && extracted.length > 0) {
      collected = collected.concat(extracted);
    }
  }
  return collected;
}

/**
 * Asserts that collected frames match expected golden frames 100% in exact order.
 */
function assertFramesMatch(actualFrames, expectedFrames, contextDesc = '') {
  assert.equal(
    actualFrames.length,
    expectedFrames.length,
    `${contextDesc}: Frame count mismatch! Expected ${expectedFrames.length}, got ${actualFrames.length}`
  );

  for (let i = 0; i < expectedFrames.length; i++) {
    const actualHex = actualFrames[i].toString('hex').toUpperCase();
    const expectedHex = expectedFrames[i].toString('hex').toUpperCase();
    if (actualHex !== expectedHex) {
      assert.fail(
        `${contextDesc}: Frame #${i} mismatch!\nExpected: ${expectedHex}\nActual:   ${actualHex}`
      );
    }
  }
}

// ============================================================================
// SUITE 1: Arbitrary Slicing & Chunk Boundary Stress Tests (1B, 2B, 7B)
// ============================================================================

describe('Suite 1: Arbitrary Stream Slicing & Fragmentation Tests', () => {

  test('1.1: 1-Byte Chunking (Single-byte serial reception across 100 frames)', () => {
    const goldenFrames = createGoldenStream(100);
    const stream = Buffer.concat(goldenFrames);
    assert.equal(stream.length, 2600);

    const chunks = sliceBuffer(stream, 1);
    assert.equal(chunks.length, 2600);

    const assembler = new protocol.FrameChunkAssembler();
    const recovered = ingestChunks(assembler, chunks);

    assertFramesMatch(recovered, goldenFrames, '1-Byte Chunks');
    assert.equal(assembler.bufferedBytes, 0);
  });

  test('1.2: 2-Byte Chunking (Even chunking across 100 frames)', () => {
    const goldenFrames = createGoldenStream(100);
    const stream = Buffer.concat(goldenFrames);
    const chunks = sliceBuffer(stream, 2);
    assert.equal(chunks.length, 1300);

    const assembler = new protocol.FrameChunkAssembler();
    const recovered = ingestChunks(assembler, chunks);

    assertFramesMatch(recovered, goldenFrames, '2-Byte Chunks');
    assert.equal(assembler.bufferedBytes, 0);
  });

  test('1.3: 7-Byte Chunking (Odd prime-ish size misaligned across 26-byte boundaries)', () => {
    // 26 is not divisible by 7 (26 % 7 = 5).
    // Every frame boundary shifts across chunk indices.
    const goldenFrames = createGoldenStream(100);
    const stream = Buffer.concat(goldenFrames);
    const chunks = sliceBuffer(stream, 7);

    const assembler = new protocol.FrameChunkAssembler();
    const recovered = ingestChunks(assembler, chunks);

    assertFramesMatch(recovered, goldenFrames, '7-Byte Chunks');
    assert.equal(assembler.bufferedBytes, 0);
  });

  test('1.4: Cycling Irregular Chunk Sizes ([1, 2, 7, 3, 11, 5, 13, 1, 26, 4, 19, 2])', () => {
    const goldenFrames = createGoldenStream(100);
    const stream = Buffer.concat(goldenFrames);
    const pattern = [1, 2, 7, 3, 11, 5, 13, 1, 26, 4, 19, 2];
    const chunks = sliceBuffer(stream, pattern);

    const assembler = new protocol.FrameChunkAssembler();
    const recovered = ingestChunks(assembler, chunks);

    assertFramesMatch(recovered, goldenFrames, 'Cycling Irregular Chunks');
    assert.equal(assembler.bufferedBytes, 0);
  });

  test('1.5: Pseudorandom Chunk Sizes (1 to 31 bytes across 200 frames)', () => {
    const prng = createPRNG(42);
    const goldenFrames = createGoldenStream(200);
    const stream = Buffer.concat(goldenFrames);

    const chunks = [];
    let offset = 0;
    while (offset < stream.length) {
      const size = prng(1, 31);
      const end = Math.min(offset + size, stream.length);
      chunks.push(stream.subarray(offset, end));
      offset = end;
    }

    const assembler = new protocol.FrameChunkAssembler();
    const recovered = ingestChunks(assembler, chunks);

    assertFramesMatch(recovered, goldenFrames, 'Pseudorandom Chunks');
    assert.equal(assembler.bufferedBytes, 0);
  });
});

// ============================================================================
// SUITE 2: Garbage Prefixes & Noise Burst Resilience
// ============================================================================

describe('Suite 2: Garbage Prefixes, Noise Bursts & Resynchronization', () => {

  test('2.1: Leading ASCII Garbage Prefix without 0xAA (e.g. Modem / Bootloader Noise)', () => {
    const goldenFrames = createGoldenStream(50);
    const streamFrames = Buffer.concat(goldenFrames);

    // 120 bytes of ASCII noise with zero 0xAA bytes
    const noisePrefix = Buffer.from(
      'CONNECT 9600\r\nREADY\r\nARRAY ELECTRONIC 3645A INITIALIZING...\r\nERROR: UNKNOWN COMMAND\r\n\x00\x01\x02\x03\xFF\xFE\xFD',
      'ascii'
    );
    // Sanity check: Ensure prefix has no 0xAA
    assert.equal(noisePrefix.indexOf(0xAA), -1);

    const combinedStream = Buffer.concat([noisePrefix, streamFrames]);

    // Test with 7-byte chunks
    const chunks = sliceBuffer(combinedStream, 7);
    const assembler = new protocol.FrameChunkAssembler();
    const recovered = ingestChunks(assembler, chunks);

    assertFramesMatch(recovered, goldenFrames, 'ASCII Garbage Prefix');
    assert.equal(assembler.bufferedBytes, 0);
  });

  test('2.2: Leading Garbage Prefix Containing Multiple False 0xAA Bytes', () => {
    const goldenFrames = createGoldenStream(50);
    const streamFrames = Buffer.concat(goldenFrames);

    // Noise prefix containing several false 0xAA bytes that fail checksum
    const falseNoise = Buffer.from([
      0x55, 0x12, 0x34,
      0xAA, 0x01, 0x02, 0x03, // false candidate 1 (too short / corrupt)
      0x77, 0x88, 0x99,
      0xAA, 0xAA, 0xAA,       // false candidate 2
      0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xA0, 0xB0, 0xC0, 0xD0, 0xE0, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, // 26 bytes starting with 0xAA, bad checksum
      0xFF, 0xEE, 0xDD
    ]);

    // Verify candidate checksum fails
    const cand = falseNoise.subarray(10, 36);
    assert.equal(cand[0], 0xAA);
    assert.equal(cand.length, 26);
    assert.equal(protocol.verifyChecksum(cand), false, 'Candidate must fail checksum');

    const combinedStream = Buffer.concat([falseNoise, streamFrames]);

    // Test across 1-byte, 2-byte, and 7-byte chunking
    for (const chunkSize of [1, 2, 7]) {
      const chunks = sliceBuffer(combinedStream, chunkSize);
      const assembler = new protocol.FrameChunkAssembler();
      const recovered = ingestChunks(assembler, chunks);

      assertFramesMatch(recovered, goldenFrames, `False 0xAA Prefix (${chunkSize}-byte chunks)`);
      assert.equal(assembler.bufferedBytes, 0);
    }
  });

  test('2.3: Inter-Frame Noise Bursts with Arbitrary Byte Slicing', () => {
    const goldenFrames = createGoldenStream(40);
    const streamParts = [];

    // Between every golden frame, inject a noise segment with various byte values
    for (let i = 0; i < goldenFrames.length; i++) {
      streamParts.push(goldenFrames[i]);

      // Inject noise burst (1 to 20 bytes)
      const noiseLen = (i % 7) + 1;
      const noiseBuf = Buffer.alloc(noiseLen, (i * 17) & 0xFF);
      // Inject occasional false 0xAA in noise
      if (i % 3 === 0) {
        noiseBuf[0] = 0xAA;
      }
      streamParts.push(noiseBuf);
    }

    const combinedStream = Buffer.concat(streamParts);

    // Test feeding in 7-byte chunks
    const chunks = sliceBuffer(combinedStream, 7);
    const assembler = new protocol.FrameChunkAssembler();
    const recovered = ingestChunks(assembler, chunks);

    assertFramesMatch(recovered, goldenFrames, 'Inter-Frame Noise Bursts');
  });

  test('2.4: Severe Noise: False 0xAA Repeated Chains (0xAA 0xAA 0xAA ...)', () => {
    const goldenFrames = createGoldenStream(30);
    const streamParts = [];

    // Inject long sequence of repeating 0xAA bytes before and between frames
    const aaChain = Buffer.alloc(30, 0xAA); // 30 consecutive 0xAA bytes!

    streamParts.push(aaChain);
    for (let i = 0; i < goldenFrames.length; i++) {
      streamParts.push(goldenFrames[i]);
      if (i % 5 === 0) {
        streamParts.push(Buffer.alloc(15, 0xAA));
      }
    }

    const combinedStream = Buffer.concat(streamParts);

    // Test with 1-byte chunks (worst case single-byte advancement)
    const chunks1 = sliceBuffer(combinedStream, 1);
    const assembler1 = new protocol.FrameChunkAssembler();
    const recovered1 = ingestChunks(assembler1, chunks1);
    assertFramesMatch(recovered1, goldenFrames, 'Repeating 0xAA Chains (1B chunks)');

    // Test with 7-byte chunks
    const chunks7 = sliceBuffer(combinedStream, 7);
    const assembler7 = new protocol.FrameChunkAssembler();
    const recovered7 = ingestChunks(assembler7, chunks7);
    assertFramesMatch(recovered7, goldenFrames, 'Repeating 0xAA Chains (7B chunks)');
  });
});

// ============================================================================
// SUITE 3: Embedded 0xAA Payload Resistance & Corrupted Frame Recovery
// ============================================================================

describe('Suite 3: Embedded 0xAA Payload Resistance & Frame Resynchronization', () => {

  test('3.1: Heavy Embedded 0xAA Stream (All frames contain 0xAA data bytes)', () => {
    // Generate 50 frames specifically consisting of Frames 13..19 (heavy 0xAA content)
    const catalog = generateGoldenFrameCatalog().slice(13);
    const goldenFrames = [];
    for (let i = 0; i < 50; i++) {
      goldenFrames.push(catalog[i % catalog.length]);
    }

    const stream = Buffer.concat(goldenFrames);

    // Verify with 1B, 2B, 7B chunks
    for (const chunkSize of [1, 2, 7]) {
      const chunks = sliceBuffer(stream, chunkSize);
      const assembler = new protocol.FrameChunkAssembler();
      const recovered = ingestChunks(assembler, chunks);

      assertFramesMatch(recovered, goldenFrames, `Heavy Embedded 0xAA (${chunkSize}B chunks)`);
      assert.equal(assembler.bufferedBytes, 0);
    }
  });

  test('3.2: Corrupted Frame with Embedded 0xAA Payload Followed Immediately by Valid Frame', () => {
    // Frame A: Starts with 0xAA, contains 0xAA in payload, but checksum is intentionally corrupted.
    const corruptFrame = Buffer.alloc(26, 0);
    corruptFrame[0] = 0xAA;
    corruptFrame[1] = 0x00;
    corruptFrame[2] = 0x80;
    corruptFrame[7] = 0xAA;  // Embedded 0xAA in payload
    corruptFrame[12] = 0xAA; // Another 0xAA in payload
    corruptFrame[25] = 0x55; // Corrupt checksum (genuine would be 0xAA+0x80+0xAA+0xAA = 0x27E -> 0x7E)
    assert.equal(protocol.verifyChecksum(corruptFrame), false);

    // Frame B: A genuine valid frame
    const validFrame = protocol.encodeControl(0x00, { outputOn: true, remoteMode: true });

    // Stream: Corrupt Frame A immediately followed by Valid Frame B
    const stream = Buffer.concat([corruptFrame, validFrame]);

    // Feed in 1-byte chunks to test single-byte sliding window past embedded 0xAA
    const chunks1 = sliceBuffer(stream, 1);
    const assembler1 = new protocol.FrameChunkAssembler();
    const recovered1 = ingestChunks(assembler1, chunks1);

    assert.equal(recovered1.length, 1);
    assert.equal(recovered1[0].toString('hex'), validFrame.toString('hex'));
    assert.equal(assembler1.bufferedBytes, 0);

    // Feed in 7-byte chunks
    const chunks7 = sliceBuffer(stream, 7);
    const assembler7 = new protocol.FrameChunkAssembler();
    const recovered7 = ingestChunks(assembler7, chunks7);

    assert.equal(recovered7.length, 1);
    assert.equal(recovered7[0].toString('hex'), validFrame.toString('hex'));
    assert.equal(assembler7.bufferedBytes, 0);
  });

  test('3.3: Mid-Frame Transmission Loss (Dropped Bytes in Stream)', () => {
    const validF1 = protocol.encodeTelemetryQuery(0x00);
    const validF2 = protocol.encodeControl(0x00, { outputOn: true, remoteMode: true });
    const validF3 = protocol.encodeResponse(0x00, true);

    // Simulate transmission glitch: Frame 2 loses its first 8 bytes (bytes 0..7 dropped)
    // Stream: Valid F1 + F2[8..25] (18 bytes) + Valid F3
    const truncatedF2 = validF2.subarray(8);
    const stream = Buffer.concat([validF1, truncatedF2, validF3]);

    const chunks = sliceBuffer(stream, 7);
    const assembler = new protocol.FrameChunkAssembler();
    const recovered = ingestChunks(assembler, chunks);

    // F1 and F3 must be recovered intact
    assert.equal(recovered.length, 2);
    assert.equal(recovered[0].toString('hex'), validF1.toString('hex'));
    assert.equal(recovered[1].toString('hex'), validF3.toString('hex'));
    assert.equal(assembler.bufferedBytes, 0);
  });
});

// ============================================================================
// SUITE 4: High-Volume Adversarial Stress & Fuzz Harness
// ============================================================================

describe('Suite 4: High-Volume Adversarial Stress & Fuzz Simulation', () => {

  test('4.1: 500-Frame Stress Test with Randomized Noise Injections & Random Chunk Sizes', () => {
    const prng = createPRNG(987654321);
    const goldenFrames = createGoldenStream(500);

    const streamParts = [];
    for (let i = 0; i < goldenFrames.length; i++) {
      // 30% chance to inject noise before this frame
      if (prng(1, 10) <= 3) {
        const noiseType = prng(1, 3);
        const noiseLen = prng(1, 25);
        const noise = Buffer.alloc(noiseLen);

        if (noiseType === 1) {
          // Pure noise without 0xAA
          for (let b = 0; b < noiseLen; b++) noise[b] = (prng(0, 254) + (prng(0, 1) ? 1 : 0)) & 0xFF;
          // Ensure no accidental 0xAA
          for (let b = 0; b < noiseLen; b++) if (noise[b] === 0xAA) noise[b] = 0x55;
        } else if (noiseType === 2) {
          // Noise starting with false 0xAA and bad checksum
          noise[0] = 0xAA;
          for (let b = 1; b < noiseLen; b++) noise[b] = prng(0, 255);
        } else {
          // Multiple 0xAA bytes
          for (let b = 0; b < noiseLen; b++) noise[b] = (b % 2 === 0) ? 0xAA : prng(0, 255);
        }
        // Ensure noise starting with 0xAA does not accidentally form a valid 26-byte checksum candidate with following frame
        const probe = Buffer.concat([noise, goldenFrames[i]]);
        for (let offset = 0; offset < noiseLen; offset++) {
          if (probe[offset] === 0xAA && probe.length - offset >= 26) {
            const cand = probe.subarray(offset, offset + 26);
            if (protocol.verifyChecksum(cand)) {
              // Bit-flip inside noise to ensure this is truly corrupted noise
              noise[offset === 0 ? Math.min(1, noiseLen - 1) : offset] ^= 0x01;
            }
          }
        }
        streamParts.push(noise);
      }
      streamParts.push(goldenFrames[i]);
    }

    const fullStream = Buffer.concat(streamParts);

    // Slice full stream into randomized chunk sizes (1 to 17 bytes)
    const chunks = [];
    let offset = 0;
    while (offset < fullStream.length) {
      const chunkSize = prng(1, 17);
      const end = Math.min(offset + chunkSize, fullStream.length);
      chunks.push(fullStream.subarray(offset, end));
      offset = end;
    }

    const assembler = new protocol.FrameChunkAssembler();
    const startTime = process.hrtime.bigint();
    const recovered = ingestChunks(assembler, chunks);
    const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1e6;

    assertFramesMatch(recovered, goldenFrames, '500-Frame Fuzz Stress');
    assert(elapsedMs < 1000, `Execution took ${elapsedMs.toFixed(2)}ms, must be < 1000ms`);
  });

  test('4.2: Assembler State Management (reset, bufferedBytes, Array input)', () => {
    const assembler = new protocol.FrameChunkAssembler();
    const frame = protocol.encodeTelemetryQuery(0x00);

    // Feeding standard array instead of Buffer
    const arrChunk = Array.from(frame.subarray(0, 10));
    const res1 = assembler.push(arrChunk);
    assert.equal(res1.length, 0);
    assert.equal(assembler.bufferedBytes, 10);

    // Push remainder as Buffer
    const res2 = assembler.push(frame.subarray(10));
    assert.equal(res2.length, 1);
    assert.equal(res2[0].toString('hex'), frame.toString('hex'));
    assert.equal(assembler.bufferedBytes, 0);

    // Test invalid argument rejection
    assert.throws(() => assembler.push('not a buffer'), { name: 'TypeError' });
    assert.throws(() => assembler.push(null), { name: 'TypeError' });

    // Test empty buffer push
    const resEmpty = assembler.push(Buffer.alloc(0));
    assert.equal(resEmpty.length, 0);
    assert.equal(assembler.bufferedBytes, 0);

    // Test reset
    assembler.push(Buffer.from([0xAA, 0x01, 0x02]));
    assert.equal(assembler.bufferedBytes, 3);
    assembler.reset();
    assert.equal(assembler.bufferedBytes, 0);
  });

  test('4.3: Edge case: Alternating Valid and Corrupted Frames in Stream', () => {
    const valid1 = protocol.encodeControl(0x00, { outputOn: true, remoteMode: true });
    const corrupt = Buffer.alloc(26, 0xAA); // 26 bytes of 0xAA, bad checksum
    assert.equal(protocol.verifyChecksum(corrupt), false);
    const valid2 = protocol.encodeTelemetryQuery(0x00);

    const stream = Buffer.concat([valid1, corrupt, valid2]);

    // Slice in 7-byte chunks
    const chunks = sliceBuffer(stream, 7);
    const assembler = new protocol.FrameChunkAssembler();
    const recovered = ingestChunks(assembler, chunks);

    assert.equal(recovered.length, 2);
    assert.equal(recovered[0].toString('hex'), valid1.toString('hex'));
    assert.equal(recovered[1].toString('hex'), valid2.toString('hex'));
    assert.equal(assembler.bufferedBytes, 0);
  });
});
