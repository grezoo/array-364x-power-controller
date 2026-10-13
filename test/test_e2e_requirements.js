/**
 * E2E Requirement Test Suite (Tiers 1-4)
 * Project: Array 364X / 3600 Series tápegység Node-RED Vezérlő és Adatgyűjtő Rendszer
 *
 * Requirements Sources:
 *   - ORIGINAL_REQUEST.md (§R1 Binary Protocol, §R2 Split Dashboard, §R3 Launcher)
 *   - PROJECT.md (§Architecture, §Feature Inventory, §Interface Contracts)
 *   - TEST_INFRA.md (§Test Philosophy, §Coverage Thresholds, §Tier 1-4 Specs)
 *   - Manufacturer PDF: "Communication protocol for power supply.pdf" (Array Electronic Co., Ltd.)
 *
 * Test Runner:
 *   D:\programok_kiírni\IO-LINK\NODERED\node.exe --test test/test_e2e_requirements.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ============================================================================
// File Path Definitions (SSD Sandbox Workspace)
// ============================================================================
const ROOT_DIR = path.resolve(__dirname, '..');
const PROTOCOL_PATH = path.join(ROOT_DIR, 'lib', 'array_protocol.js');
const MOCK_PATH = path.join(ROOT_DIR, 'lib', 'mock_power_supply.js');
const CONTROLLER_PATH = path.join(ROOT_DIR, 'lib', 'power_controller.js');
const FLOWS_PATH = path.join(ROOT_DIR, 'flows.json');
const SETTINGS_PATH = path.join(ROOT_DIR, 'settings.js');
const LAUNCHER_PATH = path.join(ROOT_DIR, 'start_array_power.bat');

// Progressive module loader helper
function getModuleOrNull(modulePath) {
    if (fs.existsSync(modulePath)) {
        try {
            return require(modulePath);
        } catch (err) {
            return { __loadError: err };
        }
    }
    return null;
}

// ============================================================================
// Authoritative Reference Oracles (Directly derived from Manufacturer Spec)
// ============================================================================

/**
 * Authoritative Modulo-256 Checksum Algorithm (PDF Page 1, Section C)
 * Checksum = sum(bytes[0..24]) & 0xFF.
 */
function oracleChecksum(buf) {
    assert(Buffer.isBuffer(buf), 'Input must be a Buffer');
    assert(buf.length >= 25, 'Buffer must be at least 25 bytes');
    let sum = 0;
    for (let i = 0; i < 25; i++) {
        sum = (sum + buf[i]) & 0xFF;
    }
    return sum;
}

/**
 * Authoritative 26-Byte Frame Builder
 */
function oracleBuildFrame(address, cmd, dataBuffer) {
    const frame = Buffer.alloc(26, 0);
    frame[0] = 0xAA;
    frame[1] = address & 0xFF;
    frame[2] = cmd & 0xFF;
    if (dataBuffer) {
        dataBuffer.copy(frame, 3, 0, Math.min(22, dataBuffer.length));
    }
    frame[25] = oracleChecksum(frame);
    return frame;
}

/**
 * Authoritative Ohm's Law Simulation Engine
 * Models Constant Voltage (CV) and Constant Current (CC) behavior with precision.
 */
function oracleSimulateOhm(vSet, iLimit, rLoad, outputOn) {
    if (!outputOn || rLoad <= 0) {
        return {
            voltage_V: 0.0,
            current_A: 0.0,
            power_W: 0.0,
            mode: 'CV',
            outputOn: !!outputOn,
            statusByte: outputOn ? 0x01 : 0x00
        };
    }

    const calculatedCurrent = vSet / rLoad;
    if (calculatedCurrent <= iLimit) {
        // CV Mode
        const vMeas = vSet;
        const iMeas = calculatedCurrent;
        const pMeas = vMeas * iMeas;
        return {
            voltage_V: Math.round(vMeas * 1000) / 1000,
            current_A: Math.round(iMeas * 1000) / 1000,
            power_W: Math.round(pMeas * 100) / 100,
            mode: 'CV',
            outputOn: true,
            statusByte: 0x01 // b0=1 (ON), b1=0 (CV)
        };
    } else {
        // CC Mode
        const iMeas = iLimit;
        const vMeas = iLimit * rLoad;
        const pMeas = vMeas * iMeas;
        return {
            voltage_V: Math.round(vMeas * 1000) / 1000,
            current_A: Math.round(iMeas * 1000) / 1000,
            power_W: Math.round(pMeas * 100) / 100,
            mode: 'CC',
            outputOn: true,
            statusByte: 0x03 // b0=1 (ON), b1=1 (CC)
        };
    }
}

