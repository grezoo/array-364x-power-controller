/**
 * test/test_protocol.js
 *
 * Comprehensive Unit Test Suite for Array 364X / 3600 Protocol Engine (lib/array_protocol.js)
 * Zero external dependencies - uses Node.js native test runner (node:test, node:assert/strict).
 *
 * Test Execution:
 *   & "D:\programok_kiírni\IO-LINK\NODERED\node.exe" --test test/test_protocol.js
 */

'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../lib/array_protocol');

// ============================================================================
// 1. Framing & Checksum Tests
// ============================================================================

describe('Suite 1: Framing & Modulo-256 Checksum Primitives', () => {

  test('1.1: calculateChecksum computes correct modulo 256 sum', () => {
    // 25 zero bytes -> sum = 0
    const zeroBuf = Buffer.alloc(25, 0);
    assert.equal(protocol.calculateChecksum(zeroBuf), 0);

    // Single byte 0xAA at index 0 -> sum = 0xAA (170)
    const aaBuf = Buffer.alloc(25, 0);
    aaBuf[0] = 0xAA;
    assert.equal(protocol.calculateChecksum(aaBuf), 0xAA);

    // Sum overflow: 250 + 10 = 260 -> 260 & 0xFF = 4
    const ovBuf = Buffer.alloc(25, 0);
    ovBuf[0] = 250;
    ovBuf[1] = 10;
    assert.equal(protocol.calculateChecksum(ovBuf), 4);

    // Exact rollover at 256 -> 0
    const r256 = Buffer.alloc(25, 0);
    r256[0] = 200;
    r256[1] = 56;
    assert.equal(protocol.calculateChecksum(r256), 0);

    // Rollover at 512 -> 0
    const r512 = Buffer.alloc(25, 0);
    r512[0] = 255;
    r512[1] = 255;
    r512[2] = 2;
    assert.equal(protocol.calculateChecksum(r512), 0);
  });

  test('1.2: calculateChecksum throws TypeError on non-buffer or truncated buffer (< 25 bytes)', () => {
    assert.throws(() => protocol.calculateChecksum(null), { name: 'TypeError' });
    assert.throws(() => protocol.calculateChecksum(undefined), { name: 'TypeError' });
    assert.throws(() => protocol.calculateChecksum([1, 2, 3]), { name: 'TypeError' });
    assert.throws(() => protocol.calculateChecksum('string'), { name: 'TypeError' });
    assert.throws(() => protocol.calculateChecksum(Buffer.alloc(24, 0)), { name: 'TypeError' });
    assert.throws(() => protocol.calculateChecksum(Buffer.alloc(0)), { name: 'TypeError' });
  });

  test('1.3: verifyChecksum correctly validates 26-byte frames', () => {
    const valid = Buffer.alloc(26, 0);
    valid[0] = 0xAA;
    valid[1] = 0x00;
    valid[2] = 0x81;
    valid[25] = protocol.calculateChecksum(valid);
    assert.equal(protocol.verifyChecksum(valid), true);

    // Corrupted checksum
    const corrupt = Buffer.from(valid);
    corrupt[25] ^= 0x01;
    assert.equal(protocol.verifyChecksum(corrupt), false);

    // Invalid length
    assert.equal(protocol.verifyChecksum(Buffer.alloc(25, 0)), false);
    assert.equal(protocol.verifyChecksum(Buffer.alloc(27, 0)), false);
    assert.equal(protocol.verifyChecksum(null), false);
    assert.equal(protocol.verifyChecksum(undefined), false);
  });

  test('1.4: buildFrame creates canonical 26-byte buffer with calculated checksum', () => {
    const payload = Buffer.from([0x03]);
    const frame = protocol.buildFrame(0x00, 0x82, payload);

    assert.equal(Buffer.isBuffer(frame), true);
    assert.equal(frame.length, 26);
    assert.equal(frame[0], 0xAA);
    assert.equal(frame[1], 0x00);
    assert.equal(frame[2], 0x82);
    assert.equal(frame[3], 0x03);
    for (let i = 4; i < 25; i++) {
      assert.equal(frame[i], 0x00);
    }
    assert.equal(frame[25], 0x2F); // 0xAA + 0x82 + 0x03 = 0x12F -> 0x2F
    assert.equal(protocol.verifyChecksum(frame), true);
  });

  test('1.5: buildFrame rejects invalid dataBuffer argument', () => {
    assert.throws(() => protocol.buildFrame(0, 0x80, 'invalid'), { name: 'TypeError' });
    assert.throws(() => protocol.buildFrame(0, 0x80, Buffer.alloc(23, 0)), { name: 'RangeError' });
  });

  test('1.6: parseFrame validates structure and extracts components defensively', () => {
    // Valid frame
    const frame = protocol.buildFrame(0x05, 0x81);
    const parsed = protocol.parseFrame(frame);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.address, 0x05);
    assert.equal(parsed.cmd, 0x81);
    assert.equal(parsed.payload.length, 22);
    assert.equal(parsed.checksum, frame[25]);

    // Non-buffer input
    assert.equal(protocol.parseFrame(null).valid, false);
    assert.equal(protocol.parseFrame('string').valid, false);
    assert.match(protocol.parseFrame(123).error, /Buffer/i);

    // Truncated buffer
    const short = protocol.parseFrame(Buffer.alloc(20, 0xAA));
    assert.equal(short.valid, false);
    assert.match(short.error, /length/i);

    // Oversized buffer
    const long = protocol.parseFrame(Buffer.alloc(30, 0xAA));
    assert.equal(long.valid, false);
    assert.match(long.error, /length/i);

    // Invalid start byte
    const badStart = Buffer.alloc(26, 0);
    badStart[0] = 0x55;
    badStart[25] = protocol.calculateChecksum(badStart);
    const parsedBadStart = protocol.parseFrame(badStart);
    assert.equal(parsedBadStart.valid, false);
    assert.match(parsedBadStart.error, /start byte/i);

    // Checksum mismatch
    const badChk = Buffer.from(frame);
    badChk[25] ^= 0x55;
    const parsedBadChk = protocol.parseFrame(badChk);
    assert.equal(parsedBadChk.valid, false);
    assert.match(parsedBadChk.error, /Checksum mismatch/i);
    assert.equal(parsedBadChk.expectedChecksum, frame[25]);
  });
});

