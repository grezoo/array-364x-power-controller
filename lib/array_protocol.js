/**
 * lib/array_protocol.js
 *
 * Array 364X / 3600 Series Power Supply Binary Protocol Engine
 * Pure Node.js CommonJS module - Zero external dependencies.
 *
 * Compliant with manufacturer specification:
 * "Communication protocol for power supply.pdf" (Array Electronic Co., Ltd.)
 */

'use strict';

// ============================================================================
// Constants & Definitions
// ============================================================================

const FRAME_HEADER = 0xAA;
const FRAME_LENGTH = 26;
const PAYLOAD_LENGTH = 22;

const COMMANDS = {
  SET_PARAMS: 0x80,
  READ_TELEMETRY: 0x81,
  CONTROL: 0x82,
  CAL_PROTECT_SET: 0x83,
  CAL_PROTECT_READ: 0x84,
  CAL_VOLTAGE_POINT: 0x85,
  CAL_READ_VOLTAGE: 0x86,
  CAL_CURRENT_POINT: 0x87,
  CAL_READ_CURRENT: 0x88,
  CAL_INFO_SET: 0x89,
  CAL_INFO_READ: 0x8A,
  SET_SERIAL: 0x8B,
  READ_MODEL_INFO: 0x8C,
  RESPONSE_CHECK: 0x12
};

const RESPONSE_CODES = {
  OK: 0x80,
  ERROR: 0x90
};

const STATUS_BITS = {
  OUTPUT_ON: 0x01,   // b0: 0 = Output OFF, 1 = Output ON
  CC_MODE: 0x02,     // b1: 0 = CV Mode,     1 = CC Mode (current limit reached)
  OVER_POWER: 0x04,  // b2: 0 = Normal,      1 = Over Power Protection (OPP) active
  REMOTE_MODE: 0x08  // b3: 0 = Local mode,  1 = Remote mode (PC controlled)
};

const MODEL_LIMITS = {
  '3644A': { maxVoltage_mV: 18000, maxCurrent_mA: 5000, maxPower_10mW: 9000,  maxPower_W: 90.0 },
  '3645A': { maxVoltage_mV: 36000, maxCurrent_mA: 3000, maxPower_10mW: 10800, maxPower_W: 108.0 },
  '3646A': { maxVoltage_mV: 72000, maxCurrent_mA: 1500, maxPower_10mW: 10800, maxPower_W: 108.0 },
  '3647A': { maxVoltage_mV: 36000, maxCurrent_mA: 4000, maxPower_10mW: 14400, maxPower_W: 144.0 },
  '3648A': { maxVoltage_mV: 72000, maxCurrent_mA: 2000, maxPower_10mW: 14400, maxPower_W: 144.0 }
};

// ============================================================================
// Checksum & Framing Primitives
// ============================================================================

/**
 * Calculates modulo-256 arithmetic checksum across the first 25 bytes (bytes 0..24).
 * Formula: sum(bytes[0..24]) & 0xFF
 *
 * @param {Buffer} buffer - Buffer of at least 25 bytes.
 * @returns {number} 8-bit unsigned integer (0..255).
 */
function calculateChecksum(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('calculateChecksum requires a Buffer of at least 25 bytes');
  }
  if (buffer.length < 25) {
    throw new TypeError(`calculateChecksum requires a Buffer of at least 25 bytes, got length ${buffer.length}`);
  }

  let sum = 0;
  for (let i = 0; i < 25; i++) {
    sum = (sum + buffer[i]) & 0xFF;
  }
  return sum;
}

/**
 * Verifies if a buffer is a valid 26-byte frame with matching checksum.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function verifyChecksum(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== FRAME_LENGTH) {
    return false;
  }
  return buffer[25] === calculateChecksum(buffer);
}

/**
 * Builds a canonical 26-byte frame from address, command, and payload.
 *
 * @param {number} address - Target device address (0x00..0xFE).
 * @param {number} cmd - Command code (e.g. 0x80, 0x81, 0x82, 0x12).
 * @param {Buffer} [dataBuffer] - Optional payload buffer (up to 22 bytes).
 * @returns {Buffer} 26-byte buffer with calculated checksum at byte 25.
 */