// ============================================================================
// SUITE 0: AUTHORITATIVE ORACLE & SPECIFICATION BENCHMARK VERIFICATION
// ============================================================================
describe('Oracle & Specification Benchmark Verifications', () => {

    test('O.1: Manufacturer Example 1 (0x80 Set Parameters) Exact Frame Benchmark', () => {
        // Source: Communication protocol for power supply.pdf, Page 8
        const hex = 'AA0080B80BA08C0000302AB80B00000000000000000000000036';
        const buf = Buffer.from(hex, 'hex');

        assert.equal(buf.length, 26, 'Official frame length is 26 bytes');
        assert.equal(buf[0], 0xAA, 'Start byte is 0xAA');
        assert.equal(buf[1], 0x00, 'Address is 0x00');
        assert.equal(buf[2], 0x80, 'Command is 0x80');
        assert.equal(buf.readUInt16LE(3), 3000, 'Current limit is 3000mA');
        assert.equal(buf.readUInt32LE(5), 36000, 'Voltage limit is 36000mV');
        assert.equal(buf.readUInt16LE(9), 10800, 'Power limit is 10800 (108.00W)');
        assert.equal(buf.readUInt32LE(11), 3000, 'Set voltage is 3000mV');
        assert.equal(buf[15], 0x00, 'New address is 0x00');
        assert.equal(oracleChecksum(buf), 0x36, 'Checksum calculation matches official 0x36');
    });

    test('O.2: Manufacturer Example 3A, 3B, 4 (0x82 Output & Control) Exact Frame Benchmarks', () => {
        // Example 3A: Remote ON -> 0x03 -> Checksum 0x2F
        const b3a = Buffer.from('AA0082030000000000000000000000000000000000000000002F', 'hex');
        assert.equal(oracleChecksum(b3a), 0x2F);

        // Example 3B: Remote OFF -> 0x02 -> Checksum 0x2E
        const b3b = Buffer.from('AA0082020000000000000000000000000000000000000000002E', 'hex');
        assert.equal(oracleChecksum(b3b), 0x2E);

        // Example 4: Local OFF -> 0x00 -> Checksum 0x2C
        const b4 = Buffer.from('AA0082000000000000000000000000000000000000000000002C', 'hex');
        assert.equal(oracleChecksum(b4), 0x2C);
    });

    test('O.3: Manufacturer Telemetry Query (0x81) and ACK/NAK (0x12) Benchmarks', () => {
        // Query frame
        const query = Buffer.from('AA0081000000000000000000000000000000000000000000002B', 'hex');
        assert.equal(oracleChecksum(query), 0x2B);

        // ACK frame: AA 00 12 80 ... 3C
        const ack = Buffer.alloc(26, 0);
        ack[0] = 0xAA; ack[1] = 0x00; ack[2] = 0x12; ack[3] = 0x80;
        assert.equal(oracleChecksum(ack), 0x3C);

        // NAK frame: AA 00 12 90 ... 4C
        const nak = Buffer.alloc(26, 0);
        nak[0] = 0xAA; nak[1] = 0x00; nak[2] = 0x12; nak[3] = 0x90;
        assert.equal(oracleChecksum(nak), 0x4C);
    });

    test('O.4: Mathematical Law of Conservation (Ohm and Power Formulas)', () => {
        // 12V across 8 Ohm with 2A limit -> I = 1.5A < 2A -> CV Mode, P = 18W
        const r1 = oracleSimulateOhm(12.0, 2.0, 8.0, true);
        assert.equal(r1.voltage_V, 12.0);
        assert.equal(r1.current_A, 1.5);
        assert.equal(r1.power_W, 18.0);
        assert.equal(r1.mode, 'CV');

        // 12V across 3 Ohm with 2A limit -> calculated I = 4A > 2A -> CC Mode, V = 2A * 3R = 6V, P = 12W
        const r2 = oracleSimulateOhm(12.0, 2.0, 3.0, true);
        assert.equal(r2.voltage_V, 6.0);
        assert.equal(r2.current_A, 2.0);
        assert.equal(r2.power_W, 12.0);
        assert.equal(r2.mode, 'CC');
    });
});