// ============================================================================
// 2. Official Manufacturer PDF Page 8 Vectors
// ============================================================================

describe('Suite 2: Official Manufacturer PDF Page 8 Test Vectors', () => {

  test('2.1: Example 1 - Set Operating Parameters (0x80)', () => {
    // Expected: AA 00 80 B8 0B A0 8C 00 00 30 2A B8 0B 00 00 00 00 00 00 00 00 00 00 00 00 36
    const expectedHex = 'AA0080B80BA08C0000302AB80B00000000000000000000000036';
    const frame = protocol.encodeSetParameters(0x00, {
      maxCurrent_mA: 3000,
      maxVoltage_mV: 36000,
      maxPower_10mW: 10800,
      setVoltage_mV: 3000,
      newAddress: 0x00
    });

    assert.equal(frame.length, 26);
    assert.equal(frame.toString('hex').toUpperCase(), expectedHex);
    assert.equal(frame[25], 0x36);
    assert.equal(protocol.verifyChecksum(frame), true);

    // Also verify decodeSetParameters roundtrip
    const decoded = protocol.decodeSetParameters(frame);
    assert.equal(decoded.maxCurrent_mA, 3000);
    assert.equal(decoded.maxCurrent_A, 3.0);
    assert.equal(decoded.maxVoltage_mV, 36000);
    assert.equal(decoded.maxVoltage_V, 36.0);
    assert.equal(decoded.maxPower_10mW, 10800);
    assert.equal(decoded.maxPower_W, 108.0);
    assert.equal(decoded.setVoltage_mV, 3000);
    assert.equal(decoded.setVoltage_V, 3.0);
    assert.equal(decoded.newAddress, 0x00);
  });

  test('2.2: Example 2 - Read Parameters Query (0x81)', () => {
    // Expected: AA 00 81 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 2B
    const expectedHex = 'AA0081000000000000000000000000000000000000000000002B';
    const frame = protocol.encodeTelemetryQuery(0x00);

    assert.equal(frame.length, 26);
    assert.equal(frame.toString('hex').toUpperCase(), expectedHex);
    assert.equal(frame[25], 0x2B);
    assert.equal(protocol.verifyChecksum(frame), true);
  });

  test('2.3: Example 3A - Control: PC Control & Output ON (0x82, State 0x03)', () => {
    // Expected: AA 00 82 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 2F
    const expectedHex = 'AA0082030000000000000000000000000000000000000000002F';
    const frame = protocol.encodeControl(0x00, { outputOn: true, remoteMode: true });

    assert.equal(frame.length, 26);
    assert.equal(frame.toString('hex').toUpperCase(), expectedHex);
    assert.equal(frame[3], 0x03);
    assert.equal(frame[25], 0x2F);
    assert.equal(protocol.verifyChecksum(frame), true);

    const decoded = protocol.decodeControl(frame);
    assert.equal(decoded.outputOn, true);
    assert.equal(decoded.remoteMode, true);
    assert.equal(decoded.rawState, 0x03);
  });

  test('2.4: Example 3B - Control: PC Control & Output OFF (0x82, State 0x02)', () => {
    // Expected: AA 00 82 02 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 2E
    const expectedHex = 'AA0082020000000000000000000000000000000000000000002E';
    const frame = protocol.encodeControl(0x00, { outputOn: false, remoteMode: true });

    assert.equal(frame.length, 26);
    assert.equal(frame.toString('hex').toUpperCase(), expectedHex);
    assert.equal(frame[3], 0x02);
    assert.equal(frame[25], 0x2E);
    assert.equal(protocol.verifyChecksum(frame), true);

    const decoded = protocol.decodeControl(frame);
    assert.equal(decoded.outputOn, false);
    assert.equal(decoded.remoteMode, true);
    assert.equal(decoded.rawState, 0x02);
  });

  test('2.5: Example 4 - Control: Local Control & Output OFF (0x82, State 0x00)', () => {
    // Expected: AA 00 82 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 2C
    const expectedHex = 'AA0082000000000000000000000000000000000000000000002C';
    const frame = protocol.encodeControl(0x00, { outputOn: false, remoteMode: false });

    assert.equal(frame.length, 26);
    assert.equal(frame.toString('hex').toUpperCase(), expectedHex);
    assert.equal(frame[3], 0x00);
    assert.equal(frame[25], 0x2C);
    assert.equal(protocol.verifyChecksum(frame), true);

    const decoded = protocol.decodeControl(frame);
    assert.equal(decoded.outputOn, false);
    assert.equal(decoded.remoteMode, false);
    assert.equal(decoded.rawState, 0x00);
  });

  test('2.6: Example ACK & NAK - Check Response (0x12)', () => {
    // ACK (0x80): AA 00 12 80 00 ... 3C
    const ackExpectedHex = 'AA0012800000000000000000000000000000000000000000003C';
    const ackFrame = protocol.encodeResponse(0x00, true);
    assert.equal(ackFrame.toString('hex').toUpperCase(), ackExpectedHex);
    assert.equal(ackFrame[25], 0x3C);
    const ackDecoded = protocol.decodeResponse(ackFrame);
    assert.equal(ackDecoded.success, true);
    assert.equal(ackDecoded.code, 0x80);

    // NAK (0x90): AA 00 12 90 00 ... 4C
    const nakExpectedHex = 'AA0012900000000000000000000000000000000000000000004C';
    const nakFrame = protocol.encodeResponse(0x00, false);
    assert.equal(nakFrame.toString('hex').toUpperCase(), nakExpectedHex);
    assert.equal(nakFrame[25], 0x4C);
    const nakDecoded = protocol.decodeResponse(nakFrame);
    assert.equal(nakDecoded.success, false);
    assert.equal(nakDecoded.code, 0x90);
  });
});