function buildFrame(address, cmd, dataBuffer) {
  const frame = Buffer.alloc(FRAME_LENGTH, 0);
  frame[0] = FRAME_HEADER;
  frame[1] = (address || 0) & 0xFF;
  frame[2] = (cmd || 0) & 0xFF;

  if (dataBuffer) {
    if (!Buffer.isBuffer(dataBuffer)) {
      throw new TypeError('dataBuffer must be a Buffer');
    }
    if (dataBuffer.length > PAYLOAD_LENGTH) {
      throw new RangeError(`dataBuffer length (${dataBuffer.length}) exceeds maximum payload ${PAYLOAD_LENGTH}`);
    }
    dataBuffer.copy(frame, 3, 0, dataBuffer.length);
  }

  frame[25] = calculateChecksum(frame);
  return frame;
}

/**
 * Parses and validates an incoming 26-byte binary frame.
 * Does not throw on malformed input, returns structured inspection object.
 *
 * @param {Buffer} buffer
 * @returns {{ valid: boolean, address: number, cmd: number, payload: Buffer|null, checksum: number, expectedChecksum?: number, error?: string }}
 */
function parseFrame(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return {
      valid: false,
      address: 0,
      cmd: 0,
      payload: null,
      checksum: 0,
      error: 'Input must be a Buffer'
    };
  }

  if (buffer.length !== FRAME_LENGTH) {
    return {
      valid: false,
      address: buffer.length > 1 ? buffer[1] : 0,
      cmd: buffer.length > 2 ? buffer[2] : 0,
      payload: null,
      checksum: buffer.length > 25 ? buffer[25] : 0,
      error: `Invalid frame length: expected ${FRAME_LENGTH}, got ${buffer.length}`
    };
  }

  if (buffer[0] !== FRAME_HEADER) {
    return {
      valid: false,
      address: buffer[1],
      cmd: buffer[2],
      payload: null,
      checksum: buffer[25],
      error: `Invalid frame start byte: expected 0xAA, got 0x${buffer[0].toString(16).toUpperCase().padStart(2, '0')}`
    };
  }

  const expectedChecksum = calculateChecksum(buffer);
  if (buffer[25] !== expectedChecksum) {
    return {
      valid: false,
      address: buffer[1],
      cmd: buffer[2],
      payload: buffer.subarray(3, 25),
      checksum: buffer[25],
      expectedChecksum,
      error: `Checksum mismatch: expected 0x${expectedChecksum.toString(16).toUpperCase().padStart(2, '0')}, got 0x${buffer[25].toString(16).toUpperCase().padStart(2, '0')}`
    };
  }

  return {
    valid: true,
    address: buffer[1],
    cmd: buffer[2],
    payload: buffer.subarray(3, 25),
    checksum: buffer[25]
  };
}

// ============================================================================
// Core Command Encoders & Decoders
// ============================================================================

/**
 * Defensive integer normalization helper.
 * Clamps negative numbers to 0 and finite limits without throwing.
 */
function sanitizeUint(val, max) {
  if (val === undefined || val === null || isNaN(val)) {
    return 0;
  }
  const num = typeof val === 'number' ? val : parseFloat(val);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.min(max, Math.round(num)));
}

/**
 * Encodes Command 0x80 (Set limits and parameters).
 *
 * @param {number} address - Device address (0x00..0xFE).
 * @param {Object} params - Parameter values:
 *   - maxCurrent_mA (or maxCurrent_A)
 *   - maxVoltage_mV (or maxVoltage_V)
 *   - maxPower_10mW (or maxPower_W)
 *   - setVoltage_mV (or setVoltage_V)
 *   - newAddress
 * @returns {Buffer} 26-byte frame.
 */
