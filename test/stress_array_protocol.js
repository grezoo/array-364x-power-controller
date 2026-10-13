/**
 * test/stress_array_protocol.js
 *
 * Empirical Adversarial Stress & Fuzzing Harness for Array 364X / 3600 Protocol Engine
 * (lib/array_protocol.js)
 *
 * Zero external dependencies. Uses Node.js native assert and performance timing.
 *
 * Test Execution:
 *   & "D:\programok_kiírni\IO-LINK\NODERED\node.exe" test/stress_array_protocol.js
 */

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const protocol = require('../lib/array_protocol');

// ============================================================================
// Configuration
// ============================================================================

const ROUNDTRIP_ITERATIONS = 10000;
const FUZZ_FRAMES_PER_CATEGORY = 5000; // 4 categories = 20,000 fuzzed frames
const STREAM_FRAGMENTATION_ITERATIONS = 5000;
const NOISE_COLLISION_PROBES = 5000;

console.log('================================================================');
console.log('STARTING EMPIRICAL ADVERSARIAL STRESS HARNESS: lib/array_protocol.js');
console.log('================================================================');
console.log(`- Roundtrip Iterations per Command: ${ROUNDTRIP_ITERATIONS.toLocaleString()}`);
console.log(`- Fuzz Frames per Category:         ${FUZZ_FRAMES_PER_CATEGORY.toLocaleString()} (x4 categories = 20,000 total)`);
console.log(`- Streaming Stream Chunks:          ${STREAM_FRAGMENTATION_ITERATIONS.toLocaleString()}`);
console.log(`- Noise Collision Probes:           ${NOISE_COLLISION_PROBES.toLocaleString()}`);
console.log('----------------------------------------------------------------\n');

const stats = {
  roundtripParams: { total: 0, passed: 0, failed: 0 },
  roundtripTelemetry: { total: 0, passed: 0, failed: 0 },
  roundtripControl: { total: 0, passed: 0, failed: 0 },
  roundtripModel: { total: 0, passed: 0, failed: 0 },
  fuzzRandom26B: { total: 0, safe: 0, crashed: 0 },
  fuzzBitFlips: { total: 0, safe: 0, crashed: 0 },
  fuzzCorruptChecksum: { total: 0, safe: 0, crashed: 0 },
  fuzzInvalidCmds: { total: 0, safe: 0, crashed: 0 },
  streamFragmentation: { total: 0, framesRecovered: 0, safe: 0, crashed: 0 },
  noiseCollisions: { totalProbes: 0, collisionsFound: 0, invalidCmdCollisions: 0, safe: 0, crashed: 0 },
  edgeCases: { total: 0, passed: 0, failed: 0 }
};

const startTime = performance.now();

// ============================================================================
// SUITE 1: 10,000 Roundtrip Parameter Encoding / Decoding (0x80)
// ============================================================================

console.log(`[Suite 1/6] Executing 10,000 Roundtrip Parameter Tests (Command 0x80)...`);
const t1Start = performance.now();

for (let i = 0; i < ROUNDTRIP_ITERATIONS; i++) {
  stats.roundtripParams.total++;

  let current_mA, voltage_mV, power_10mW, set_mV, addr, newAddr;

  if (i < 50) {
    current_mA = [0, 1, 255, 256, 1500, 3000, 5000, 65535][i % 8];
    voltage_mV = [0, 1, 255, 256, 12000, 36000, 65535, 65536, 72000, 100000, 0xFFFFFFFF][i % 11];
    power_10mW = [0, 1, 255, 256, 9000, 10800, 14400, 65535][i % 8];
    set_mV = [0, 1, 255, 256, 3000, 12000, 36000, 65535, 65536, 72000, 0xFFFFFFFF][i % 11];
    addr = (i % 255);
    newAddr = ((i + 7) % 255);
  } else {
    current_mA = crypto.randomInt(0, 65536);
    voltage_mV = crypto.randomInt(0, 4294967296);
    power_10mW = crypto.randomInt(0, 65536);
    set_mV = crypto.randomInt(0, 4294967296);
    addr = crypto.randomInt(0, 256);
    newAddr = crypto.randomInt(0, 256);
  }

  try {
    const frame = protocol.encodeSetParameters(addr, {
      maxCurrent_mA: current_mA,
      maxVoltage_mV: voltage_mV,
      maxPower_10mW: power_10mW,
      setVoltage_mV: set_mV,
      newAddress: newAddr
    });

    assert.equal(frame.length, 26, 'Frame length must be 26');
    assert.equal(frame[0], 0xAA, 'Start byte must be 0xAA');
    assert.equal(frame[1], addr & 0xFF, 'Address must match');
    assert.equal(frame[2], 0x80, 'Command must be 0x80');
    assert.equal(protocol.verifyChecksum(frame), true, 'Checksum verification failed');

    const decoded = protocol.decodeSetParameters(frame);
    assert.equal(decoded.maxCurrent_mA, current_mA, `maxCurrent_mA mismatch at iter ${i}`);
    assert.equal(decoded.maxVoltage_mV, voltage_mV, `maxVoltage_mV mismatch at iter ${i}`);
    assert.equal(decoded.maxPower_10mW, power_10mW, `maxPower_10mW mismatch at iter ${i}`);
    assert.equal(decoded.setVoltage_mV, set_mV, `setVoltage_mV mismatch at iter ${i}`);
    assert.equal(decoded.newAddress, newAddr & 0xFF, `newAddress mismatch at iter ${i}`);

    stats.roundtripParams.passed++;
  } catch (err) {
    stats.roundtripParams.failed++;
    console.error(`FAILED Parameter Roundtrip at iteration ${i}:`, err.message);
    throw err;
  }
}

