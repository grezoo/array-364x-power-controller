/**
 * test/adversarial_m2_challenge.js
 *
 * Empirical Adversarial Challenge Suite for Milestone 2:
 * 1. Noise Rejection: Candidate frames with matching checksum but mismatched command codes or payload lengths.
 * 2. Transport Switching: Runtime toggling (setMockMode(true) <-> setMockMode(false)) under active polling.
 * 3. Software Safety Limits: Boundary values (just inside, exactly at, just outside) across voltage and current.
 *
 * Executed via portable Node.js test runner:
 *   & "D:\programok_kiírni\IO-LINK\NODERED\node.exe" --test test/adversarial_m2_challenge.js
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const PowerController = require('../lib/power_controller');
const MockPowerSupply = require('../lib/mock_power_supply');
const protocol = require('../lib/array_protocol');

const {
  COMMANDS,
  RESPONSE_CODES,
  STATUS_BITS,
  buildFrame,
  calculateChecksum,
  verifyChecksum,
  parseFrame,
  extractFrames,
  FrameChunkAssembler,
  encodeTelemetry,
  encodeResponse
} = protocol;

describe('Adversarial Challenge Suite: Milestone 2', () => {

  // ==========================================================================
  // SECTION 1: Noise Rejection & Corrupted Frame Injection
  // ==========================================================================
  describe('Section 1: Noise Rejection & Corrupted Frame Injection', () => {

    test('1.1: Frame with valid checksum but mismatched command code is rejected during setpoint tx', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      let setVoltageDone = false;
      const txPromise = controller.setVoltage(15.0).then(() => {
        setVoltageDone = true;
      });

      // The in-flight transaction expects COMMANDS.RESPONSE_CHECK (0x12)
      assert(controller.inFlight !== null, 'Transaction must be in flight');
      assert.equal(controller.inFlight.expectedCmd, COMMANDS.RESPONSE_CHECK);

      // Inject candidate frames with valid checksums but wrong command codes:
      // A) 0x81 (Telemetry)
      const fakeTelemFrame = encodeTelemetry(0x00, { voltage_mV: 12000, current_mA: 1000 });
      assert(verifyChecksum(fakeTelemFrame), 'Candidate frame has valid checksum');
      assert.equal(fakeTelemFrame[2], COMMANDS.READ_TELEMETRY);
      controller._handleIncomingFrame(fakeTelemFrame);
      assert.equal(setVoltageDone, false, 'Candidate frame with cmd 0x81 must not resolve 0x12 tx');
      assert(controller.inFlight !== null, 'In-flight tx must remain active');

      // B) 0x80 (Set Parameters echo)
      const fakeSetFrame = protocol.encodeSetParameters(0x00, { setVoltage_V: 10.0 });
      assert(verifyChecksum(fakeSetFrame));
      controller._handleIncomingFrame(fakeSetFrame);
      assert.equal(setVoltageDone, false, 'Candidate frame with cmd 0x80 must not resolve 0x12 tx');

      // C) 0x8C (Model Info)
      const fakeModelFrame = protocol.encodeModelResponse(0x00, { model: '3645A' });
      assert(verifyChecksum(fakeModelFrame));
      controller._handleIncomingFrame(fakeModelFrame);
      assert.equal(setVoltageDone, false, 'Candidate frame with cmd 0x8C must not resolve 0x12 tx');

      // D) Arbitrary command 0xEE with valid checksum
      const arbitraryCmdFrame = buildFrame(0x00, 0xEE, Buffer.alloc(22, 0x55));
      assert(verifyChecksum(arbitraryCmdFrame));
      controller._handleIncomingFrame(arbitraryCmdFrame);
      assert.equal(setVoltageDone, false, 'Arbitrary candidate frame must not resolve 0x12 tx');

      // Now inject the genuine ACK frame (0x12)
      const legitimateAck = encodeResponse(0x00, true, RESPONSE_CODES.OK);
      controller._handleIncomingFrame(legitimateAck);

      await txPromise;
      assert.equal(setVoltageDone, true, 'Legitimate 0x12 frame successfully resolved transaction');
      await controller.close();
    });

    test('1.2: Frame with valid checksum but mismatched command code is rejected during telemetry query tx', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      // Start telemetry poll transaction expecting COMMANDS.READ_TELEMETRY (0x81)
      let pollResult = null;
      const pollPromise = controller._enqueueTransaction({
        priority: 2,
        expectedCmd: COMMANDS.READ_TELEMETRY,
        address: 0x00,
        frame: protocol.encodeTelemetryQuery(0x00),
        timeoutMs: 1000,
        retries: 0
      }).then((res) => { pollResult = res; });

      assert(controller.inFlight !== null);
      assert.equal(controller.inFlight.expectedCmd, COMMANDS.READ_TELEMETRY);

      // Inject ACK frame (0x12) with valid checksum
      const ackFrame = encodeResponse(0x00, true, RESPONSE_CODES.OK);
      controller._handleIncomingFrame(ackFrame);
      assert.equal(pollResult, null, 'ACK frame must not resolve telemetry query');
      assert(controller.inFlight !== null, 'In-flight query must remain waiting for 0x81');

      // Inject genuine telemetry frame (0x81)
      const validTelem = encodeTelemetry(0x00, { voltage_mV: 24000, current_mA: 1500 });
      controller._handleIncomingFrame(validTelem);

      await pollPromise;
      assert(pollResult !== null, 'Genuine telemetry frame resolved query');
      assert.equal(pollResult.voltage_mV, 24000);
      assert.equal(pollResult.current_mA, 1500);

      await controller.close();
    });

    test('1.3: Candidate frames with mismatched payload lengths are rejected by parseFrame and controller', () => {
      const testLengths = [0, 1, 3, 10, 22, 24, 25, 27, 30, 52];

      for (const len of testLengths) {
        const buf = Buffer.alloc(len, 0xAA);
        if (len > 0) {
          buf[0] = 0xAA;
          if (len > 1) buf[1] = 0x00;
          if (len > 2) buf[2] = 0x12;
          if (len >= 4) {
            // Calculate a matching checksum on whatever buffer exists
            let sum = 0;
            for (let i = 0; i < len - 1; i++) sum = (sum + buf[i]) & 0xFF;
            buf[len - 1] = sum;
          }
        }

        // Must fail parseFrame
        const parsed = parseFrame(buf);
        assert.equal(parsed.valid, false, `Frame of length ${len} must be marked invalid`);
        assert.match(parsed.error, /invalid frame length/i);

        // Controller must reject without throw
        const controller = new PowerController();
        controller.init({ isMock: true });
        assert.doesNotThrow(() => {
          controller._handleIncomingFrame(buf);
        });
      }
    });

    test('1.4: 1/256 modulo-256 random noise frames with accidental checksum match are rejected', async () => {
      const controller = new PowerController({ address: 0x01 });
      controller.init({ isMock: true, address: 0x01 });

      let resolved = false;
      const txPromise = controller.setVoltage(10.0).then(() => { resolved = true; });

      // Generate 200 random 26-byte buffers, artificially forcing valid checksum
      let collisionTested = 0;
      for (let i = 0; i < 200; i++) {
        const noise = Buffer.alloc(26);
        noise[0] = 0xAA; // matching header
        noise[1] = (i % 5 === 0) ? 0x01 : 0x02; // sometimes matching address, sometimes not
        noise[2] = (i % 256); // arbitrary command byte
        if (noise[2] === COMMANDS.RESPONSE_CHECK && noise[1] === 0x01) {
          continue; // skip legitimate response
        }
        for (let j = 3; j < 25; j++) {
          noise[j] = (Math.random() * 256) & 0xFF;
        }
        // Force matching checksum
        noise[25] = calculateChecksum(noise);
        assert(verifyChecksum(noise));

        controller._handleIncomingFrame(noise);
        assert.equal(resolved, false, `Colliding noise frame (cmd 0x${noise[2].toString(16)}, addr 0x${noise[1].toString(16)}) must be rejected`);
        collisionTested++;
      }

      assert(collisionTested > 150);
      assert(controller.inFlight !== null, 'In-flight transaction must still be awaiting legitimate response');

      // Deliver genuine response
      controller._handleIncomingFrame(encodeResponse(0x01, true, RESPONSE_CODES.OK));
      await txPromise;
      assert.equal(resolved, true);

      await controller.close();
    });

    test('1.5: Stream-level noise and fragmented chunks rejected by FrameChunkAssembler', () => {
      const assembler = new FrameChunkAssembler();

      // Chunk with random noise followed by incomplete frame
      const noise = Buffer.from([0x01, 0x02, 0x55, 0x77, 0xAA, 0x00, 0x12, 0x80]);
      const frames1 = assembler.push(noise);
      assert.equal(frames1.length, 0, 'Incomplete frame must produce 0 frames');

      // Append remaining 22 bytes with valid checksum
      const rest = Buffer.alloc(22, 0);
      const full = Buffer.concat([Buffer.from([0xAA, 0x00, 0x12, 0x80]), rest]);
      full[25] = calculateChecksum(full);

      const frames2 = assembler.push(full.subarray(4));
      assert.equal(frames2.length, 1, 'Completed frame must be extracted');
      assert.equal(frames2[0].length, 26);
      assert.equal(frames2[0][2], 0x12);
    });
  });

  // ==========================================================================
  // SECTION 2: Transport Switching & Polling Loop Stress
  // ==========================================================================
  describe('Section 2: Runtime Transport Toggling & Active Polling Loop', () => {

    test('2.1: EMPIRICAL HARNESS: SerialTransport.write unhandled rejection detection', async () => {
      const controller = new PowerController({ isMock: false });

      const unhandledRejections = [];
      const onUnhandled = (reason) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      try {
        // Enqueue transaction while SerialTransport is not open
        controller.setOutput(true).catch(() => {});

        // Yield execution turn to capture promise reactions
        await new Promise((r) => setTimeout(r, 40));

        // CHALLENGE CRITERIA: Verify ZERO unhandled rejections
        // This assertion checks the requirement of zero unhandled rejections.
        // It fails if unhandled rejections occurred!
        assert.equal(
          unhandledRejections.length,
          0,
          `VIOLATION: ${unhandledRejections.length} unhandledRejection(s) detected when writing to closed SerialTransport: ${unhandledRejections.map(e => e.message).join(', ')}`
        );
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        await controller.close();
      }
    });

    test('2.2: EMPIRICAL HARNESS: Active polling loop toggling (setMockMode(true) <-> setMockMode(false))', async () => {
      const controller = new PowerController({ isMock: true, pollingIntervalMs: 20, timeoutMs: 50 });

      const unhandledRejections = [];
      const onUnhandled = (reason) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      controller.startPolling(20);

      try {
        for (let i = 0; i < 5; i++) {
          controller.setMockMode(false);
          await new Promise((r) => setTimeout(r, 30));
          controller.setMockMode(true);
          await new Promise((r) => setTimeout(r, 30));
        }

        // CHALLENGE CRITERIA: Zero unhandled rejections during runtime toggling under active polling
        assert.equal(
          unhandledRejections.length,
          0,
          `VIOLATION: ${unhandledRejections.length} unhandledRejection(s) emitted during runtime toggling under polling loop: ${unhandledRejections.map(e => e.message).join(', ')}`
        );
      } finally {
        controller.stopPolling();
        process.removeListener('unhandledRejection', onUnhandled);
        await controller.close();
      }
    });

    test('2.3: Memory leak & event listener tracking across 100 transport toggles', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      const initialMockFrameListeners = controller.mockTransport.listenerCount('frame');
      const initialMockErrorListeners = controller.mockTransport.listenerCount('error');
      const initialSerialFrameListeners = controller.serialTransport.listenerCount('frame');
      const initialSerialErrorListeners = controller.serialTransport.listenerCount('error');

      for (let i = 0; i < 100; i++) {
        controller.setMockMode(i % 2 === 0);
      }

      // Verify listeners have NOT leaked / accumulated on transports
      assert.equal(controller.mockTransport.listenerCount('frame'), initialMockFrameListeners,
        'mockTransport frame listeners must not leak');
      assert.equal(controller.mockTransport.listenerCount('error'), initialMockErrorListeners,
        'mockTransport error listeners must not leak');
      assert.equal(controller.serialTransport.listenerCount('frame'), initialSerialFrameListeners,
        'serialTransport frame listeners must not leak');
      assert.equal(controller.serialTransport.listenerCount('error'), initialSerialErrorListeners,
        'serialTransport error listeners must not leak');

      await controller.close();
    });
  });

  // ==========================================================================
  // SECTION 3: Software Safety Limits Boundary Testing
  // ==========================================================================
  describe('Section 3: Software Safety Limits Boundary Testing', () => {

    test('3.1: Voltage boundary tests (just inside, exactly at, just outside)', async () => {
      const controller = new PowerController();
      controller.init({
        isMock: true,
        limits: { maxVoltage_V: 24.0, maxCurrent_A: 2.0 }
      });

      // 1. Just inside: 23.999V -> PASS
      const rInside = await controller.setVoltage(23.999);
      assert.equal(rInside, true);
      assert.equal(controller.getTelemetry().setVoltage_V, 23.999);

      // 2. Exactly at: 24.000V -> PASS
      const rExact = await controller.setVoltage(24.0);
      assert.equal(rExact, true);
      assert.equal(controller.getTelemetry().setVoltage_V, 24.0);

      // 3. Just outside: 24.001V -> REJECT
      await assert.rejects(
        () => controller.setVoltage(24.001),
        (err) => {
          assert(err instanceof RangeError);
          assert.match(err.message, /exceeds software safety limit 24/i);
          return true;
        }
      );
      assert.equal(controller.getTelemetry().setVoltage_V, 24.0);

      // 4. Large overshoot: 100.0V -> REJECT
      await assert.rejects(
        () => controller.setVoltage(100.0),
        RangeError
      );

      // 5. Zero boundary: exactly 0.0V -> PASS
      const rZero = await controller.setVoltage(0.0);
      assert.equal(rZero, true);
      assert.equal(controller.getTelemetry().setVoltage_V, 0.0);

      // 6. Just below zero: -0.001V -> REJECT
      await assert.rejects(
        () => controller.setVoltage(-0.001),
        (err) => {
          assert(err instanceof RangeError);
          assert.match(err.message, /invalid voltage/i);
          return true;
        }
      );

      await controller.close();
    });

    test('3.2: Current boundary tests (just inside, exactly at, just outside)', async () => {
      const controller = new PowerController();
      controller.init({
        isMock: true,
        limits: { maxVoltage_V: 30.0, maxCurrent_A: 2.5 }
      });

      // 1. Just inside: 2.499A -> PASS
      const rInside = await controller.setCurrentLimit(2.499);
      assert.equal(rInside, true);
      assert.equal(controller.getTelemetry().maxCurrent_A, 2.499);

      // 2. Exactly at: 2.500A -> PASS
      const rExact = await controller.setCurrentLimit(2.5);
      assert.equal(rExact, true);
      assert.equal(controller.getTelemetry().maxCurrent_A, 2.5);

      // 3. Just outside: 2.501A -> REJECT
      await assert.rejects(
        () => controller.setCurrentLimit(2.501),
        (err) => {
          assert(err instanceof RangeError);
          assert.match(err.message, /exceeds software safety limit 2.5/i);
          return true;
        }
      );
      assert.equal(controller.getTelemetry().maxCurrent_A, 2.5);

      // 4. Large overshoot: 10.0A -> REJECT
      await assert.rejects(
        () => controller.setCurrentLimit(10.0),
        RangeError
      );

      // 5. Zero boundary: 0.0A -> PASS
      const rZero = await controller.setCurrentLimit(0.0);
      assert.equal(rZero, true);
      assert.equal(controller.getTelemetry().maxCurrent_A, 0.0);

      // 6. Just below zero: -0.001A -> REJECT
      await assert.rejects(
        () => controller.setCurrentLimit(-0.001),
        RangeError
      );

      await controller.close();
    });

    test('3.3: Invalid / non-finite type inputs rejected with RangeError', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      for (const invalidVal of [NaN, Infinity, -Infinity, 'abc']) {
        await assert.rejects(
          () => controller.setVoltage(invalidVal),
          RangeError,
          `Expected RangeError for invalid voltage: ${invalidVal}`
        );
        await assert.rejects(
          () => controller.setCurrentLimit(invalidVal),
          RangeError,
          `Expected RangeError for invalid current: ${invalidVal}`
        );
      }

      await controller.close();
    });

    test('3.4: Dynamic safety limit reconfiguration under active setpoints', async () => {
      const controller = new PowerController();
      controller.init({
        isMock: true,
        limits: { maxVoltage_V: 32.0, maxCurrent_A: 3.0 }
      });

      // Set initial voltage to 28.0V (within initial 32.0V limit)
      await controller.setVoltage(28.0);
      assert.equal(controller.getTelemetry().setVoltage_V, 28.0);

      // Lower safety limit dynamically to 18.0V
      controller.setSafetyLimits({ maxVoltage_V: 18.0 });
      assert.equal(controller.safetyLimits.maxVoltage_V, 18.0);

      // New setpoint exceeding new limit (20.0V) must now be rejected
      await assert.rejects(
        () => controller.setVoltage(20.0),
        RangeError
      );

      // Setpoint within new limit (18.0V) must pass
      await controller.setVoltage(18.0);
      assert.equal(controller.getTelemetry().setVoltage_V, 18.0);

      // Setpoint just inside (17.999V) must pass
      await controller.setVoltage(17.999);
      assert.equal(controller.getTelemetry().setVoltage_V, 17.999);

      await controller.close();
    });
  });
});