function encodeSetParameters(address, params) {
  const p = params || {};
  const payload = Buffer.alloc(PAYLOAD_LENGTH, 0);

  // Current limit (uint16 LE, mA)
  const current_mA = p.maxCurrent_mA !== undefined
    ? sanitizeUint(p.maxCurrent_mA, 65535)
    : (p.maxCurrent_A !== undefined ? sanitizeUint(p.maxCurrent_A * 1000, 65535) : 0);
  payload.writeUInt16LE(current_mA, 0);

  // Voltage limit (uint32 LE, mV)
  const voltage_mV = p.maxVoltage_mV !== undefined
    ? sanitizeUint(p.maxVoltage_mV, 0xFFFFFFFF)
    : (p.maxVoltage_V !== undefined ? sanitizeUint(p.maxVoltage_V * 1000, 0xFFFFFFFF) : 0);
  payload.writeUInt32LE(voltage_mV, 2);

  // Power limit (uint16 LE, 10 mW units = 0.01 W)
  const power_10mW = p.maxPower_10mW !== undefined
    ? sanitizeUint(p.maxPower_10mW, 65535)
    : (p.maxPower_W !== undefined ? sanitizeUint(p.maxPower_W * 100, 65535) : 0);
  payload.writeUInt16LE(power_10mW, 6);

  // Voltage setpoint (uint32 LE, mV)
  const set_mV = p.setVoltage_mV !== undefined
    ? sanitizeUint(p.setVoltage_mV, 0xFFFFFFFF)
    : (p.setVoltage_V !== undefined ? sanitizeUint(p.setVoltage_V * 1000, 0xFFFFFFFF) : 0);
  payload.writeUInt32LE(set_mV, 8);

  // New address
  const newAddr = p.newAddress !== undefined ? (p.newAddress & 0xFF) : ((address || 0) & 0xFF);
  payload[12] = newAddr;

  return buildFrame(address, COMMANDS.SET_PARAMS, payload);
}

/**
 * Decodes a 26-byte frame or 22-byte payload of Command 0x80.
 *
 * @param {Buffer} buffer
 * @returns {Object} Unpacked parameters.
 */
function decodeSetParameters(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('decodeSetParameters requires a Buffer');
  }
  const offset = buffer.length === FRAME_LENGTH ? 3 : 0;
  const maxCurrent_mA = buffer.readUInt16LE(offset);
  const maxVoltage_mV = buffer.readUInt32LE(offset + 2);
  const maxPower_10mW = buffer.readUInt16LE(offset + 6);
  const setVoltage_mV = buffer.readUInt32LE(offset + 8);
  const newAddress = buffer[offset + 12];

  return {
    maxCurrent_mA,
    maxCurrent_A: Number((maxCurrent_mA / 1000.0).toFixed(3)),
    maxVoltage_mV,
    maxVoltage_V: Number((maxVoltage_mV / 1000.0).toFixed(3)),
    maxPower_10mW,
    maxPower_W: Number((maxPower_10mW / 100.0).toFixed(2)),
    setVoltage_mV,
    setVoltage_V: Number((setVoltage_mV / 1000.0).toFixed(3)),
    newAddress
  };
}

/**
 * Encodes Command 0x82 (Output ON/OFF and Remote/Local Mode control).
 *
 * @param {number} address - Target device address.
 * @param {Object|number} opts - Control options or raw state byte.
 *   - outputOn: boolean (bit 0)
 *   - remoteMode: boolean (bit 1, defaults to true)
 * @returns {Buffer} 26-byte frame.
 */
function encodeControl(address, opts) {
  const payload = Buffer.alloc(PAYLOAD_LENGTH, 0);
  let stateByte = 0;

  if (typeof opts === 'number') {
    stateByte = opts & 0xFF;
  } else {
    const o = opts || {};
    if (o.outputOn) {
      stateByte |= STATUS_BITS.OUTPUT_ON;
    }
    // Remote mode defaults to true if not explicitly set to false
    const isRemote = (o.remoteMode !== undefined)
      ? !!o.remoteMode
      : (o.remote !== undefined ? !!o.remote : true);

    if (isRemote) {
      stateByte |= STATUS_BITS.CC_MODE; // bit 1: 1 = PC control (Remote)
    }
  }

  payload[0] = stateByte;
  return buildFrame(address, COMMANDS.CONTROL, payload);
}

/**
 * Decodes Command 0x82 control state from a frame or payload.
 *
 * @param {Buffer} buffer
 * @returns {{ outputOn: boolean, remoteMode: boolean, rawState: number }}
 */