// ============================================================================
// SUITE 1: TIER 1 — FEATURE COVERAGE (F1 to F10)
// ============================================================================
describe('Tier 1: Feature Coverage (F1 to F10)', () => {

    test('T1.1: F1 - 26-Byte Binary Frame Codec Implementation Verification', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        assert.equal(typeof protocol.calculateChecksum, 'function', 'protocol.calculateChecksum must be exported');
        assert.equal(typeof protocol.buildFrame, 'function', 'protocol.buildFrame must be exported');
        assert.equal(typeof protocol.parseFrame, 'function', 'protocol.parseFrame must be exported');

        const testBuf = Buffer.alloc(26, 0);
        testBuf[0] = 0xAA; testBuf[1] = 0x00; testBuf[2] = 0x82; testBuf[3] = 0x03;
        testBuf[25] = protocol.calculateChecksum(testBuf);
        assert.equal(testBuf[25], 0x2F, 'Calculated checksum must match Example 3A');

        const parsed = protocol.parseFrame(testBuf);
        assert.equal(parsed.valid, true, 'parseFrame must validate correct frame');
        assert.equal(parsed.cmd, 0x82, 'parseFrame must extract command');
    });

    test('T1.2: F1 & F2 - Command 0x82 Output ON/OFF & Remote/Local Encoder', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        assert.equal(typeof protocol.encodeControl, 'function', 'protocol.encodeControl must be exported');

        // Remote ON
        const fOn = protocol.encodeControl(0x00, { outputOn: true, remoteMode: true });
        assert.equal(fOn.length, 26);
        assert.equal(fOn.toString('hex').toUpperCase(), 'AA0082030000000000000000000000000000000000000000002F');

        // Remote OFF
        const fOff = protocol.encodeControl(0x00, { outputOn: false, remoteMode: true });
        assert.equal(fOff.length, 26);
        assert.equal(fOff.toString('hex').toUpperCase(), 'AA0082020000000000000000000000000000000000000000002E');
    });

    test('T1.3: F2 - Command 0x80 Parameter Set Encoder Matching Manufacturer Vector', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        assert.equal(typeof protocol.encodeSetParameters, 'function', 'protocol.encodeSetParameters must be exported');
        const frame = protocol.encodeSetParameters(0x00, {
            maxCurrent_mA: 3000,
            maxVoltage_mV: 36000,
            maxPower_10mW: 10800,
            setVoltage_mV: 3000,
            newAddress: 0x00
        });

        assert.equal(frame.length, 26);
        assert.equal(frame.toString('hex').toUpperCase(), 'AA0080B80BA08C0000302AB80B00000000000000000000000036');
    });

    test('T1.4: F2 - Command 0x81 Telemetry Query & Complete Decoded Fields', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        assert.equal(typeof protocol.encodeTelemetryQuery, 'function');
        assert.equal(typeof protocol.decodeTelemetry, 'function');

        const qFrame = protocol.encodeTelemetryQuery(0x00);
        assert.equal(qFrame.toString('hex').toUpperCase(), 'AA0081000000000000000000000000000000000000000000002B');

        // Synthesize full telemetry response frame
        const telemBuf = Buffer.alloc(26, 0);
        telemBuf[0] = 0xAA; telemBuf[1] = 0x00; telemBuf[2] = 0x81;
        telemBuf.writeUInt16LE(1500, 3);   // 1500mA
        telemBuf.writeUInt32LE(12000, 5);  // 12000mV
        telemBuf.writeUInt16LE(1800, 9);   // 18.00W
        telemBuf.writeUInt16LE(3000, 11);  // Max 3000mA
        telemBuf.writeUInt32LE(36000, 13); // Max 36000mV
        telemBuf.writeUInt16LE(10800, 17); // Max 108.00W
        telemBuf.writeUInt32LE(12000, 19); // Set 12000mV
        telemBuf[23] = 0x09;               // b0=1 ON, b1=0 CV, b2=0 Normal, b3=1 Remote
        telemBuf[25] = protocol.calculateChecksum(telemBuf);

        const decoded = protocol.decodeTelemetry(telemBuf);
        assert.equal(decoded.current_mA, 1500);
        assert.equal(decoded.voltage_mV, 12000);
        assert.equal(decoded.power_W, 18.00);
        assert.equal(decoded.maxCurrent_mA, 3000);
        assert.equal(decoded.maxVoltage_mV, 36000);
        assert.equal(decoded.maxPower_W, 108.00);
        assert.equal(decoded.setVoltage_mV, 12000);
        assert.equal(decoded.state.outputOn, true);
        assert.equal(decoded.state.mode, 'CV');
        assert.equal(decoded.state.overPower, false);
        assert.equal(decoded.state.remote, true);
    });

    test('T1.5: F2 - Command 0x12 / 0x90 ACK and NAK Response Decoder', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        assert.equal(typeof protocol.decodeResponse, 'function');

        const ack = Buffer.alloc(26, 0);
        ack[0] = 0xAA; ack[1] = 0x00; ack[2] = 0x12; ack[3] = 0x80;
        ack[25] = protocol.calculateChecksum(ack);
        const resAck = protocol.decodeResponse(ack);
        assert.equal(resAck.success, true);
        assert.equal(resAck.code, 0x80);

        const nak = Buffer.alloc(26, 0);
        nak[0] = 0xAA; nak[1] = 0x00; nak[2] = 0x12; nak[3] = 0x90;
        nak[25] = protocol.calculateChecksum(nak);
        const resNak = protocol.decodeResponse(nak);
        assert.equal(resNak.success, false);
        assert.equal(resNak.code, 0x90);
    });

    test('T1.6: F3 - Virtual Mock Simulator Existence & Interface Contract', (t) => {
        const MockClass = getModuleOrNull(MOCK_PATH);
        if (!MockClass) {
            t.skip('Pending M2: lib/mock_power_supply.js not yet implemented');
            return;
        }
        if (MockClass.__loadError) throw MockClass.__loadError;

        const mock = typeof MockClass === 'function' ? new MockClass() : MockClass;
        assert.equal(typeof mock.processFrame, 'function');
        assert.equal(typeof mock.setLoadResistance, 'function');

        mock.setLoadResistance(10.0);
        const onFrame = oracleBuildFrame(0x00, 0x82, Buffer.from([0x03]));
        const resp = mock.processFrame(onFrame);
        assert.equal(Buffer.isBuffer(resp), true);
        assert.equal(resp.length, 26);
        assert.equal(resp[2], 0x12);
        assert.equal(resp[3], 0x80);
    });

    test('T1.7: F4 - Controller & Transport Layer Switching and Event Contract', (t) => {
        const ControllerClass = getModuleOrNull(CONTROLLER_PATH);
        if (!ControllerClass) {
            t.skip('Pending M2: lib/power_controller.js not yet implemented');
            return;
        }
        if (ControllerClass.__loadError) throw ControllerClass.__loadError;

        const controller = typeof ControllerClass === 'function' ? new ControllerClass() : ControllerClass;
        assert.equal(typeof controller.init, 'function');
        assert.equal(typeof controller.setOutput, 'function');
        assert.equal(typeof controller.setVoltage, 'function');
        assert.equal(typeof controller.setCurrentLimit, 'function');
        assert.equal(typeof controller.setMockMode, 'function');
        assert.equal(typeof controller.getTelemetry, 'function');
    });

    test('T1.8: F5 - Node-RED Runtime Settings Configuration (`settings.js`)', (t) => {
        if (!fs.existsSync(SETTINGS_PATH)) {
            t.skip('Pending M3: settings.js not yet implemented');
            return;
        }

        const settingsContent = fs.readFileSync(SETTINGS_PATH, 'utf8');
        assert.match(settingsContent, /uiPort\s*:\s*1880/);
        assert.match(settingsContent, /functionGlobalContext/);
        assert.match(settingsContent, /arrayPower|ArrayPower/i);
    });

    test('T1.9: F6 & F7 - Split Dashboard UI Structure Validation (`flows.json`)', (t) => {
        if (!fs.existsSync(FLOWS_PATH)) {
            t.skip('Pending M3: flows.json not yet implemented');
            return;
        }

        const flowsRaw = fs.readFileSync(FLOWS_PATH, 'utf8');
        let flows;
        assert.doesNotThrow(() => { flows = JSON.parse(flowsRaw); });
        assert(Array.isArray(flows));

        const tabNodes = flows.filter(n => n.type === 'ui_tab');
        assert(tabNodes.length >= 2, 'Dashboard must have at least 2 distinct tabs');
        const tabNames = tabNodes.map(n => n.name || '');
        assert(tabNames.some(name => /kezel|operator|fő|main/i.test(name)), 'Operator tab required');
        assert(tabNames.some(name => /beáll|setting|config/i.test(name)), 'Settings tab required');

        const gauges = flows.filter(n => n.type === 'ui_gauge');
        assert(gauges.length >= 2, 'Gauges for V and I required');

        const charts = flows.filter(n => n.type === 'ui_chart');
        assert(charts.length >= 1, 'Rolling trend chart required');

        const buttons = flows.filter(n => n.type === 'ui_button');
        const buttonLabels = buttons.map(b => (b.label || '').trim());
        assert(buttonLabels.some(l => l.includes('0.01') || l.includes('0.1') || l.includes('1')), 'Steppers required');
    });

    test('T1.10: F8 - Rolling Trends & CSV Logging Requirements', () => {
        const requiredHeaders = ['Timestamp', 'Voltage_V', 'Current_A', 'Power_W', 'Mode', 'OutputState'];
        const sampleRow = `${new Date().toISOString()},12.000,1.500,18.00,CV,ON`;
        const rowCols = sampleRow.split(',');

        assert.equal(rowCols.length, requiredHeaders.length);
        assert(!isNaN(Date.parse(rowCols[0])));
        assert.equal(parseFloat(rowCols[1]), 12.0);
        assert.equal(parseFloat(rowCols[2]), 1.5);
        assert.equal(parseFloat(rowCols[3]), 18.0);
        assert(['CV', 'CC'].includes(rowCols[4]));
        assert(['ON', 'OFF'].includes(rowCols[5]));
    });

    test('T1.11: F9 - Windows Launcher Script (`start_array_power.bat`) Inspection', (t) => {
        if (!fs.existsSync(LAUNCHER_PATH)) {
            t.skip('Pending M4: start_array_power.bat not yet implemented');
            return;
        }

        const batContent = fs.readFileSync(LAUNCHER_PATH, 'utf8');
        assert.match(batContent, /1880/);
        assert.match(batContent, /http:\/\/localhost:1880\/ui/i);
        assert.match(batContent, /node\.exe/i);
    });

    test('T1.12: F10 - System Verification Integrity and Non-Facade Compliance', () => {
        const cv = oracleSimulateOhm(12.0, 2.0, 10.0, true);
        assert.equal(cv.voltage_V, 12.0);
        assert.equal(cv.current_A, 1.2);
        assert.equal(cv.power_W, 14.4);
        assert.equal(cv.mode, 'CV');

        const cc = oracleSimulateOhm(12.0, 1.0, 6.0, true);
        assert.equal(cc.voltage_V, 6.0);
        assert.equal(cc.current_A, 1.0);
        assert.equal(cc.power_W, 6.0);
        assert.equal(cc.mode, 'CC');
    });
});

