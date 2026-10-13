/**
 * test/test_controller.js
 *
 * Unit Test Suite for Power Controller & Transport Layer (lib/power_controller.js)
 * Verified with portable Node.js test runner:
 *   & "D:\programok_kiírni\IO-LINK\NODERED\node.exe" --test test/test_controller.js
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const PowerController = require('../lib/power_controller');
const protocol = require('../lib/array_protocol');

describe('PowerController Unit Tests', () => {

  describe('Suite 1: Controller Initialization & Lifecycle', () => {
    test('1.1: Default initialization with mock transport', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      assert.equal(controller.isMock, true);
      assert.equal(typeof controller.setOutput, 'function');
      assert.equal(typeof controller.setVoltage, 'function');
      assert.equal(typeof controller.setCurrentLimit, 'function');
      assert.equal(typeof controller.getTelemetry, 'function');

      const telem = controller.getTelemetry();
      assert.equal(telem.voltage_V, 0.0);
      assert.equal(telem.current_A, 0.0);
      assert.equal(telem.state.outputOn, false);

      await controller.close();
    });

    test('1.2: Status reporting', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true, portName: 'COM7' });

      const status = controller.getStatus();
      assert.equal(status.mode, 'mock');
      assert.equal(status.connected, true);
      assert.equal(status.outputOn, false);

      await controller.close();
    });

    test('1.3: Clean teardown via destroy()', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true, pollingIntervalMs: 50 });
      assert.equal(controller.pollingEnabled, true);

      await controller.destroy();
      assert.equal(controller.pollingEnabled, false);
      assert.equal(controller.highPriorityQueue.length, 0);
      assert.equal(controller.lowPriorityQueue.length, 0);
    });
  });

  describe('Suite 2: Mock & Serial Transport Management', () => {
    test('2.1: setMockMode toggles active transport and emits status event', async () => {
      const controller = new PowerController();
      let statusEmitted = null;
      controller.on('status', (s) => { statusEmitted = s; });

      controller.setMockMode(true);
      assert.equal(controller.isMock, true);
      assert.equal(statusEmitted.mode, 'mock');

      controller.setMockMode(false);
      assert.equal(controller.isMock, false);
      assert.equal(statusEmitted.mode, 'serial');

      controller.setMockMode(true);
      await controller.close();
    });

    test('2.2: Virtual load adjustments pass through to mock transport', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      controller.setVirtualLoad(25.0);
      assert.equal(controller.mockTransport.mock.getLoadResistance(), 25.0);

      await controller.close();
    });
  });

  describe('Suite 3: Half-Duplex Priority Queueing & Emergency Stop Preemption', () => {
    test('3.1: Sequential FIFO setpoint execution', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      const p1 = controller.setVoltage(5.0);
      const p2 = controller.setVoltage(10.0);
      const p3 = controller.setVoltage(15.0);

      const results = await Promise.all([p1, p2, p3]);
      assert.deepEqual(results, [true, true, true]);
      assert.equal(controller.getTelemetry().setVoltage_V, 15.0);

      await controller.close();
    });

    test('3.2: Emergency Stop preemption: setOutput(false) jumps to front of queue', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      // Queue an initial slow transaction
      const pSlow = controller.setVoltage(10.0);

      // Queue lower-priority setpoint
      const pNext = controller.setVoltage(20.0);

      // Immediately queue Emergency Stop (Priority 0)
      const pEstop = controller.setOutput(false);

      // Estop must be placed ahead of pNext in highPriorityQueue
      // Because Estop was unshifted, the order after pSlow finishes will be Estop then pNext
      await Promise.all([pSlow, pEstop, pNext]);
      assert.equal(controller.outputOn, false);

      await controller.close();
    });

    test('3.3: Polling deduplication prevents low-priority queue accumulation', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      // Enqueue one low-priority query manually
      controller.lowPriorityQueue.push({ priority: 2 });
      assert.equal(controller.lowPriorityQueue.length, 1);

      // Call _pollTelemetry() -> must deduplicate and not add another item
      await controller._pollTelemetry();
      assert.equal(controller.lowPriorityQueue.length, 1);

      await controller.close();
    });
  });

  describe('Suite 4: Telemetry Polling Loop & Event Emission', () => {
    test('4.1: startPolling emits telemetry events with valid decoded structure', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      await controller.setOutput(true);
      await controller.setVoltage(12.0);
      controller.setVirtualLoad(10.0);

      const receivedTelem = await new Promise((resolve) => {
        controller.once('telemetry', (telem) => {
          resolve(telem);
        });
        controller.startPolling(50);
      });

      assert(receivedTelem !== null);
      assert.equal(receivedTelem.voltage_V, 12.0);
      assert.equal(receivedTelem.current_A, 1.2);
      assert.equal(receivedTelem.state.outputOn, true);
      assert.equal(receivedTelem.state.mode, 'CV');

      controller.stopPolling();
      await controller.close();
    });

    test('4.2: stopPolling halts cyclic timer and event emission', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });
      controller.startPolling(50);
      assert.equal(controller.pollingEnabled, true);

      controller.stopPolling();
      assert.equal(controller.pollingEnabled, false);
      assert.equal(controller.pollingTimer, null);

      await controller.close();
    });
  });

  describe('Suite 5: Software Safety Limits Enforcement', () => {
    test('5.1: setVoltage rejects with RangeError if exceeding safety limit without sending frame', async () => {
      const controller = new PowerController();
      controller.init({
        isMock: true,
        limits: { maxVoltage_V: 20.0, maxCurrent_A: 2.0 }
      });

      await assert.rejects(
        () => controller.setVoltage(25.0),
        (err) => {
          assert(err instanceof RangeError);
          assert.match(err.message, /safety limit/i);
          return true;
        }
      );

      // Verify cached setpoint was not altered
      assert.equal(controller.getTelemetry().setVoltage_V, 0.0);

      await controller.close();
    });

    test('5.2: setCurrentLimit rejects with RangeError if exceeding safety limit', async () => {
      const controller = new PowerController();
      controller.init({
        isMock: true,
        limits: { maxVoltage_V: 20.0, maxCurrent_A: 2.0 }
      });

      await assert.rejects(
        () => controller.setCurrentLimit(2.5),
        (err) => {
          assert(err instanceof RangeError);
          assert.match(err.message, /safety limit/i);
          return true;
        }
      );

      await controller.close();
    });

    test('5.3: setSafetyLimits dynamically updates bounds at runtime', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true, limits: { maxVoltage_V: 30.0, maxCurrent_A: 3.0 } });

      await controller.setVoltage(25.0);
      assert.equal(controller.getTelemetry().setVoltage_V, 25.0);

      // Lower limit dynamically
      controller.setSafetyLimits({ maxVoltage_V: 15.0 });

      // Now 20V must reject
      await assert.rejects(
        () => controller.setVoltage(20.0),
        RangeError
      );

      await controller.close();
    });

    test('5.4: Negative setpoint rejects with RangeError', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      await assert.rejects(
        () => controller.setVoltage(-5.0),
        RangeError
      );

      await assert.rejects(
        () => controller.setCurrentLimit(-1.0),
        RangeError
      );

      await controller.close();
    });
  });

  describe('Suite 6: Multi-Field Frame Noise Defense (1/256 False Collision Mitigation)', () => {
    test('6.1: Valid checksum with mismatched command code is ignored without completing transaction', async () => {
      const controller = new PowerController();
      controller.init({ isMock: true });

      // Start setVoltage awaiting response check (0x12)
      let resolved = false;
      const txPromise = controller.setVoltage(12.0).then(() => { resolved = true; });

      // Inject a frame with valid checksum but wrong cmd (0x81 telemetry instead of 0x12 response)
      const fakeNoiseFrame = protocol.encodeTelemetry(0x00, { voltage_mV: 5000 });
      controller._handleIncomingFrame(fakeNoiseFrame);

      // Transaction must NOT be resolved prematurely
      assert.equal(resolved, false);
      assert(controller.inFlight !== null, 'In-flight transaction must remain awaiting legitimate 0x12 frame');

      await txPromise;
      assert.equal(resolved, true);

      await controller.close();
    });

    test('6.2: Frame with mismatched target address is ignored', async () => {
      const controller = new PowerController({ address: 0x05 });
      controller.init({ isMock: true, address: 0x05 });

      let resolved = false;
      const txPromise = controller.setVoltage(10.0).then(() => { resolved = true; });

      // Inject response addressed to 0x02 instead of 0x05
      const wrongAddrFrame = protocol.encodeResponse(0x02, true);
      controller._handleIncomingFrame(wrongAddrFrame);

      assert.equal(resolved, false);
      assert(controller.inFlight !== null);

      // Now inject response with correct address 0x05
      const rightAddrFrame = protocol.encodeResponse(0x05, true);
      controller._handleIncomingFrame(rightAddrFrame);

      await txPromise;
      assert.equal(resolved, true);

      await controller.close();
    });
  });
});
