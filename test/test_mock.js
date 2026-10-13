/**
 * test/test_mock.js
 *
 * Unit Test Suite for Virtual Mock Power Supply Simulator (lib/mock_power_supply.js)
 * Verified with portable Node.js test runner:
 *   & "D:\programok_kiírni\IO-LINK\NODERED\node.exe" --test test/test_mock.js
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const MockPowerSupply = require('../lib/mock_power_supply');
const protocol = require('../lib/array_protocol');

const {
  COMMANDS,
  RESPONSE_CODES,
  STATUS_BITS,
  buildFrame,
  verifyChecksum,
  decodeTelemetry,
  decodeResponse,
  decodeModelResponse
} = protocol;

describe('MockPowerSupply Unit Tests', () => {

  describe('Suite 1: Initialization & Interface Contract', () => {
    test('1.1: Default options initialization', () => {
      const mock = new MockPowerSupply();
      assert.equal(mock.model, '3645A');
      assert.equal(mock.address, 0x00);
      assert.equal(mock.loadResistance, 10.0);
      assert.equal(mock.outputOn, false);
      assert.equal(mock.remoteMode, false);
      assert.equal(mock.setVoltage_mV, 0);
      assert.equal(mock.hardwareMaxVoltage_mV, 36000);
      assert.equal(mock.hardwareMaxCurrent_mA, 3000);
      assert.equal(mock.hardwareMaxPower_10mW, 10800);
    });

    test('1.2: Custom options injection', () => {
      const mock = new MockPowerSupply({
        model: '3646A',
        address: 0x05,
        loadResistance: 25.0,
        initialVoltage_mV: 12000,
        initialCurrent_mA: 1000,
        remoteMode: true,
        outputOn: true
      });
      assert.equal(mock.model, '3646A');
      assert.equal(mock.address, 0x05);
      assert.equal(mock.loadResistance, 25.0);
      assert.equal(mock.setVoltage_mV, 12000);
      assert.equal(mock.outputOn, true);
      assert.equal(mock.remoteMode, true);
    });

    test('1.3: Required methods and properties exist', () => {
      const mock = new MockPowerSupply();
      assert.equal(typeof mock.processFrame, 'function');
      assert.equal(typeof mock.handleFrame, 'function');
      assert.equal(typeof mock.setLoadResistance, 'function');
      assert.equal(typeof mock.getLoadResistance, 'function');
      assert.equal(typeof mock.setOutput, 'function');
      assert.equal(typeof mock.setRemoteMode, 'function');
      assert.equal(typeof mock.setVoltage, 'function');
      assert.equal(typeof mock.setCurrentLimit, 'function');
      assert.equal(typeof mock.getTelemetry, 'function');
      assert.equal(typeof mock.getState, 'function');
      assert.equal(typeof mock.reset, 'function');
      assert.equal(typeof mock.write, 'function');
    });

    test('1.4: Load resistance clamping prevents division by zero', () => {
      const mock = new MockPowerSupply();
      mock.setLoadResistance(0);
      assert(mock.getLoadResistance() > 0, 'Resistance must be clamped > 0');
      mock.setLoadResistance(-5);
      assert(mock.getLoadResistance() > 0, 'Negative resistance must be clamped > 0');
      mock.setLoadResistance(NaN);
      assert.equal(mock.getLoadResistance(), 10.0, 'NaN falls back to default 10.0 Ohm');
    });
  });

  describe('Suite 2: Ohm\'s Law Calculation Accuracy', () => {
    test('2.1: CV Mode: 12V across 10 Ohm load -> I=1.2A, P=14.4W', () => {
      const mock = new MockPowerSupply();
      mock.setOutput(true);
      mock.setRemoteMode(true);
      mock.setVoltage(12.0);
      mock.setCurrentLimit(3.0);
      mock.setLoadResistance(10.0);

      const telem = mock.getTelemetry();
      assert.equal(telem.voltage_V, 12.0);
      assert.equal(telem.current_A, 1.2);
      assert.equal(telem.power_W, 14.4);
      assert.equal(telem.state.mode, 'CV');
      assert.equal(telem.state.outputOn, true);
      assert.equal(telem.state.overPower, false);
    });

    test('2.2: CV Mode: 24V across 40 Ohm load -> I=0.6A, P=14.4W', () => {
      const mock = new MockPowerSupply();
      mock.setOutput(true);
      mock.setRemoteMode(true);
      mock.setVoltage(24.0);
      mock.setCurrentLimit(2.0);
      mock.setLoadResistance(40.0);

      const telem = mock.getTelemetry();
      assert.equal(telem.voltage_V, 24.0);
      assert.equal(telem.current_A, 0.6);
      assert.equal(telem.power_W, 14.4);
      assert.equal(telem.state.mode, 'CV');
    });

    test('2.3: Zero voltage setpoint produces zero output current', () => {
      const mock = new MockPowerSupply();
      mock.setOutput(true);
      mock.setRemoteMode(true);
      mock.setVoltage(0.0);
      mock.setLoadResistance(10.0);

      const telem = mock.getTelemetry();
      assert.equal(telem.voltage_V, 0.0);
      assert.equal(telem.current_A, 0.0);
      assert.equal(telem.power_W, 0.0);
      assert.equal(telem.state.mode, 'CV');
    });
  });

  describe('Suite 3: Automatic CV / CC Crossover Transitions', () => {
    test('3.1: Resistance drop triggers CC mode and voltage collapse', () => {
      const mock = new MockPowerSupply();
      mock.setOutput(true);
      mock.setRemoteMode(true);
      mock.setVoltage(10.0);
      mock.setCurrentLimit(1.0); // 1.0A limit

      // High load: 20 Ohm -> I = 10/20 = 0.5A < 1.0A -> CV mode
      mock.setLoadResistance(20.0);
      let telem = mock.getTelemetry();
      assert.equal(telem.state.mode, 'CV');
      assert.equal(telem.voltage_V, 10.0);
      assert.equal(telem.current_A, 0.5);

      // Low load: 5 Ohm -> ideal I = 10/5 = 2.0A > 1.0A -> CC mode clamped to 1.0A
      mock.setLoadResistance(5.0);
      telem = mock.getTelemetry();
      assert.equal(telem.state.mode, 'CC');
      assert.equal(telem.current_A, 1.0);
      assert.equal(telem.voltage_V, 5.0); // 1.0A * 5 Ohm = 5.0V
      assert.equal(telem.power_W, 5.0);
    });

    test('3.2: Short circuit load drops voltage to near-zero and clamps current', () => {
      const mock = new MockPowerSupply();
      mock.setOutput(true);
      mock.setRemoteMode(true);
      mock.setVoltage(15.0);
      mock.setCurrentLimit(2.0);
      mock.setLoadResistance(0.001); // 1 mOhm

      const telem = mock.getTelemetry();
      assert.equal(telem.state.mode, 'CC');
      assert.equal(telem.current_A, 2.0);
      assert(telem.voltage_V < 0.1);
    });

    test('3.3: Over Power Protection (OPP) triggers when P > Pmax', () => {
      const mock = new MockPowerSupply({ model: '3645A' }); // maxPower = 108W
      mock.setOutput(true);
      mock.setRemoteMode(true);
      mock.activePowerLimit_10mW = 5000; // Artificially set 50.00 W limit
      mock.setVoltage(30.0);
      mock.setCurrentLimit(3.0);
      mock.setLoadResistance(15.0); // I = 30/15 = 2.0A -> P = 60W > 50W

      const telem = mock.getTelemetry();
      assert.equal(telem.power_W, 60.0);
      assert.equal(telem.state.overPower, true);

      // Check raw status bit2 in frame response
      const telemFrame = mock.processFrame(protocol.encodeTelemetryQuery(0x00));
      assert.equal((telemFrame[23] & STATUS_BITS.OVER_POWER), STATUS_BITS.OVER_POWER);
    });
  });

  describe('Suite 4: Output ON / OFF State Transitions', () => {
    test('4.1: Output OFF collapses measurements to zero', () => {
      const mock = new MockPowerSupply();
      mock.setVoltage(24.0);
      mock.setCurrentLimit(2.5);
      mock.setLoadResistance(10.0);
      mock.setOutput(false);

      const telem = mock.getTelemetry();
      assert.equal(telem.voltage_V, 0.0);
      assert.equal(telem.current_A, 0.0);
      assert.equal(telem.power_W, 0.0);
      assert.equal(telem.state.outputOn, false);
    });

    test('4.2: Toggling Output ON immediately applies setpoints', () => {
      const mock = new MockPowerSupply();
      mock.setVoltage(18.0);
      mock.setLoadResistance(10.0);
      mock.setOutput(false);

      let telem = mock.getTelemetry();
      assert.equal(telem.voltage_V, 0.0);

      mock.setOutput(true);
      telem = mock.getTelemetry();
      assert.equal(telem.voltage_V, 18.0);
      assert.equal(telem.current_A, 1.8);
      assert.equal(telem.state.outputOn, true);
    });
  });

  describe('Suite 5: Remote vs Local Mode Parameter Protection', () => {
    test('5.1: In Local Mode, Command 0x80 is rejected with NAK (0x90)', () => {
      const mock = new MockPowerSupply();
      assert.equal(mock.remoteMode, false);

      const setFrame = protocol.encodeSetParameters(0x00, {
        setVoltage_V: 15.0,
        maxCurrent_A: 2.0
      });

      const resp = mock.processFrame(setFrame);
      assert(Buffer.isBuffer(resp));
      assert.equal(resp.length, 26);
      assert.equal(resp[2], COMMANDS.RESPONSE_CHECK); // 0x12
      assert.equal(resp[3], RESPONSE_CODES.ERROR);     // 0x90 NAK

      const decoded = decodeResponse(resp);
      assert.equal(decoded.success, false);
      assert.equal(decoded.code, 0x90);

      // Verify setpoint was NOT modified
      assert.equal(mock.setVoltage_mV, 0);
    });

    test('5.2: In Remote Mode, Command 0x80 is accepted with ACK (0x80)', () => {
      const mock = new MockPowerSupply();

      // Put into Remote mode via 0x82 frame
      const remoteFrame = protocol.encodeControl(0x00, { outputOn: false, remoteMode: true });
      const resp1 = mock.processFrame(remoteFrame);
      assert.equal(resp1[3], RESPONSE_CODES.OK); // 0x80 ACK
      assert.equal(mock.remoteMode, true);

      // Now set voltage
      const setFrame = protocol.encodeSetParameters(0x00, {
        setVoltage_V: 20.0,
        maxCurrent_A: 2.5
      });
      const resp2 = mock.processFrame(setFrame);
      assert.equal(resp2[3], RESPONSE_CODES.OK); // 0x80 ACK
      assert.equal(mock.setVoltage_mV, 20000);
      assert.equal(mock.activeCurrentLimit_mA, 2500);
    });

    test('5.3: Command 0x81 Telemetry Query is permitted in both Local and Remote modes', () => {
      const mock = new MockPowerSupply();
      const queryFrame = protocol.encodeTelemetryQuery(0x00);

      // Query in Local mode
      mock.setRemoteMode(false);
      const respLocal = mock.processFrame(queryFrame);
      assert(Buffer.isBuffer(respLocal));
      assert.equal(respLocal[2], COMMANDS.READ_TELEMETRY);
      assert.equal(respLocal[23] & STATUS_BITS.REMOTE_MODE, 0);

      // Query in Remote mode
      mock.setRemoteMode(true);
      const respRemote = mock.processFrame(queryFrame);
      assert(Buffer.isBuffer(respRemote));
      assert.equal(respRemote[2], COMMANDS.READ_TELEMETRY);
      assert.equal(respRemote[23] & STATUS_BITS.REMOTE_MODE, STATUS_BITS.REMOTE_MODE);
    });
  });

  describe('Suite 6: Binary Frame Protocol Roundtrips & Device Info', () => {
    test('6.1: Command 0x8C returns model info frame', () => {
      const mock = new MockPowerSupply({ model: '3645A', serialNumber: '123456', rawVersion: 203 });
      const query = protocol.encodeModelQuery(0x00);
      const resp = mock.processFrame(query);

      assert(Buffer.isBuffer(resp));
      assert.equal(resp.length, 26);
      assert.equal(resp[2], COMMANDS.READ_MODEL_INFO);
      assert(verifyChecksum(resp));

      const decoded = decodeModelResponse(resp);
      assert.equal(decoded.model, '3645A');
      assert.equal(decoded.serialNumber, '123456');
      assert.equal(decoded.version, 'V2.03');
    });

    test('6.2: Invalid frame length or corrupted checksum is discarded (returns null)', () => {
      const mock = new MockPowerSupply();

      assert.equal(mock.processFrame(Buffer.alloc(20, 0xAA)), null);
      assert.equal(mock.processFrame(Buffer.alloc(30, 0xAA)), null);

      const corruptBuf = protocol.encodeTelemetryQuery(0x00);
      corruptBuf[25] ^= 0x01; // flip checksum
      assert.equal(mock.processFrame(corruptBuf), null);

      corruptBuf[0] = 0x55; // wrong header
      assert.equal(mock.processFrame(corruptBuf), null);
    });

    test('6.3: Unknown command code returns NAK frame', () => {
      const mock = new MockPowerSupply();
      const unknownFrame = buildFrame(0x00, 0x99, Buffer.alloc(22, 0));
      const resp = mock.processFrame(unknownFrame);

      assert(Buffer.isBuffer(resp));
      assert.equal(resp[2], COMMANDS.RESPONSE_CHECK);
      assert.equal(resp[3], RESPONSE_CODES.ERROR);
    });

    test('6.4: reset() restores default power-on parameters', () => {
      const mock = new MockPowerSupply();
      mock.setOutput(true);
      mock.setRemoteMode(true);
      mock.setVoltage(25.0);
      mock.setLoadResistance(50.0);

      mock.reset();
      const state = mock.getState();
      assert.equal(state.outputOn, false);
      assert.equal(state.remoteMode, false);
      assert.equal(state.setVoltage_mV, 0);
      assert.equal(state.loadResistance, 10.0);
    });

    test('6.5: Stream write() emits data event asynchronously', (t, done) => {
      const mock = new MockPowerSupply();
      const query = protocol.encodeTelemetryQuery(0x00);

      mock.once('data', (data) => {
        assert(Buffer.isBuffer(data));
        assert.equal(data.length, 26);
        assert.equal(data[2], COMMANDS.READ_TELEMETRY);
        done();
      });

      mock.write(query);
    });
  });
});