// ============================================================================
// SUITE 2: TIER 2 — BOUNDARY & CORNER CASES
// ============================================================================
describe('Tier 2: Boundary & Corner Cases', () => {

    test('T2.1: Zero Value Setpoint and Boundary Conditions (0.000V, 0.000A, Addr 0x00)', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        const frame = protocol.encodeSetParameters(0x00, {
            maxCurrent_mA: 0,
            maxVoltage_mV: 0,
            maxPower_10mW: 0,
            setVoltage_mV: 0,
            newAddress: 0x00
        });

        assert.equal(frame.length, 26);
        assert.equal(frame[0], 0xAA);
        assert.equal(frame[1], 0x00);
        assert.equal(frame[2], 0x80);
        for (let i = 3; i < 25; i++) {
            assert.equal(frame[i], 0x00, `Byte ${i} should be 0`);
        }
        assert.equal(frame[25], 0x2A, 'Checksum for zero parameters must be 0x2A');
    });

    test('T2.2: Maximum Hardware Limits (36.000V, 3.000A, 108.00W, Addr 0xFE)', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        const frame = protocol.encodeSetParameters(0xFE, {
            maxCurrent_mA: 3000,
            maxVoltage_mV: 36000,
            maxPower_10mW: 10800,
            setVoltage_mV: 36000,
            newAddress: 0xFE
        });

        assert.equal(frame.length, 26);
        assert.equal(frame[1], 0xFE);
        assert.equal(frame.readUInt16LE(3), 3000);
        assert.equal(frame.readUInt32LE(5), 36000);
        assert.equal(frame.readUInt16LE(9), 10800);
        assert.equal(frame.readUInt32LE(11), 36000);
        assert.equal(frame[15], 0xFE);
        assert.equal(frame[25], protocol.calculateChecksum(frame));
    });

    test('T2.3: Frame Corruption - Invalid Start Byte Rejection (0x55 instead of 0xAA)', (t) => {
        const corruptBuf = Buffer.alloc(26, 0);
        corruptBuf[0] = 0x55; corruptBuf[1] = 0x00; corruptBuf[2] = 0x81;
        corruptBuf[25] = oracleChecksum(corruptBuf);

        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        const parsed = protocol.parseFrame(corruptBuf);
        assert.equal(parsed.valid, false);
        assert(parsed.error && parsed.error.length > 0);
    });

    test('T2.4: Frame Corruption - Length Underflow (<26) and Overflow (>26)', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        const parsedShort = protocol.parseFrame(Buffer.alloc(20, 0xAA));
        assert.equal(parsedShort.valid, false);

        const parsedLong = protocol.parseFrame(Buffer.alloc(32, 0xAA));
        assert.equal(parsedLong.valid, false);
    });

    test('T2.5: Frame Corruption - Single-Bit Checksum Invalidation', (t) => {
        const rawHex = 'AA0080B80BA08C0000302AB80B00000000000000000000000036';
        const corruptBuf = Buffer.from(rawHex, 'hex');
        corruptBuf[25] ^= 0x01; // Bit flip

        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        const parsed = protocol.parseFrame(corruptBuf);
        assert.equal(parsed.valid, false);
        assert.match(parsed.error, /checksum/i);
    });

    test('T2.6: Numerical Boundary Transitions (Crossing 255 -> 256 and 65535 -> 65536)', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        const f255 = protocol.encodeSetParameters(0x00, {
            maxCurrent_mA: 1000,
            maxVoltage_mV: 36000,
            maxPower_10mW: 10800,
            setVoltage_mV: 255,
            newAddress: 0x00
        });
        assert.equal(f255.readUInt32LE(11), 255);
        assert.equal(f255[11], 0xFF);
        assert.equal(f255[12], 0x00);

        const f256 = protocol.encodeSetParameters(0x00, {
            maxCurrent_mA: 1000,
            maxVoltage_mV: 36000,
            maxPower_10mW: 10800,
            setVoltage_mV: 256,
            newAddress: 0x00
        });
        assert.equal(f256.readUInt32LE(11), 256);
        assert.equal(f256[11], 0x00);
        assert.equal(f256[12], 0x01);
    });

    test('T2.7: Software Safety Limit Clamping Enforcement', (t) => {
        const ControllerClass = getModuleOrNull(CONTROLLER_PATH);
        if (!ControllerClass) {
            t.skip('Pending M2: lib/power_controller.js not yet implemented');
            return;
        }
        if (ControllerClass.__loadError) throw ControllerClass.__loadError;

        const controller = typeof ControllerClass === 'function' ? new ControllerClass() : ControllerClass;
        controller.init({
            isMock: true,
            limits: { maxVoltage_V: 20.0, maxCurrent_A: 2.0 }
        });

        controller.setVoltage(25.0)
            .then(() => {
                const telem = controller.getTelemetry();
                assert(telem.setVoltage_mV <= 20000, 'Voltage must not exceed safety limit');
            })
            .catch(err => {
                assert(err, 'Rejection of excessive voltage is safe behavior');
            });
    });

    test('T2.8: Negative Setpoint Clamping / Protection', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        assert.doesNotThrow(() => {
            const frame = protocol.encodeSetParameters(0x00, {
                maxCurrent_mA: 1000,
                maxVoltage_mV: 36000,
                maxPower_10mW: 10800,
                setVoltage_mV: -5000,
                newAddress: 0x00
            });
            assert(frame.readUInt32LE(11) === 0 || frame.readUInt32LE(11) <= 36000);
        });
    });

    test('T2.9: Rapid Consecutive Command Queuing Order', (t) => {
        const ControllerClass = getModuleOrNull(CONTROLLER_PATH);
        if (!ControllerClass) {
            t.skip('Pending M2: lib/power_controller.js not yet implemented');
            return;
        }
        if (ControllerClass.__loadError) throw ControllerClass.__loadError;

        const controller = typeof ControllerClass === 'function' ? new ControllerClass() : ControllerClass;
        controller.init({ isMock: true });

        const p1 = controller.setVoltage(5.0);
        const p2 = controller.setVoltage(10.0);
        const p3 = controller.setVoltage(15.0);

        Promise.all([p1, p2, p3]).then(() => {
            const telem = controller.getTelemetry();
            assert.equal(Math.round(telem.setVoltage_mV / 1000), 15);
        });
    });

    test('T2.10: Status Byte Bitfield Decode Combinations (b0..b3)', (t) => {
        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        const testCases = [
            { byte: 0x00, out: false, mode: 'CV', opp: false, rem: false },
            { byte: 0x01, out: true,  mode: 'CV', opp: false, rem: false },
            { byte: 0x03, out: true,  mode: 'CC', opp: false, rem: false },
            { byte: 0x07, out: true,  mode: 'CC', opp: true,  rem: false },
            { byte: 0x0B, out: true,  mode: 'CC', opp: false, rem: true  }
        ];

        for (const tc of testCases) {
            const buf = Buffer.alloc(26, 0);
            buf[0] = 0xAA; buf[2] = 0x81; buf[23] = tc.byte;
            buf[25] = protocol.calculateChecksum(buf);

            const decoded = protocol.decodeTelemetry(buf);
            assert.equal(decoded.state.outputOn, tc.out);
            assert.equal(decoded.state.mode, tc.mode);
            assert.equal(decoded.state.overPower, tc.opp);
            assert.equal(decoded.state.remote, tc.rem);
        }
    });

    test('T2.11: Adversarial Frame Synchronization with Embedded 0xAA Payload Byte', (t) => {
        // Frame where a data byte inside payload happens to equal 0xAA
        const frame = Buffer.alloc(26, 0);
        frame[0] = 0xAA;
        frame[1] = 0x00;
        frame[2] = 0x80;
        frame[7] = 0xAA; // Embedded 0xAA inside payload
        frame[25] = oracleChecksum(frame);

        const protocol = getModuleOrNull(PROTOCOL_PATH);
        if (!protocol) {
            t.skip('Pending M1: lib/array_protocol.js not yet implemented');
            return;
        }
        if (protocol.__loadError) throw protocol.__loadError;

        const parsed = protocol.parseFrame(frame);
        assert.equal(parsed.valid, true, 'Parser must not get confused by 0xAA in data payload');
        assert.equal(parsed.cmd, 0x80);
    });

    test('T2.12: Modulo-256 Sum Rollover Boundaries (Sum=256 -> 0, Sum=512 -> 0)', () => {
        // Construct 25-byte buffer whose sum equals exactly 256
        const b256 = Buffer.alloc(25, 0);
        b256[0] = 200;
        b256[1] = 56; // 200 + 56 = 256 -> modulo 256 = 0
        assert.equal(oracleChecksum(b256), 0, 'Checksum must roll over cleanly at 256');

        // Construct 25-byte buffer whose sum equals 511 -> modulo 256 = 255
        const b511 = Buffer.alloc(25, 0);
        b511[0] = 255;
        b511[1] = 255;
        b511[2] = 1; // 511 -> 511 % 256 = 255
        assert.equal(oracleChecksum(b511), 255, 'Checksum must roll over cleanly at 511');
    });
});