function decodeControl(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('decodeControl requires a Buffer');
  }
  const offset = buffer.length === FRAME_LENGTH ? 3 : 0;
  const stateByte = buffer[offset];

  return {
    outputOn: (stateByte & STATUS_BITS.OUTPUT_ON) !== 0,
    remoteMode: (stateByte & STATUS_BITS.CC_MODE) !== 0,
    rawState: stateByte
  };
}

/**
 * Encodes Command 0x81 (Telemetry Query).
 *
 * @param {number} address - Target device address.
 * @returns {Buffer} 26-byte frame.
 */
function encodeTelemetryQuery(address) {
  return buildFrame(address, COMMANDS.READ_TELEMETRY);
}

/**
 * Decodes Command 0x81 (Telemetry Response) into engineering values and status bitfields.
 *
 * @param {Buffer} buffer - 26-byte frame or 22-byte payload.
 * @returns {Object} Structured telemetry object.
 */
function decodeTelemetry(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('decodeTelemetry requires a Buffer');
  }
  const offset = buffer.length === FRAME_LENGTH ? 3 : 0;

  const current_mA = buffer.readUInt16LE(offset);
  const voltage_mV = buffer.readUInt32LE(offset + 2);
  const power_raw = buffer.readUInt16LE(offset + 6);
  const maxCurrent_mA = buffer.readUInt16LE(offset + 8);
  const maxVoltage_mV = buffer.readUInt32LE(offset + 10);
  const maxPower_raw = buffer.readUInt16LE(offset + 14);
  const setVoltage_mV = buffer.readUInt32LE(offset + 16);
  const statusByte = buffer[offset + 20];

  const outputOn = (statusByte & STATUS_BITS.OUTPUT_ON) !== 0;
  const isCC = (statusByte & STATUS_BITS.CC_MODE) !== 0;
  const overPower = (statusByte & STATUS_BITS.OVER_POWER) !== 0;
  const remote = (statusByte & STATUS_BITS.REMOTE_MODE) !== 0;

  return {
    current_mA,
    voltage_mV,
    power_W: Number((power_raw / 100.0).toFixed(2)),
    current_A: Number((current_mA / 1000.0).toFixed(3)),
    voltage_V: Number((voltage_mV / 1000.0).toFixed(3)),
    maxCurrent_mA,
    maxCurrent_A: Number((maxCurrent_mA / 1000.0).toFixed(3)),
    maxVoltage_mV,
    maxVoltage_V: Number((maxVoltage_mV / 1000.0).toFixed(3)),
    maxPower_W: Number((maxPower_raw / 100.0).toFixed(2)),
    setVoltage_mV,
    setVoltage_V: Number((setVoltage_mV / 1000.0).toFixed(3)),
    state: {
      outputOn,
      mode: isCC ? 'CC' : 'CV',
      overPower,
      remote,
      rawStatus: statusByte
    }
  };
}

/**
 * Encodes Command 0x81 (Telemetry Response) for the mock simulator.
 *
 * @param {number} address - Device address.
 * @param {Object} data - Simulated telemetry values.
 * @returns {Buffer} 26-byte frame.
 */
function encodeTelemetry(address, data) {
  const d = data || {};
  const payload = Buffer.alloc(PAYLOAD_LENGTH, 0);

  payload.writeUInt16LE(sanitizeUint(d.current_mA, 65535), 0);
  payload.writeUInt32LE(sanitizeUint(d.voltage_mV, 0xFFFFFFFF), 2);

  const power_10mW = d.power_10mW !== undefined
    ? sanitizeUint(d.power_10mW, 65535)
    : (d.power_W !== undefined ? sanitizeUint(d.power_W * 100, 65535) : 0);
  payload.writeUInt16LE(power_10mW, 6);

  payload.writeUInt16LE(sanitizeUint(d.maxCurrent_mA !== undefined ? d.maxCurrent_mA : 3000, 65535), 8);
  payload.writeUInt32LE(sanitizeUint(d.maxVoltage_mV !== undefined ? d.maxVoltage_mV : 36000, 0xFFFFFFFF), 10);

  const maxPower_10mW = d.maxPower_10mW !== undefined
    ? sanitizeUint(d.maxPower_10mW, 65535)
    : (d.maxPower_W !== undefined ? sanitizeUint(d.maxPower_W * 100, 65535) : 10800);
  payload.writeUInt16LE(maxPower_10mW, 14);

  payload.writeUInt32LE(sanitizeUint(d.setVoltage_mV, 0xFFFFFFFF), 16);

  let statusByte = 0;
  if (d.outputOn) statusByte |= STATUS_BITS.OUTPUT_ON;
  if (d.mode === 'CC' || d.isCC) statusByte |= STATUS_BITS.CC_MODE;
  if (d.overPower) statusByte |= STATUS_BITS.OVER_POWER;
  if (d.remote !== false) statusByte |= STATUS_BITS.REMOTE_MODE;
  if (d.rawStatus !== undefined) statusByte = d.rawStatus & 0xFF;

  payload[20] = statusByte;
  return buildFrame(address, COMMANDS.READ_TELEMETRY, payload);
}