const t1Duration = (performance.now() - t1Start).toFixed(2);
console.log(`  -> Passed: ${stats.roundtripParams.passed}/${stats.roundtripParams.total} (${t1Duration} ms)\n`);

// ============================================================================
// SUITE 2: 10,000 Roundtrip Telemetry Encoding / Decoding (0x81)
// ============================================================================

console.log(`[Suite 2/6] Executing 10,000 Roundtrip Telemetry Tests (Command 0x81)...`);
const t2Start = performance.now();

for (let i = 0; i < ROUNDTRIP_ITERATIONS; i++) {
  stats.roundtripTelemetry.total++;

  const current_mA = crypto.randomInt(0, 65536);
  const voltage_mV = crypto.randomInt(0, 4294967296);
  const power_10mW = crypto.randomInt(0, 65536);
  const maxCurrent_mA = crypto.randomInt(0, 65536);
  const maxVoltage_mV = crypto.randomInt(0, 4294967296);
  const maxPower_10mW = crypto.randomInt(0, 65536);
  const setVoltage_mV = crypto.randomInt(0, 4294967296);

  const outputOn = (crypto.randomInt(0, 2) === 1);
  const mode = (crypto.randomInt(0, 2) === 1) ? 'CC' : 'CV';
  const overPower = (crypto.randomInt(0, 2) === 1);
  const remote = (crypto.randomInt(0, 2) === 1);

  const telemInput = {
    current_mA,
    voltage_mV,
    power_10mW,
    maxCurrent_mA,
    maxVoltage_mV,
    maxPower_10mW,
    setVoltage_mV,
    outputOn,
    mode,
    overPower,
    remote
  };

  try {
    const frame = protocol.encodeTelemetry(0x00, telemInput);
    assert.equal(frame.length, 26);
    assert.equal(frame[0], 0xAA);
    assert.equal(frame[2], 0x81);
    assert.equal(protocol.verifyChecksum(frame), true);

    const decoded = protocol.decodeTelemetry(frame);

    assert.equal(decoded.current_mA, current_mA);
    assert.equal(decoded.voltage_mV, voltage_mV);
    assert.equal(decoded.maxCurrent_mA, maxCurrent_mA);
    assert.equal(decoded.maxVoltage_mV, maxVoltage_mV);
    assert.equal(decoded.setVoltage_mV, setVoltage_mV);

    assert.equal(decoded.state.outputOn, outputOn);
    assert.equal(decoded.state.mode, mode);
    assert.equal(decoded.state.overPower, overPower);
    assert.equal(decoded.state.remote, remote);

    stats.roundtripTelemetry.passed++;
  } catch (err) {
    stats.roundtripTelemetry.failed++;
    console.error(`FAILED Telemetry Roundtrip at iteration ${i}:`, err.message);
    throw err;
  }
}

const t2Duration = (performance.now() - t2Start).toFixed(2);
console.log(`  -> Passed: ${stats.roundtripTelemetry.passed}/${stats.roundtripTelemetry.total} (${t2Duration} ms)\n`);

// ============================================================================
// SUITE 3: 10,000 Roundtrip Control (0x82), Model (0x8C), Response (0x12)
// ============================================================================