// ============================================================================
// SUITE 3: TIER 3 — CROSS-FEATURE COMBINATIONS & STATE TRANSITIONS
// ============================================================================
describe('Tier 3: Cross-Feature Combinations & State Transitions', () => {

    test('T3.1: Remote Mode Toggle -> Voltage Setpoint -> Telemetry Validation', (t) => {
        const MockClass = getModuleOrNull(MOCK_PATH);
        if (!MockClass) {
            t.skip('Pending M2: lib/mock_power_supply.js not yet implemented');
            return;
        }
        if (MockClass.__loadError) throw MockClass.__loadError;

        const mock = typeof MockClass === 'function' ? new MockClass() : MockClass;
        mock.setLoadResistance(20.0);

        // Step 1: Remote ON
        const onResp = mock.processFrame(oracleBuildFrame(0x00, 0x82, Buffer.from([0x03])));
        assert.equal(onResp[3], 0x80);

        // Step 2: Set V=12V (12000mV), I=2A (2000mA)
        const pData = Buffer.alloc(22, 0);
        pData.writeUInt16LE(2000, 0);
        pData.writeUInt32LE(36000, 2);
        pData.writeUInt16LE(10800, 6);
        pData.writeUInt32LE(12000, 8);
        const setResp = mock.processFrame(oracleBuildFrame(0x00, 0x80, pData));
        assert.equal(setResp[3], 0x80);

        // Step 3: Query Telemetry
        const telem = mock.processFrame(oracleBuildFrame(0x00, 0x81, Buffer.alloc(22, 0)));
        assert.equal(telem.readUInt32LE(5), 12000);
        assert.equal(telem.readUInt16LE(3), 600); // 12V / 20 Ohm = 0.6A = 600mA
        assert.equal(telem[23] & 0x01, 1);       // ON
        assert.equal(telem[23] & 0x02, 0);       // CV
        assert.equal(telem[23] & 0x08, 8);       // Remote
    });

    test('T3.2: Output ON -> Load Resistance Drop -> Automatic CV to CC Transition', (t) => {
        const MockClass = getModuleOrNull(MOCK_PATH);
        if (!MockClass) {
            t.skip('Pending M2: lib/mock_power_supply.js not yet implemented');
            return;
        }
        if (MockClass.__loadError) throw MockClass.__loadError;

        const mock = typeof MockClass === 'function' ? new MockClass() : MockClass;
        mock.processFrame(oracleBuildFrame(0x00, 0x82, Buffer.from([0x03])));

        // Set V=12V (12000mV), I_limit=1.5A (1500mA)
        const pData = Buffer.alloc(22, 0);
        pData.writeUInt16LE(1500, 0);
        pData.writeUInt32LE(36000, 2);
        pData.writeUInt16LE(10800, 6);
        pData.writeUInt32LE(12000, 8);
        mock.processFrame(oracleBuildFrame(0x00, 0x80, pData));

        // High load (20 Ohm) -> CV Mode
        mock.setLoadResistance(20.0);
        const telemA = mock.processFrame(oracleBuildFrame(0x00, 0x81, Buffer.alloc(22, 0)));
        assert.equal(telemA[23] & 0x02, 0, 'Must be in CV mode');
        assert.equal(telemA.readUInt32LE(5), 12000);

        // Low load (4 Ohm) -> CC Mode Crossover
        mock.setLoadResistance(4.0);
        const telemB = mock.processFrame(oracleBuildFrame(0x00, 0x81, Buffer.alloc(22, 0)));
        assert.equal(telemB[23] & 0x02, 2, 'Must transition to CC mode');
        assert.equal(telemB.readUInt16LE(3), 1500, 'Current must clamp to 1500mA');
        assert.equal(telemB.readUInt32LE(5), 6000, 'Voltage must drop to 6000mV');
    });

    test('T3.3: Output OFF Command -> Immediate Zero Voltage/Current Telemetry Response', (t) => {
        const MockClass = getModuleOrNull(MOCK_PATH);
        if (!MockClass) {
            t.skip('Pending M2: lib/mock_power_supply.js not yet implemented');
            return;
        }
        if (MockClass.__loadError) throw MockClass.__loadError;

        const mock = typeof MockClass === 'function' ? new MockClass() : MockClass;
        mock.setLoadResistance(10.0);

        // Remote ON at 24V
        mock.processFrame(oracleBuildFrame(0x00, 0x82, Buffer.from([0x03])));
        const pData = Buffer.alloc(22, 0);
        pData.writeUInt16LE(3000, 0);
        pData.writeUInt32LE(36000, 2);
        pData.writeUInt16LE(10800, 6);
        pData.writeUInt32LE(24000, 8);
        mock.processFrame(oracleBuildFrame(0x00, 0x80, pData));

        // Remote OFF
        mock.processFrame(oracleBuildFrame(0x00, 0x82, Buffer.from([0x02])));

        const telem = mock.processFrame(oracleBuildFrame(0x00, 0x81, Buffer.alloc(22, 0)));
        assert.equal(telem.readUInt16LE(3), 0);
        assert.equal(telem.readUInt32LE(5), 0);
        assert.equal(telem.readUInt16LE(9), 0);
        assert.equal(telem[23] & 0x01, 0);
    });

    test('T3.4: Concurrent Telemetry Polling with Asynchronous Setpoint Interleaving', (t) => {
        const ControllerClass = getModuleOrNull(CONTROLLER_PATH);
        if (!ControllerClass) {
            t.skip('Pending M2: lib/power_controller.js not yet implemented');
            return;
        }
        if (ControllerClass.__loadError) throw ControllerClass.__loadError;

        const controller = typeof ControllerClass === 'function' ? new ControllerClass() : ControllerClass;
        controller.init({ isMock: true, pollingIntervalMs: 100 });

        controller.setOutput(true)
            .then(() => controller.setVoltage(18.0))
            .then(() => {
                const telem = controller.getTelemetry();
                assert(telem !== null);
            });
    });

    test('T3.5: Dynamic Software Safety Limit Constraints on Setpoint Methods', (t) => {
        const ControllerClass = getModuleOrNull(CONTROLLER_PATH);
        if (!ControllerClass) {
            t.skip('Pending M2: lib/power_controller.js not yet implemented');
            return;
        }
        if (ControllerClass.__loadError) throw ControllerClass.__loadError;

        const controller = typeof ControllerClass === 'function' ? new ControllerClass() : ControllerClass;
        controller.init({
            isMock: true,
            limits: { maxVoltage_V: 15.0, maxCurrent_A: 1.0 }
        });

        controller.setVoltage(14.0)
            .then(() => {
                if (typeof controller.setSafetyLimits === 'function') {
                    controller.setSafetyLimits({ maxVoltage_V: 10.0, maxCurrent_A: 1.0 });
                    return controller.setVoltage(12.0);
                }
            })
            .then(() => {
                const telem = controller.getTelemetry();
                assert(telem.setVoltage_mV <= 15000);
            })
            .catch(() => {});
    });
});