/**
 * Decodes Command 0x12 (ACK / NAK Check Response).
 *
 * @param {Buffer} buffer - 26-byte frame or 22-byte payload.
 * @returns {{ success: boolean, code: number, message: string }}
 */
function decodeResponse(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('decodeResponse requires a Buffer');
  }
  const offset = buffer.length === FRAME_LENGTH ? 3 : 0;
  const code = buffer[offset];

  if (code === RESPONSE_CODES.OK) {
    return { success: true, code: RESPONSE_CODES.OK, message: 'OK' };
  } else if (code === RESPONSE_CODES.ERROR) {
    return { success: false, code: RESPONSE_CODES.ERROR, message: 'Command error / Rejected (0x90)' };
  } else {
    return { success: false, code, message: `Unknown response code: 0x${code.toString(16).toUpperCase().padStart(2, '0')}` };
  }
}

/**
 * Encodes Command 0x12 (ACK / NAK Check Response) for the mock simulator.
 *
 * @param {number} address - Device address.
 * @param {boolean} success - Whether operation was accepted.
 * @param {number} [code] - Optional explicit code (0x80 or 0x90).
 * @returns {Buffer} 26-byte frame.
 */
function encodeResponse(address, success, code) {
  const payload = Buffer.alloc(PAYLOAD_LENGTH, 0);
  payload[0] = code !== undefined ? (code & 0xFF) : (success ? RESPONSE_CODES.OK : RESPONSE_CODES.ERROR);
  return buildFrame(address, COMMANDS.RESPONSE_CHECK, payload);
}

/**
 * Encodes Command 0x8C (Read Device ID & Version query).
 *
 * @param {number} address
 * @returns {Buffer} 26-byte frame.
 */
function encodeModelQuery(address) {
  return buildFrame(address, COMMANDS.READ_MODEL_INFO);
}

/**
 * Decodes Command 0x8C (Device ID & Version response).
 *
 * @param {Buffer} buffer
 * @returns {{ serialNumber: string, model: string, version: string, rawVersion: number }}
 */
function decodeModelResponse(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('decodeModelResponse requires a Buffer');
  }
  const offset = buffer.length === FRAME_LENGTH ? 3 : 0;
  const serial = buffer.subarray(offset, offset + 6).toString('ascii').replace(/\0/g, '').trim();
  const model = buffer.subarray(offset + 6, offset + 11).toString('ascii').replace(/\0/g, '').trim();
  const rawVer = buffer.readUInt16LE(offset + 11);
  const version = `V${(rawVer / 100.0).toFixed(2)}`;

  return { serialNumber: serial, model, version, rawVersion: rawVer };
}

/**
 * Encodes Command 0x8C (Device ID & Version response) for the mock simulator.
 *
 * @param {number} address
 * @param {Object} info
 * @returns {Buffer} 26-byte frame.
 */
function encodeModelResponse(address, info) {
  const inf = info || {};
  const payload = Buffer.alloc(PAYLOAD_LENGTH, 0);

  const serial = (inf.serialNumber || '000045').slice(0, 6);
  Buffer.from(serial, 'ascii').copy(payload, 0);

  const model = (inf.model || '3645A').slice(0, 5);
  Buffer.from(model, 'ascii').copy(payload, 6);

  const ver = inf.rawVersion !== undefined ? inf.rawVersion : 203;
  payload.writeUInt16LE(ver, 11);

  return buildFrame(address, COMMANDS.READ_MODEL_INFO, payload);
}

