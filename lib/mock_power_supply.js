/**
 * lib/mock_power_supply.js
 *
 * Array 364X / 3600 Series Virtual Power Supply Simulator.
 * Pure Node.js CommonJS module - Zero external dependencies.
 *
 * Models circuit physics (Ohm's law, automatic CV/CC crossover, OPP trip,
 * Output ON/OFF collapse, Local vs Remote write protection),
 * and handles 26-byte binary protocol frames symmetrically.
 */

'use strict';

const EventEmitter = require('events');
const protocol = require('./array_protocol');

const {
  COMMANDS,
  RESPONSE_CODES,
  STATUS_BITS,
  MODEL_LIMITS,
  verifyChecksum,
  decodeControl,
  decodeSetParameters,
  encodeTelemetry,
  encodeResponse,
  encodeModelResponse,
  FrameChunkAssembler
} = protocol;

class MockPowerSupply extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.model='3645A']
   * @param {number} [options.address=0x00]
   * @param {number} [options.loadResistance=10.0]
   * @param {number} [options.initialVoltage_mV=0]
   * @param {number} [options.initialCurrent_mA]
   * @param {boolean} [options.outputOn=false]
   * @param {boolean} [options.remoteMode=false]
   * @param {string} [options.serialNumber='000045']
   * @param {number} [options.rawVersion=203]
   * @param {boolean} [options.enableSlewRate=false]
   * @param {number} [options.slewRate_V_per_s=100.0]
   */
  constructor(options = {}) {
    super();

    this.model = options.model || '3645A';
    const limits = MODEL_LIMITS[this.model] || MODEL_LIMITS['3645A'];

    this.hardwareMaxVoltage_mV = limits.maxVoltage_mV;
    this.hardwareMaxCurrent_mA = limits.maxCurrent_mA;
    this.hardwareMaxPower_10mW = limits.maxPower_10mW;

    this.address = options.address !== undefined ? (options.address & 0xFF) : 0x00;
    this.serialNumber = options.serialNumber || '000045';
    this.rawVersion = options.rawVersion !== undefined ? options.rawVersion : 203;

    // Virtual load resistance in Ohms (clamped > 0)
    this.loadResistance = typeof options.loadResistance === 'number'
      ? Math.max(1e-6, options.loadResistance)
      : 10.0;

    // Operating limits and setpoints
    this.activeVoltageLimit_mV = this.hardwareMaxVoltage_mV;
    this.activeCurrentLimit_mA = options.initialCurrent_mA !== undefined
      ? Math.min(this.hardwareMaxCurrent_mA, options.initialCurrent_mA)
      : this.hardwareMaxCurrent_mA;
    this.activePowerLimit_10mW = this.hardwareMaxPower_10mW;
    this.setVoltage_mV = options.initialVoltage_mV !== undefined
      ? Math.min(this.hardwareMaxVoltage_mV, Math.max(0, options.initialVoltage_mV))
      : 0;

    // Operating states (default Local mode and Output OFF)
    this.outputOn = options.outputOn !== undefined ? !!options.outputOn : false;
    this.remoteMode = options.remoteMode !== undefined ? !!options.remoteMode : false;

    // Slew rate simulation (instantaneous by default for deterministic tests)
    this.enableSlewRate = !!options.enableSlewRate;
    this.slewRate_V_per_s = options.slewRate_V_per_s || 100.0;
    this.lastSimTime = Date.now();
    this.currentSimVoltage_V = this.setVoltage_mV / 1000.0;

    // Stream chunk assembler for chunked write() streaming support
    this.assembler = new FrameChunkAssembler();
  }

  /**
   * Updates virtual load resistance in Ohms.
   * @param {number} ohms
   */
  setLoadResistance(ohms) {
    if (typeof ohms !== 'number' || isNaN(ohms)) {
      this.loadResistance = 10.0;
    } else {
      this.loadResistance = Math.max(1e-6, ohms);
    }
  }

  /**
   * Returns current virtual load resistance in Ohms.
   * @returns {number}
   */
  getLoadResistance() {
    return this.loadResistance;
  }

  /**
   * Directly sets output ON or OFF.
   * @param {boolean} on
   */
  setOutput(on) {
    this.outputOn = !!on;
  }

  /**
   * Directly sets remote or local mode.
   * @param {boolean} remote
   */
  setRemoteMode(remote) {
    this.remoteMode = !!remote;
  }

  /**
   * Directly sets target voltage in Volts.
   * @param {number} volts
   */
  setVoltage(volts) {
    const v = Number(volts);
    if (Number.isFinite(v)) {
      this.setVoltage_mV = Math.min(this.hardwareMaxVoltage_mV, Math.max(0, Math.round(v * 1000)));
    }
  }

  /**
   * Directly sets current limit in Amperes.
   * @param {number} amps
   */
  setCurrentLimit(amps) {
    const a = Number(amps);
    if (Number.isFinite(a)) {
      this.activeCurrentLimit_mA = Math.min(this.hardwareMaxCurrent_mA, Math.max(0, Math.round(a * 1000)));
    }
  }

  /**
   * Calculates electrical steady state based on Ohm's law and mode crossover.
   * @private
   * @returns {{ v_meas_mV: number, i_meas_mA: number, p_meas_10mW: number, mode: 'CV'|'CC', overPower: boolean }}
   */
  _calculatePhysics() {
    if (!this.outputOn) {
      this.currentSimVoltage_V = 0.0;
      this.lastSimTime = Date.now();
      return {
        v_meas_mV: 0,
        i_meas_mA: 0,
        p_meas_10mW: 0,
        mode: 'CV',
        overPower: false
      };
    }

    const targetV = this.setVoltage_mV / 1000.0;
    let effectiveV = targetV;

    if (this.enableSlewRate && this.slewRate_V_per_s > 0) {
      const now = Date.now();
      const dt = Math.max(0, (now - this.lastSimTime) / 1000.0);
      this.lastSimTime = now;
      const maxDelta = this.slewRate_V_per_s * dt;
      const diff = targetV - this.currentSimVoltage_V;
      if (Math.abs(diff) <= maxDelta) {
        this.currentSimVoltage_V = targetV;
      } else {
        this.currentSimVoltage_V += Math.sign(diff) * maxDelta;
      }
      effectiveV = this.currentSimVoltage_V;
    } else {
      this.currentSimVoltage_V = targetV;
      this.lastSimTime = Date.now();
    }

    const currentLimit_A = this.activeCurrentLimit_mA / 1000.0;
    const maxPower_W = this.activePowerLimit_10mW / 100.0;
    const rLoad = Math.max(1e-6, this.loadResistance);

    const calculatedCurrent_A = effectiveV / rLoad;

    let vMeas_V = 0.0;
    let iMeas_A = 0.0;
    let mode = 'CV';

    if (calculatedCurrent_A <= currentLimit_A) {
      // Constant Voltage (CV Mode)
      vMeas_V = effectiveV;
      iMeas_A = calculatedCurrent_A;
      mode = 'CV';
    } else {
      // Constant Current (CC Mode)
      iMeas_A = currentLimit_A;
      vMeas_V = currentLimit_A * rLoad;
      mode = 'CC';
    }

    const pMeas_W = vMeas_V * iMeas_A;
    const overPower = pMeas_W > maxPower_W;

    return {
      v_meas_mV: Math.round(vMeas_V * 1000),
      i_meas_mA: Math.round(iMeas_A * 1000),
      p_meas_10mW: Math.round(pMeas_W * 100),
      mode,
      overPower
    };
  }

  /**
   * Processes a single 26-byte binary frame and returns the 26-byte response.
   *
   * @param {Buffer} buffer
   * @returns {Buffer | null}
   */
  processFrame(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 26) {
      return null;
    }

    if (buffer[0] !== 0xAA || !verifyChecksum(buffer)) {
      return null;
    }

    const targetAddr = buffer[1];
    // Match device address or broadcast 0x00
    if (this.address !== 0x00 && targetAddr !== 0x00 && targetAddr !== this.address) {
      return null;
    }

    const cmd = buffer[2];

    switch (cmd) {
      case COMMANDS.CONTROL: { // 0x82: Output ON/OFF and Remote/Local Mode
        const ctrl = decodeControl(buffer);
        this.outputOn = ctrl.outputOn;
        this.remoteMode = ctrl.remoteMode;
        return encodeResponse(targetAddr, true, RESPONSE_CODES.OK);
      }

      case COMMANDS.SET_PARAMS: { // 0x80: Set limits and parameters
        // Command 0x80 is rejected if not in Remote mode!
        if (!this.remoteMode) {
          return encodeResponse(targetAddr, false, RESPONSE_CODES.ERROR);
        }

        const params = decodeSetParameters(buffer);
        this.setVoltage_mV = Math.min(this.hardwareMaxVoltage_mV, Math.max(0, params.setVoltage_mV));
        this.activeCurrentLimit_mA = Math.min(this.hardwareMaxCurrent_mA, Math.max(0, params.maxCurrent_mA));
        this.activeVoltageLimit_mV = Math.min(this.hardwareMaxVoltage_mV, Math.max(0, params.maxVoltage_mV));
        this.activePowerLimit_10mW = Math.min(this.hardwareMaxPower_10mW, Math.max(0, params.maxPower_10mW));

        if (params.newAddress !== undefined && params.newAddress !== 0 && params.newAddress !== this.address) {
          this.address = params.newAddress & 0xFF;
        }

        return encodeResponse(targetAddr, true, RESPONSE_CODES.OK);
      }

      case COMMANDS.READ_TELEMETRY: { // 0x81: Read Telemetry
        const physics = this._calculatePhysics();
        return encodeTelemetry(targetAddr, {
          current_mA: physics.i_meas_mA,
          voltage_mV: physics.v_meas_mV,
          power_10mW: physics.p_meas_10mW,
          maxCurrent_mA: this.activeCurrentLimit_mA,
          maxVoltage_mV: this.activeVoltageLimit_mV,
          maxPower_10mW: this.activePowerLimit_10mW,
          setVoltage_mV: this.setVoltage_mV,
          outputOn: this.outputOn,
          mode: physics.mode,
          overPower: physics.overPower,
          remote: this.remoteMode
        });
      }

      case COMMANDS.READ_MODEL_INFO: { // 0x8C: Read Model & Version
        return encodeModelResponse(targetAddr, {
          serialNumber: this.serialNumber,
          model: this.model,
          rawVersion: this.rawVersion
        });
      }

      default:
        // Unknown command -> NAK
        return encodeResponse(targetAddr, false, RESPONSE_CODES.ERROR);
    }
  }

  /**
   * Primary frame handling entrypoint (alias to processFrame).
   *
   * @param {Buffer} buffer
   * @returns {Buffer | null}
   */
  handleFrame(buffer) {
    return this.processFrame(buffer);
  }

  /**
   * Returns current telemetry object in decoded engineering units.
   * @returns {Object}
   */
  getTelemetry() {
    const physics = this._calculatePhysics();
    return {
      voltage_V: Number((physics.v_meas_mV / 1000.0).toFixed(3)),
      voltage_mV: physics.v_meas_mV,
      current_A: Number((physics.i_meas_mA / 1000.0).toFixed(3)),
      current_mA: physics.i_meas_mA,
      power_W: Number((physics.p_meas_10mW / 100.0).toFixed(2)),
      setVoltage_V: Number((this.setVoltage_mV / 1000.0).toFixed(3)),
      setVoltage_mV: this.setVoltage_mV,
      maxCurrent_A: Number((this.activeCurrentLimit_mA / 1000.0).toFixed(3)),
      maxCurrent_mA: this.activeCurrentLimit_mA,
      maxVoltage_V: Number((this.activeVoltageLimit_mV / 1000.0).toFixed(3)),
      maxVoltage_mV: this.activeVoltageLimit_mV,
      maxPower_W: Number((this.activePowerLimit_10mW / 100.0).toFixed(2)),
      loadResistance_ohm: this.loadResistance,
      state: {
        outputOn: this.outputOn,
        mode: physics.mode,
        overPower: physics.overPower,
        remote: this.remoteMode
      }
    };
  }

  /**
   * Returns internal simulator state.
   * @returns {Object}
   */
  getState() {
    return {
      outputOn: this.outputOn,
      remoteMode: this.remoteMode,
      setVoltage_mV: this.setVoltage_mV,
      setVoltage_V: Number((this.setVoltage_mV / 1000.0).toFixed(3)),
      activeCurrentLimit_mA: this.activeCurrentLimit_mA,
      activeCurrentLimit_A: Number((this.activeCurrentLimit_mA / 1000.0).toFixed(3)),
      activeVoltageLimit_mV: this.activeVoltageLimit_mV,
      activeVoltageLimit_V: Number((this.activeVoltageLimit_mV / 1000.0).toFixed(3)),
      activePowerLimit_10mW: this.activePowerLimit_10mW,
      activePowerLimit_W: Number((this.activePowerLimit_10mW / 100.0).toFixed(2)),
      loadResistance: this.loadResistance,
      address: this.address,
      model: this.model
    };
  }

  /**
   * Resets simulator to default power-on initialization state.
   */
  reset() {
    this.outputOn = false;
    this.remoteMode = false;
    this.setVoltage_mV = 0;
    this.loadResistance = 10.0;
    this.activeCurrentLimit_mA = this.hardwareMaxCurrent_mA;
    this.activeVoltageLimit_mV = this.hardwareMaxVoltage_mV;
    this.activePowerLimit_10mW = this.hardwareMaxPower_10mW;
    this.currentSimVoltage_V = 0.0;
    this.lastSimTime = Date.now();
    this.assembler.reset();
  }

  /**
   * Stream / SerialPort mock compatibility.
   * Feeds raw data buffer into frame chunk assembler and emits 'data' for each response.
   *
   * @param {Buffer} chunk
   * @param {Function} [callback]
   * @returns {boolean}
   */
  write(chunk, callback) {
    try {
      const frames = this.assembler.push(chunk);
      for (const frame of frames) {
        const resp = this.processFrame(frame);
        if (resp) {
          setImmediate(() => {
            this.emit('data', resp);
          });
        }
      }
      if (typeof callback === 'function') callback();
      return true;
    } catch (err) {
      if (typeof callback === 'function') callback(err);
      this.emit('error', err);
      return false;
    }
  }
}

module.exports = MockPowerSupply;
module.exports.MockPowerSupply = MockPowerSupply;