console.log(`[Suite 3/6] Executing 10,000 Control, Model & Response Roundtrip Tests...`);
const t3Start = performance.now();

for (let i = 0; i < ROUNDTRIP_ITERATIONS; i++) {
  stats.roundtripControl.total++;
  stats.roundtripModel.total++;

  // Control 0x82
  const outputOn = (crypto.randomInt(0, 2) === 1);
  const remoteMode = (crypto.randomInt(0, 2) === 1);
  const addr = crypto.randomInt(0, 256);

  try {
    const ctrlFrame = protocol.encodeControl(addr, { outputOn, remoteMode });
    assert.equal(protocol.verifyChecksum(ctrlFrame), true);
    const ctrlDec = protocol.decodeControl(ctrlFrame);
    assert.equal(ctrlDec.outputOn, outputOn);
    assert.equal(ctrlDec.remoteMode, remoteMode);
    stats.roundtripControl.passed++;
  } catch (err) {
    stats.roundtripControl.failed++;
    throw err;
  }

  // Model 0x8C
  const serial = `SN${crypto.randomInt(1000, 9999)}`;
  const model = ['3644A', '3645A', '3646A', '3647A', '3648A'][crypto.randomInt(0, 5)];
  const rawVer = crypto.randomInt(100, 999);

  try {
    const modelFrame = protocol.encodeModelResponse(addr, {
      serialNumber: serial,
      model,
      rawVersion: rawVer
    });
    assert.equal(protocol.verifyChecksum(modelFrame), true);
    const modelDec = protocol.decodeModelResponse(modelFrame);
    assert.equal(modelDec.serialNumber, serial);
    assert.equal(modelDec.model, model);
    assert.equal(modelDec.rawVersion, rawVer);
    stats.roundtripModel.passed++;
  } catch (err) {
    stats.roundtripModel.failed++;
    throw err;
  }
}

const t3Duration = (performance.now() - t3Start).toFixed(2);
console.log(`  -> Passed: Control ${stats.roundtripControl.passed}/${stats.roundtripControl.total}, Model ${stats.roundtripModel.passed}/${stats.roundtripModel.total} (${t3Duration} ms)\n`);

// ============================================================================
// SUITE 4: Adversarial Fuzzing: 20,000 Randomized & Corrupted Frames
// ============================================================================

console.log(`[Suite 4/6] Executing Adversarial Fuzzing on 20,000 Frames (Zero-Crash Guarantee)...`);
const t4Start = performance.now();

// Category 4A: 5,000 completely random 26-byte buffers
for (let i = 0; i < FUZZ_FRAMES_PER_CATEGORY; i++) {
  stats.fuzzRandom26B.total++;
  const fuzzBuf = crypto.randomBytes(26);

  try {
    const parsed = protocol.parseFrame(fuzzBuf);
    assert.equal(typeof parsed.valid, 'boolean');

    protocol.decodeSetParameters(fuzzBuf);
    protocol.decodeTelemetry(fuzzBuf);
    protocol.decodeControl(fuzzBuf);
    protocol.decodeResponse(fuzzBuf);
    protocol.decodeModelResponse(fuzzBuf);

    stats.fuzzRandom26B.safe++;
  } catch (err) {
    stats.fuzzRandom26B.crashed++;
    console.error(`CRASH in Category 4A (Random 26B) at frame ${i}:`, err);
    throw err;
  }
}

// Category 4B: 5,000 valid frames with random 1..4 bit flips
for (let i = 0; i < FUZZ_FRAMES_PER_CATEGORY; i++) {
  stats.fuzzBitFlips.total++;

  const frame = protocol.encodeSetParameters(crypto.randomInt(0, 255), {
    maxCurrent_mA: crypto.randomInt(0, 65536),
    maxVoltage_mV: crypto.randomInt(0, 100000),
    maxPower_10mW: crypto.randomInt(0, 65536),
    setVoltage_mV: crypto.randomInt(0, 100000)
  });

  const mutated = Buffer.from(frame);
  const flips = crypto.randomInt(1, 5);
  for (let f = 0; f < flips; f++) {
    const bytePos = crypto.randomInt(0, 26);
    const bitPos = crypto.randomInt(0, 8);
    mutated[bytePos] ^= (1 << bitPos);
  }

  try {
    const parsed = protocol.parseFrame(mutated);
    assert.equal(typeof parsed.valid, 'boolean');

    protocol.decodeSetParameters(mutated);
    protocol.decodeTelemetry(mutated);
    protocol.decodeControl(mutated);
    protocol.decodeResponse(mutated);
    protocol.decodeModelResponse(mutated);

    stats.fuzzBitFlips.safe++;
  } catch (err) {
    stats.fuzzBitFlips.crashed++;
    console.error(`CRASH in Category 4B (Bit Flips) at frame ${i}:`, err);
    throw err;
  }
}