// ============================================================================
// Streaming & Serial Chunk Assembly Helpers
// ============================================================================

/**
 * Pure sliding-window frame extractor.
 * Scans an incoming accumulator buffer, discards noise preceding 0xAA,
 * verifies 26-byte candidate frames, and advances by 1 byte upon checksum mismatch
 * to guard against false 0xAA sync bytes embedded in payloads.
 *
 * @param {Buffer} accumulator
 * @returns {{ frames: Buffer[], remainder: Buffer }}
 */
function extractFrames(accumulator) {
  if (!Buffer.isBuffer(accumulator)) {
    return { frames: [], remainder: Buffer.alloc(0) };
  }

  const frames = [];
  let offset = 0;

  while (offset < accumulator.length) {
    const startIdx = accumulator.indexOf(FRAME_HEADER, offset);
    if (startIdx === -1) {
      // No 0xAA found in remaining buffer, discard everything
      offset = accumulator.length;
      break;
    }

    if (accumulator.length - startIdx < FRAME_LENGTH) {
      // Incomplete frame, preserve from 0xAA onward
      offset = startIdx;
      break;
    }

    const candidate = accumulator.subarray(startIdx, startIdx + FRAME_LENGTH);
    if (verifyChecksum(candidate)) {
      frames.push(Buffer.from(candidate));
      offset = startIdx + FRAME_LENGTH;
    } else {
      // Checksum failed: either corrupted or false 0xAA inside data payload.
      // Slide forward by 1 byte to find the next 0xAA candidate.
      offset = startIdx + 1;
    }
  }

  const remainder = offset < accumulator.length
    ? Buffer.from(accumulator.subarray(offset))
    : Buffer.alloc(0);

  return { frames, remainder };
}

/**
 * Stateful sliding-window frame chunk assembler for streaming serial ports.
 */
class FrameChunkAssembler {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxBufferSize=2048] Safety boundary to prevent memory leaks.
   */
  constructor(options = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxBufferSize = options.maxBufferSize || 2048;
  }

  /**
   * Pushes incoming chunk and returns all complete, verified frames.
   *
   * @param {Buffer} chunk
   * @returns {Buffer[]} Verified 26-byte frame buffers.
   */
  push(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      if (Array.isArray(chunk)) {
        chunk = Buffer.from(chunk);
      } else {
        throw new TypeError('FrameChunkAssembler.push requires a Buffer');
      }
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Safety bounding: prune oldest bytes if buffer overflows
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.maxBufferSize);
    }

    const { frames, remainder } = extractFrames(this.buffer);
    this.buffer = remainder;
    return frames;
  }

  /**
   * Resets internal buffer state.
   */
  reset() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Returns number of unparsed bytes currently in buffer.
   */
  get bufferedBytes() {
    return this.buffer.length;
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Constants
  FRAME_HEADER,
  FRAME_LENGTH,
  PAYLOAD_LENGTH,
  COMMANDS,
  RESPONSE_CODES,
  STATUS_BITS,
  MODEL_LIMITS,
  CONSTANTS: {
    FRAME_HEADER,
    FRAME_LENGTH,
    PAYLOAD_LENGTH,
    COMMANDS,
    RESPONSE_CODES,
    STATUS_BITS,
    MODEL_LIMITS
  },

  // Framing & Checksum
  calculateChecksum,
  verifyChecksum,
  buildFrame,
  parseFrame,

  // Streaming Helpers
  extractFrames,
  FrameChunkAssembler,

  // Client / Controller Encoders & Decoders
  encodeSetParameters,
  decodeSetParameters,
  encodeControl,
  decodeControl,
  encodeTelemetryQuery,
  decodeTelemetry,
  decodeResponse,

  // Server / Mock Symmetric Helpers
  encodeResponse,
  encodeTelemetry,
  encodeTelemetryResponse: encodeTelemetry, // Alias for ergonomic compatibility
  encodeModelQuery,
  decodeModelResponse,
  decodeModelInfo: decodeModelResponse,      // Alias for ergonomic compatibility
  encodeModelResponse
};