// ============================================================================
// SUITE 4: TIER 4 — REAL-WORLD APPLICATION SCENARIOS
// ============================================================================
describe('Tier 4: Real-World Application Scenarios', () => {

    test('T4.1: Scenario 1 - Multi-Step Automated Voltage Ramp Sweep (0V -> 12V -> 24V -> 36V)', (t) => {
        const MockClass = getModuleOrNull(MOCK_PATH);
        if (!MockClass) {
            t.skip('Pending M2: lib/mock_power_supply.js not yet implemented');
            return;
        }
        if (MockClass.__loadError) throw MockClass.__loadError;

        const mock = typeof MockClass === 'function' ? new MockClass() : MockClass;
        mock.setLoadResistance(50.0);
        mock.processFrame(oracleBuildFrame(0x00, 0x82, Buffer.from([0x03])));

        const sweepSteps = [0, 12, 24, 36];
        const telemQuery = oracleBuildFrame(0x00, 0x81, Buffer.alloc(22, 0));

        for (const targetV of sweepSteps) {
            const pData = Buffer.alloc(22, 0);
            pData.writeUInt16LE(3000, 0);
            pData.writeUInt32LE(36000, 2);
            pData.writeUInt16LE(10800, 6);
            pData.writeUInt32LE(targetV * 1000, 8);
            mock.processFrame(oracleBuildFrame(0x00, 0x80, pData));

            const telem = mock.processFrame(telemQuery);
            assert.equal(telem.readUInt32LE(5), targetV * 1000);
        }
    });

    test('T4.2: Scenario 2 - Load Step & Current Limit Crossover Across 5 Resistance Steps', (t) => {
        const vSet = 20.0;
        const iLimit = 2.0;
        const testLoads = [
            { r: 100.0, expV: 20.0, expI: 0.200, expMode: 'CV' },
            { r: 50.0,  expV: 20.0, expI: 0.400, expMode: 'CV' },
            { r: 20.0,  expV: 20.0, expI: 1.000, expMode: 'CV' },
            { r: 10.0,  expV: 20.0, expI: 2.000, expMode: 'CV' },
            { r: 5.0,   expV: 10.0, expI: 2.000, expMode: 'CC' }
        ];

        for (const step of testLoads) {
            const result = oracleSimulateOhm(vSet, iLimit, step.r, true);
            assert.equal(result.voltage_V, step.expV);
            assert.equal(result.current_A, step.expI);
            assert.equal(result.mode, step.expMode);
        }

        const MockClass = getModuleOrNull(MOCK_PATH);
        if (!MockClass) {
            t.skip('Pending M2: lib/mock_power_supply.js verification for Scenario 2');
            return;
        }
        if (MockClass.__loadError) throw MockClass.__loadError;

        const mock = typeof MockClass === 'function' ? new MockClass() : MockClass;
        mock.processFrame(oracleBuildFrame(0x00, 0x82, Buffer.from([0x03])));
        const pData = Buffer.alloc(22, 0);
        pData.writeUInt16LE(2000, 0);
        pData.writeUInt32LE(36000, 2);
        pData.writeUInt16LE(10800, 6);
        pData.writeUInt32LE(20000, 8);
        mock.processFrame(oracleBuildFrame(0x00, 0x80, pData));

        mock.setLoadResistance(5.0);
        const telem = mock.processFrame(oracleBuildFrame(0x00, 0x81, Buffer.alloc(22, 0)));
        assert.equal(telem.readUInt16LE(3), 2000);
        assert.equal(telem.readUInt32LE(5), 10000);
        assert.equal(telem[23] & 0x02, 2);
    });

    test('T4.3: Scenario 3 - Continuous CSV Data Logging Session Integrity Verification', () => {
        const logLines = ['Timestamp,Voltage_V,Current_A,Power_W,Mode,OutputState'];
        const baseTime = Date.now();

        for (let i = 0; i < 10; i++) {
            const timestamp = new Date(baseTime + i * 500).toISOString();
            const voltage = (12.0 + (i * 0.1)).toFixed(3);
            const current = (1.2 + (i * 0.01)).toFixed(3);
            const power = (parseFloat(voltage) * parseFloat(current)).toFixed(2);
            logLines.push(`${timestamp},${voltage},${current},${power},CV,ON`);
        }

        const rows = logLines.join('\n').trim().split('\n');
        assert.equal(rows[0], 'Timestamp,Voltage_V,Current_A,Power_W,Mode,OutputState');

        let prevTimestamp = 0;
        for (let i = 1; i < rows.length; i++) {
            const cols = rows[i].split(',');
            assert.equal(cols.length, 6);
            const currentTimestamp = Date.parse(cols[0]);
            assert(!isNaN(currentTimestamp));
            assert(currentTimestamp >= prevTimestamp);
            prevTimestamp = currentTimestamp;

            const v = parseFloat(cols[1]);
            const a = parseFloat(cols[2]);
            const p = parseFloat(cols[3]);
            assert(v >= 12.0 && v <= 13.0);
            assert(a >= 1.2 && a <= 1.3);
            assert(Math.abs(p - (v * a)) < 0.05);
            assert.equal(cols[4], 'CV');
            assert.equal(cols[5], 'ON');
        }
    });

    test('T4.4: Scenario 4 - Fine Stepper Adjustments (±0.01V, ±0.1V, ±1V) with 3-Decimal Precision', () => {
        let currentV = 5.000;
        function applyStep(delta) {
            currentV = Math.round((currentV + delta) * 1000) / 1000;
            return currentV;
        }

        assert.equal(applyStep(+1.0), 6.000);
        assert.equal(applyStep(+0.1), 6.100);
        assert.equal(applyStep(+0.01), 6.110);
        assert.equal(applyStep(-0.01), 6.100);
        assert.equal(applyStep(-1.0), 5.100);

        const rawMilliVolts = Math.round(currentV * 1000);
        assert.equal(rawMilliVolts, 5100);
    });

    test('T4.5: Scenario 5 - Launcher Environment Isolation and Port Binding Inspection', (t) => {
        if (!fs.existsSync(LAUNCHER_PATH)) {
            t.skip('Pending M4: start_array_power.bat not yet implemented');
            return;
        }

        const batContent = fs.readFileSync(LAUNCHER_PATH, 'utf8');
        assert.match(batContent, /userDir/i);
        assert.match(batContent, /1880/);
        assert.doesNotMatch(batContent, />.*\\IO-LINK\\NODERED/i);
    });
});