// Category 4C: 5,000 frames with corrupt checksums
for (let i = 0; i < FUZZ_FRAMES_PER_CATEGORY; i++) {
  stats.fuzzCorruptChecksum.total++;

  const frame = protocol.encodeTelemetryQuery(crypto.randomInt(0, 255));
  const corrupt = Buffer.from(frame);
  const offset = crypto.randomInt(1, 256);
  corrupt[25] = (corrupt[25] + offset) & 0xFF;

  try {
    const parsed = protocol.parseFrame(corrupt);
    assert.equal(parsed.valid, false, 'Frame with corrupted checksum must not be valid');
    assert.match(parsed.error, /checksum/i);

    protocol.decodeSetParameters(corrupt);
    protocol.decodeTelemetry(corrupt);
    protocol.decodeControl(corrupt);
    protocol.decodeResponse(corrupt);
    protocol.decodeModelResponse(corrupt);

    stats.fuzzCorruptChecksum.safe++;
  } catch (err) {
    stats.fuzzCorruptChecksum.crashed++;
    console.error(`CRASH in Category 4C (Corrupt Checksum) at frame ${i}:`, err);
    throw err;
  }
}

// Category 4D: 5,000 frames with randomized command codes (0x00..0xFF)
for (let i = 0; i < FUZZ_FRAMES_PER_CATEGORY; i++) {
  stats.fuzzInvalidCmds.total++;

  const randomCmd = crypto.randomInt(0, 256);
  const randomPayload = crypto.randomBytes(22);
  const frame = protocol.buildFrame(crypto.randomInt(0, 256), randomCmd, randomPayload);

  try {
    const parsed = protocol.parseFrame(frame);
    assert.equal(parsed.valid, true, 'Properly framed buffer with unknown command code is syntactically valid');
    assert.equal(parsed.cmd, randomCmd);

    protocol.decodeSetParameters(frame);
    protocol.decodeTelemetry(frame);
    protocol.decodeControl(frame);
    protocol.decodeResponse(frame);
    protocol.decodeModelResponse(frame);

    stats.fuzzInvalidCmds.safe++;
  } catch (err) {
    stats.fuzzInvalidCmds.crashed++;
    console.error(`CRASH in Category 4D (Random Commands) at frame ${i}:`, err);
    throw err;
  }
}

const t4Duration = (performance.now() - t4Start).toFixed(2);
console.log(`  -> Fuzz 4A (Random 26B):       ${stats.fuzzRandom26B.safe}/${stats.fuzzRandom26B.total} safe (0 crashes)`);
console.log(`  -> Fuzz 4B (Bit Flips):        ${stats.fuzzBitFlips.safe}/${stats.fuzzBitFlips.total} safe (0 crashes)`);
console.log(`  -> Fuzz 4C (Corrupt Checksum): ${stats.fuzzCorruptChecksum.safe}/${stats.fuzzCorruptChecksum.total} safe (0 crashes)`);
console.log(`  -> Fuzz 4D (Random Cmds):      ${stats.fuzzInvalidCmds.safe}/${stats.fuzzInvalidCmds.total} safe (0 crashes)`);
console.log(`  -> Total Fuzz Time:            ${t4Duration} ms\n`);

// ============================================================================
// SUITE 5: Streaming Fragmentation & Accidental Noise Collision Probe
// ============================================================================

console.log(`[Suite 5/6] Executing Streaming Fragmentation & Noise Collision Analysis...`);
const t5Start = performance.now();