// ============================================================================
// 3. Numerical Bounds, Endianness & Hardware Models
// ============================================================================

describe('Suite 3: Numerical Bounds, Endianness & Hardware Limits', () => {

  test('3.1: Zero Value Setpoints (0V, 0A, 0W, Address 0x00)', () => {
    const frame = protocol.encodeSetParameters(0x00, {
      maxCurrent_mA: 0,
      maxVoltage_mV: 0,
      maxPower_10mW: 0,
      setVoltage_mV: 0,
      newAddress: 0x00
    });
    assert.equal(frame.length, 26);
    assert.equal(frame[25], 0x2A); // 0xAA + 0x00 + 0x80 = 0x12A -> 0x2A
    assert.equal(protocol.verifyChecksum(frame), true);
  });

  test('3.2: 72V High Voltage Model (Array 3646A, 72.000V) 32-bit LE Encoding', () => {
    // 72000 mV = 0x00011940
    // Little-Endian bytes: 40 19 01 00
    const frame = protocol.encodeSetParameters(0x00, {
      maxCurrent_mA: 1500,
      maxVoltage_mV: 72000,
      maxPower_10mW: 10800,
      setVoltage_mV: 72000,
      newAddress: 0x00
    });

    assert.equal(frame.readUInt32LE(5), 72000, 'maxVoltage_mV must be 72000');
    assert.equal(frame[5], 0x40);
    assert.equal(frame[6], 0x19);
    assert.equal(frame[7], 0x01);
    assert.equal(frame[8], 0x00);

    assert.equal(frame.readUInt32LE(11), 72000, 'setVoltage_mV must be 72000');
    assert.equal(frame[11], 0x40);
    assert.equal(frame[12], 0x19);
    assert.equal(frame[13], 0x01);
    assert.equal(frame[14], 0x00);

    assert.equal(protocol.verifyChecksum(frame), true);
  });

  test('3.3: Boundary Byte Transitions (255 -> 256 and 65535 -> 65536)', () => {
    // Crossing 255 -> 256 for 32-bit voltage
    const f255 = protocol.encodeSetParameters(0x00, { setVoltage_mV: 255 });
    assert.equal(f255.readUInt32LE(11), 255);
    assert.equal(f255[11], 0xFF);
    assert.equal(f255[12], 0x00);

    const f256 = protocol.encodeSetParameters(0x00, { setVoltage_mV: 256 });
    assert.equal(f256.readUInt32LE(11), 256);
    assert.equal(f256[11], 0x00);
    assert.equal(f256[12], 0x01);

    // Crossing 65535 -> 65536 for 32-bit voltage
    const f65535 = protocol.encodeSetParameters(0x00, { setVoltage_mV: 65535 });
    assert.equal(f65535.readUInt32LE(11), 65535);
    assert.equal(f65535[11], 0xFF);
    assert.equal(f65535[12], 0xFF);
    assert.equal(f65535[13], 0x00);

    const f65536 = protocol.encodeSetParameters(0x00, { setVoltage_mV: 65536 });
    assert.equal(f65536.readUInt32LE(11), 65536);
    assert.equal(f65536[11], 0x00);
    assert.equal(f65536[12], 0x00);
    assert.equal(f65536[13], 0x01);
  });

  test('3.4: Engineering Units (V, A, W) Accepted and Scaled Accurately', () => {
    const frame = protocol.encodeSetParameters(0x00, {
      maxCurrent_A: 2.5,
      maxVoltage_V: 30.0,
      maxPower_W: 75.0,
      setVoltage_V: 12.345
    });

    assert.equal(frame.readUInt16LE(3), 2500);
    assert.equal(frame.readUInt32LE(5), 30000);
    assert.equal(frame.readUInt16LE(9), 7500);
    assert.equal(frame.readUInt32LE(11), 12345);
    assert.equal(protocol.verifyChecksum(frame), true);
  });

  test('3.5: Negative Value Clamping and NaN / Infinity Protection', () => {
    // Negative values clamped to 0
    const frameNeg = protocol.encodeSetParameters(0x00, {
      maxCurrent_mA: -100,
      maxVoltage_mV: -5000,
      maxPower_10mW: -50,
      setVoltage_mV: -12000
    });
    assert.equal(frameNeg.readUInt16LE(3), 0);
    assert.equal(frameNeg.readUInt32LE(5), 0);
    assert.equal(frameNeg.readUInt16LE(9), 0);
    assert.equal(frameNeg.readUInt32LE(11), 0);

    // Non-finite values safe default to 0
    const frameNaN = protocol.encodeSetParameters(0x00, {
      maxCurrent_mA: NaN,
      maxVoltage_mV: Infinity,
      setVoltage_mV: -Infinity
    });
    assert.equal(frameNaN.readUInt16LE(3), 0);
    assert.equal(frameNaN.readUInt32LE(11), 0);
  });

  test('3.6: Address Masking & Boundary (0xFE, 0x00)', () => {
    const frameFE = protocol.encodeSetParameters(0xFE, {
      maxCurrent_mA: 3000,
      maxVoltage_mV: 36000,
      maxPower_10mW: 10800,
      setVoltage_mV: 36000,
      newAddress: 0xFE
    });
    assert.equal(frameFE[1], 0xFE);
    assert.equal(frameFE[15], 0xFE);
    assert.equal(protocol.verifyChecksum(frameFE), true);
  });
});

// ============================================================================
// 4. Telemetry (0x81) & Status Byte Bitwise Decoding
// ============================================================================

describe('Suite 4: Telemetry Codec & Status Byte Bitwise Isolation', () => {

  test('4.1: Full Roundtrip Telemetry Encoding and Decoding', () => {
    const telemIn = {
      current_mA: 1250,
      voltage_mV: 15000,
      power_W: 18.75,
      maxCurrent_mA: 3000,
      maxVoltage_mV: 36000,
      maxPower_W: 108.0,
      setVoltage_mV: 15000,
      outputOn: true,
      mode: 'CC',
      overPower: false,
      remote: true
    };

    const frame = protocol.encodeTelemetry(0x00, telemIn);
    assert.equal(frame.length, 26);
    assert.equal(protocol.verifyChecksum(frame), true);
    assert.equal(frame[23], 0x0B); // 0x01 | 0x02 | 0x08 = 0x0B

    const decoded = protocol.decodeTelemetry(frame);
    assert.equal(decoded.current_mA, 1250);
    assert.equal(decoded.current_A, 1.25);
    assert.equal(decoded.voltage_mV, 15000);
    assert.equal(decoded.voltage_V, 15.0);
    assert.equal(decoded.power_W, 18.75);
    assert.equal(decoded.maxCurrent_mA, 3000);
    assert.equal(decoded.maxCurrent_A, 3.0);
    assert.equal(decoded.maxVoltage_mV, 36000);
    assert.equal(decoded.maxVoltage_V, 36.0);
    assert.equal(decoded.maxPower_W, 108.0);
    assert.equal(decoded.setVoltage_mV, 15000);
    assert.equal(decoded.setVoltage_V, 15.0);
    assert.equal(decoded.state.outputOn, true);
    assert.equal(decoded.state.mode, 'CC');
    assert.equal(decoded.state.overPower, false);
    assert.equal(decoded.state.remote, true);
  });

  test('4.2: Status Byte Combinations (Output, CC/CV, OPP, Remote)', () => {
    const matrix = [
      { byte: 0x00, out: false, mode: 'CV', opp: false, rem: false },
      { byte: 0x01, out: true,  mode: 'CV', opp: false, rem: false },
      { byte: 0x02, out: false, mode: 'CC', opp: false, rem: false },
      { byte: 0x03, out: true,  mode: 'CC', opp: false, rem: false },
      { byte: 0x04, out: false, mode: 'CV', opp: true,  rem: false },
      { byte: 0x07, out: true,  mode: 'CC', opp: true,  rem: false },
      { byte: 0x08, out: false, mode: 'CV', opp: false, rem: true  },
      { byte: 0x09, out: true,  mode: 'CV', opp: false, rem: true  },
      { byte: 0x0B, out: true,  mode: 'CC', opp: false, rem: true  },
      { byte: 0x0F, out: true,  mode: 'CC', opp: true,  rem: true  }
    ];

    for (const item of matrix) {
      const buf = Buffer.alloc(26, 0);
      buf[0] = 0xAA;
      buf[2] = 0x81;
      buf[23] = item.byte;
      buf[25] = protocol.calculateChecksum(buf);

      const d = protocol.decodeTelemetry(buf);
      assert.equal(d.state.outputOn, item.out, `Output for byte 0x${item.byte.toString(16)}`);
      assert.equal(d.state.mode, item.mode, `Mode for byte 0x${item.byte.toString(16)}`);
      assert.equal(d.state.overPower, item.opp, `OPP for byte 0x${item.byte.toString(16)}`);
      assert.equal(d.state.remote, item.rem, `Remote for byte 0x${item.byte.toString(16)}`);
    }
  });

  test('4.3: Status Byte Noise Immunity (Reserved Bits b4..b7)', () => {
    // 0xF9 has upper bits 1111 0000 set, plus 0000 1001 (Output ON, Remote, CV)
    const buf = Buffer.alloc(26, 0);
    buf[0] = 0xAA;
    buf[2] = 0x81;
    buf[23] = 0xF9;
    buf[25] = protocol.calculateChecksum(buf);

    const d = protocol.decodeTelemetry(buf);
    assert.equal(d.state.outputOn, true);
    assert.equal(d.state.mode, 'CV');
    assert.equal(d.state.overPower, false);
    assert.equal(d.state.remote, true);
  });
});