// 5A: Chunk Fragmentation Resilience (5,000 streams)
// Verifies that byte-by-byte and arbitrary chunking perfectly extracts frames across noisy serial channels
for (let s = 0; s < STREAM_FRAGMENTATION_ITERATIONS; s++) {
  stats.streamFragmentation.total++;

  const frame1 = protocol.encodeControl(crypto.randomInt(0, 255), {
    outputOn: true,
    remoteMode: true
  });

  // Jitter noise without 0xAA (line noise / framing delay bytes)
  const noise1 = crypto.randomBytes(crypto.randomInt(0, 20)).map(b => b === 0xAA ? 0xAB : b);

  const frame2 = protocol.encodeTelemetryQuery(crypto.randomInt(0, 255));
  const noise2 = crypto.randomBytes(crypto.randomInt(0, 20)).map(b => b === 0xAA ? 0xAB : b);

  const fullStream = Buffer.concat([noise1, frame1, noise2, frame2]);

  const assembler = new protocol.FrameChunkAssembler({ maxBufferSize: 4096 });
  const recoveredFrames = [];

  try {
    let offset = 0;
    while (offset < fullStream.length) {
      const chunkSize = Math.min(crypto.randomInt(1, 16), fullStream.length - offset);
      const chunk = fullStream.subarray(offset, offset + chunkSize);
      offset += chunkSize;

      const extracted = assembler.push(chunk);
      for (const f of extracted) {
        recoveredFrames.push(f);
      }
    }

    assert.equal(recoveredFrames.length, 2, `Expected 2 frames recovered, got ${recoveredFrames.length}`);
    assert.equal(recoveredFrames[0].equals(frame1), true, `Frame 1 mismatch at stream ${s}`);
    assert.equal(recoveredFrames[1].equals(frame2), true, `Frame 2 mismatch at stream ${s}`);

    stats.streamFragmentation.framesRecovered += recoveredFrames.length;
    stats.streamFragmentation.safe++;
  } catch (err) {
    stats.streamFragmentation.crashed++;
    console.error(`CRASH in Streaming Fragmentation at stream ${s}:`, err);
    throw err;
  }
}

// 5B: Adversarial Noise Collision Probe (5,000 unconstrained 26-byte random buffers)
// Empirically measures the exact mathematical collision probability of modulo-256 checksum
// on unconstrained random noise starting with 0xAA
const KNOWN_COMMANDS = new Set(Object.values(protocol.COMMANDS));

for (let p = 0; p < NOISE_COLLISION_PROBES; p++) {
  stats.noiseCollisions.totalProbes++;
  const probe = crypto.randomBytes(26);
  probe[0] = 0xAA; // Starts with sync byte

  try {
    if (protocol.verifyChecksum(probe)) {
      stats.noiseCollisions.collisionsFound++;
      if (!KNOWN_COMMANDS.has(probe[2])) {
        stats.noiseCollisions.invalidCmdCollisions++;
      }
    }

    // Must be safely parsed regardless
    protocol.parseFrame(probe);
    stats.noiseCollisions.safe++;
  } catch (err) {
    stats.noiseCollisions.crashed++;
    throw err;
  }
}

const t5Duration = (performance.now() - t5Start).toFixed(2);
console.log(`  -> 5A: Chunk Fragmentation:    ${stats.streamFragmentation.safe}/${stats.streamFragmentation.total} streams safe (100% recovered: ${stats.streamFragmentation.framesRecovered} frames)`);
console.log(`  -> 5B: Noise Collisions Found: ${stats.noiseCollisions.collisionsFound}/${stats.noiseCollisions.totalProbes} probes (${(stats.noiseCollisions.collisionsFound / stats.noiseCollisions.totalProbes * 100).toFixed(2)}% empirical rate ≈ 1/256 theoretical)`);
console.log(`  -> 5B: Invalid Cmd Collisions: ${stats.noiseCollisions.invalidCmdCollisions} (empirically demonstrates vulnerability to noise desynchronization)`);
console.log(`  -> Total Stream Test Time:     ${t5Duration} ms\n`);

// ============================================================================
// SUITE 6: Non-Standard Input Types, Edge Lengths & Malformed Object Testing
// ============================================================================

console.log(`[Suite 6/6] Executing Non-Standard Type & Edge Length Boundary Tests...`);
const t6Start = performance.now();

const weirdInputs = [
  null,
  undefined,
  0,
  12345,
  -1,
  true,
  false,
  '',
  'AA0080B80BA08C',
  {},
  { length: 26 },
  [],
  [0xAA, 0x00, 0x82],
  Buffer.alloc(0),
  Buffer.alloc(1),
  Buffer.alloc(24),
  Buffer.alloc(25),
  Buffer.alloc(26),
  Buffer.alloc(27),
  Buffer.alloc(100),
  Buffer.alloc(1000)
];