// ============================================================================
// 5. Device Identification (0x8C) Tests
// ============================================================================

describe('Suite 5: Command 0x8C Device Identification & Version', () => {

  test('5.1: encodeModelQuery produces valid 26-byte frame', () => {
    const q = protocol.encodeModelQuery(0x00);
    assert.equal(q.length, 26);
    assert.equal(q[0], 0xAA);
    assert.equal(q[1], 0x00);
    assert.equal(q[2], 0x8C);
    assert.equal(q[25], 0x36); // 0xAA + 0x00 + 0x8C = 0x136 -> 0x36
    assert.equal(protocol.verifyChecksum(q), true);
  });

  test('5.2: encodeModelResponse and decodeModelResponse roundtrip', () => {
    const resp = protocol.encodeModelResponse(0x00, {
      serialNumber: '000045',
      model: '3645A',
      rawVersion: 203
    });

    assert.equal(resp.length, 26);
    assert.equal(protocol.verifyChecksum(resp), true);

    const decoded = protocol.decodeModelResponse(resp);
    assert.equal(decoded.serialNumber, '000045');
    assert.equal(decoded.model, '3645A');
    assert.equal(decoded.rawVersion, 203);
    assert.equal(decoded.version, 'V2.03');
  });
});

// ============================================================================
// 6. Streaming, Chunk Assembly & Resynchronization Tests
// ============================================================================