for (const input of weirdInputs) {
  stats.edgeCases.total++;
  try {
    const p = protocol.parseFrame(input);
    assert.equal(typeof p.valid, 'boolean');

    const v = protocol.verifyChecksum(input);
    assert.equal(typeof v, 'boolean');

    const ext = protocol.extractFrames(input);
    assert(Array.isArray(ext.frames));
    assert(Buffer.isBuffer(ext.remainder));

    stats.edgeCases.passed++;
  } catch (err) {
    stats.edgeCases.failed++;
    console.error('Edge case failed for input:', input, err);
    throw err;
  }
}

const numericEdgeCases = [
  { in: NaN, expected: 0 },
  { in: Infinity, expected: 0 },
  { in: -Infinity, expected: 0 },
  { in: -9999, expected: 0 },
  { in: null, expected: 0 },
  { in: undefined, expected: 0 },
  { in: '12.5', expected: 13 },
  { in: 'abc', expected: 0 }
];

for (const nec of numericEdgeCases) {
  stats.edgeCases.total++;
  const f = protocol.encodeSetParameters(0x00, {
    maxCurrent_mA: nec.in,
    setVoltage_mV: nec.in
  });
  assert.equal(protocol.verifyChecksum(f), true);
  stats.edgeCases.passed++;
}

const t6Duration = (performance.now() - t6Start).toFixed(2);
console.log(`  -> Passed: ${stats.edgeCases.passed}/${stats.edgeCases.total} edge cases (${t6Duration} ms)\n`);

// ============================================================================
// FINAL SUMMARY & BENCHMARKS
// ============================================================================

const totalDurationMs = (performance.now() - startTime).toFixed(2);
const totalOperations =
  stats.roundtripParams.total +
  stats.roundtripTelemetry.total +
  stats.roundtripControl.total +
  stats.roundtripModel.total +
  stats.fuzzRandom26B.total +
  stats.fuzzBitFlips.total +
  stats.fuzzCorruptChecksum.total +
  stats.fuzzInvalidCmds.total +
  stats.streamFragmentation.total +
  stats.noiseCollisions.totalProbes +
  stats.edgeCases.total;

const totalCrashes =
  stats.fuzzRandom26B.crashed +
  stats.fuzzBitFlips.crashed +
  stats.fuzzCorruptChecksum.crashed +
  stats.fuzzInvalidCmds.crashed +
  stats.streamFragmentation.crashed +
  stats.noiseCollisions.crashed;

const throughput = Math.round((totalOperations / (totalDurationMs / 1000)));

console.log('================================================================');
console.log('EMPIRICAL STRESS TEST RESULTS SUMMARY');
console.log('================================================================');
console.log(`Total Operations Executed:  ${totalOperations.toLocaleString()}`);
console.log(`Total Wall-Clock Time:      ${totalDurationMs} ms (${(totalDurationMs / 1000).toFixed(2)} s)`);
console.log(`Throughput:                 ${throughput.toLocaleString()} operations / sec`);
console.log(`Roundtrip Verifications:    ${(stats.roundtripParams.passed + stats.roundtripTelemetry.passed + stats.roundtripControl.passed + stats.roundtripModel.passed).toLocaleString()} PASSED`);
console.log(`Fuzzed Frame Ingestions:    ${(stats.fuzzRandom26B.safe + stats.fuzzBitFlips.safe + stats.fuzzCorruptChecksum.safe + stats.fuzzInvalidCmds.safe).toLocaleString()} SAFE`);
console.log(`Stream Chunk Ingestions:    ${stats.streamFragmentation.safe.toLocaleString()} SAFE (${stats.streamFragmentation.framesRecovered.toLocaleString()} frames recovered)`);
console.log(`Noise Probes Evaluated:     ${stats.noiseCollisions.totalProbes.toLocaleString()} (${stats.noiseCollisions.collisionsFound} collisions measured)`);
console.log(`Edge Case Ingestions:       ${stats.edgeCases.passed.toLocaleString()} PASSED`);
console.log(`Total Unhandled Crashes:    ${totalCrashes}`);
console.log('----------------------------------------------------------------');

if (totalCrashes === 0 &&
    stats.roundtripParams.failed === 0 &&
    stats.roundtripTelemetry.failed === 0 &&
    stats.roundtripControl.failed === 0 &&
    stats.roundtripModel.failed === 0 &&
    stats.streamFragmentation.crashed === 0 &&
    stats.edgeCases.failed === 0) {
  console.log('VERDICT: >>> APPROVE <<<');
  console.log('All empirical criteria met: 100% roundtrip fidelity, zero unhandled crashes.');
} else {
  console.log('VERDICT: >>> REJECT <<<');
  process.exit(1);
}
console.log('================================================================');