describe('Suite 6: Streaming Assembly & False 0xAA Resynchronization', () => {

  test('6.1: extractFrames extracts complete single frame', () => {
    const frame = protocol.encodeControl(0x00, { outputOn: true, remoteMode: true });
    const { frames, remainder } = protocol.extractFrames(frame);

    assert.equal(frames.length, 1);
    assert.equal(frames[0].toString('hex'), frame.toString('hex'));
    assert.equal(remainder.length, 0);
  });

  test('6.2: extractFrames handles fragmented frame arrival (10B + 16B)', () => {
    const frame = protocol.encodeControl(0x00, { outputOn: true, remoteMode: true });
    const chunk1 = frame.subarray(0, 10);
    const chunk2 = frame.subarray(10);

    // First chunk incomplete
    const res1 = protocol.extractFrames(chunk1);
    assert.equal(res1.frames.length, 0);
    assert.equal(res1.remainder.length, 10);

    // Second chunk completes frame
    const combined = Buffer.concat([res1.remainder, chunk2]);
    const res2 = protocol.extractFrames(combined);
    assert.equal(res2.frames.length, 1);
    assert.equal(res2.frames[0].toString('hex'), frame.toString('hex'));
    assert.equal(res2.remainder.length, 0);
  });

  test('6.3: extractFrames extracts concatenated frames (52 bytes)', () => {
    const f1 = protocol.encodeControl(0x00, { outputOn: true, remoteMode: true });
    const f2 = protocol.encodeControl(0x00, { outputOn: false, remoteMode: true });
    const stream = Buffer.concat([f1, f2]);

    const { frames, remainder } = protocol.extractFrames(stream);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].toString('hex'), f1.toString('hex'));
    assert.equal(frames[1].toString('hex'), f2.toString('hex'));
    assert.equal(remainder.length, 0);
  });

  test('6.4: extractFrames discards leading noise before valid frame', () => {
    const noise = Buffer.from([0x00, 0x11, 0x22, 0x33, 0xFF]);
    const frame = protocol.encodeTelemetryQuery(0x00);
    const stream = Buffer.concat([noise, frame]);

    const { frames, remainder } = protocol.extractFrames(stream);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].toString('hex'), frame.toString('hex'));
    assert.equal(remainder.length, 0);
  });

  test('6.5: extractFrames preserves partial trailing fragment', () => {
    const frame = protocol.encodeTelemetryQuery(0x00);
    const partial = Buffer.from([0xAA, 0x00, 0x82]);
    const stream = Buffer.concat([frame, partial]);

    const { frames, remainder } = protocol.extractFrames(stream);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].toString('hex'), frame.toString('hex'));
    assert.equal(remainder.toString('hex'), partial.toString('hex'));
  });

  test('6.6: Adversarial resynchronization with false 0xAA embedded in payload', () => {
    // Construct a false frame candidate starting with 0xAA followed by junk with bad checksum,
    // then immediately followed by a genuine frame.
    const junkFalseAA = Buffer.alloc(15, 0x55);
    junkFalseAA[0] = 0xAA; // False sync byte

    const realFrame = protocol.encodeControl(0x00, { outputOn: true, remoteMode: true });
    const stream = Buffer.concat([junkFalseAA, realFrame]);

    // When sliding window encounters false 0xAA with bad checksum, it must slide forward
    // 1 byte at a time until it encounters realFrame's 0xAA.
    const { frames, remainder } = protocol.extractFrames(stream);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].toString('hex'), realFrame.toString('hex'));
    assert.equal(remainder.length, 0);
  });

  test('6.7: FrameChunkAssembler stateful chunk ingestion byte-by-byte', () => {
    const assembler = new protocol.FrameChunkAssembler();
    const frame = protocol.encodeSetParameters(0x00, {
      maxCurrent_mA: 3000,
      maxVoltage_mV: 36000,
      maxPower_10mW: 10800,
      setVoltage_mV: 3000,
      newAddress: 0x00
    });

    let extracted = [];
    // Feed one byte at a time
    for (let i = 0; i < frame.length; i++) {
      const chunk = Buffer.from([frame[i]]);
      const f = assembler.push(chunk);
      if (f.length > 0) {
        extracted = extracted.concat(f);
      }
    }

    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].toString('hex'), frame.toString('hex'));
    assert.equal(assembler.bufferedBytes, 0);

    // Test reset
    assembler.push(Buffer.from([0xAA, 0x01]));
    assert.equal(assembler.bufferedBytes, 2);
    assembler.reset();
    assert.equal(assembler.bufferedBytes, 0);
  });

  test('6.8: FrameChunkAssembler buffer overflow protection', () => {
    const assembler = new protocol.FrameChunkAssembler({ maxBufferSize: 100 });
    const garbage = Buffer.alloc(250, 0x11); // no 0xAA

    assembler.push(garbage);
    assert(assembler.bufferedBytes <= 100);
  });
});
