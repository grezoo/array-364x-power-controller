/**
 * test/stress_m2_empirical.js
 *
 * Empirical Adversarial Stress & Verification Harness for Milestone 2:
 * - lib/mock_power_supply.js (Virtual Power Supply Simulator)
 * - lib/power_controller.js (Controller & Transport Layer)
 *
 * Runs via portable Node.js:
 *   & "D:\programok_kiírni\IO-LINK\NODERED\node.exe" test/stress_m2_empirical.js
 */

'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const protocol = require('../lib/array_protocol');
const MockPowerSupply = require('../lib/mock_power_supply');
const PowerController = require('../lib/power_controller');

// Metrics collector
const metrics = {
  ohmSweep: { points: 0, passed: 0, failed: 0, maxErrorV_mV: 0, maxErrorI_mA: 0 },
  boundaryCrossover: { points: 0, passed: 0, failed: 0, transitions: 0 },
  squareWaveJitter: { cycles: 0, passed: 0, failed: 0 },
  pathologicalLoads: { tests: 0, passed: 0, failed: 0 },
  concurrentSetpoints: { total: 0, passed: 0, failed: 0, elapsedMs: 0, opsPerSec: 0, inversions: 0 },
  emergencyPreemption: { tested: false, pendingAtInject: 0, executedBeforeEStop: 0, eStopLatencyMs: 0, passed: false },
  noiseDefense: { tested: false, collisionsBlocked: 0, passed: false },
  slewRate: { steps: 0, passed: 0, monotonic: true }
};

console.log('================================================================');
console.log('STARTING EMPIRICAL STRESS HARNESS: MILESTONE 2 (Mock & Controller)');
console.log('================================================================\n');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// SECTION 1: Ohm's Law Stability & CV <-> CC Mode Transitions
// ============================================================================
console.log('--- [SECTION 1] Ohm\'s Law Stability & Mode Crossover Testing ---');

function runOhmLawStress() {
  const mock = new MockPowerSupply({
    model: '3645A',
    outputOn: true,
    remoteMode: true
  });

  const V_SET_V = 12.0;
  const I_LIMIT_A = 2.0;
  const P_LIMIT_W = 108.0;

  mock.setVoltage(V_SET_V);
  mock.setCurrentLimit(I_LIMIT_A);

  const R_CRIT = V_SET_V / I_LIMIT_A; // 6.000 Ohms

  console.log(`Setting: V_set = ${V_SET_V}V, I_limit = ${I_LIMIT_A}A -> R_crossover = ${R_CRIT} Ohm`);

  // 1A: 10,000-Point Logarithmic Load Sweep (0.01 Ohm to 100,000 Ohm)
  const SWEEP_POINTS = 10000;
  const minLog = Math.log10(0.01);
  const maxLog = Math.log10(100000.0);
  const stepLog = (maxLog - minLog) / (SWEEP_POINTS - 1);

  const tStart = performance.now();

  for (let i = 0; i < SWEEP_POINTS; i++) {
    const rLoad = Math.pow(10, minLog + i * stepLog);
    mock.setLoadResistance(rLoad);

    const telem = mock.getTelemetry();
    metrics.ohmSweep.points++;

    const expectedMode = rLoad < R_CRIT ? 'CC' : 'CV';
    let expectedV_mV, expectedI_mA;

    if (expectedMode === 'CC') {
      expectedI_mA = Math.round(I_LIMIT_A * 1000);
      expectedV_mV = Math.min(Math.round(V_SET_V * 1000), Math.round(I_LIMIT_A * rLoad * 1000));
    } else {
      expectedV_mV = Math.round(V_SET_V * 1000);
      expectedI_mA = Math.min(Math.round(I_LIMIT_A * 1000), Math.round((V_SET_V / rLoad) * 1000));
    }

    const errV = Math.abs(telem.voltage_mV - expectedV_mV);
    const errI = Math.abs(telem.current_mA - expectedI_mA);

    if (errV > metrics.ohmSweep.maxErrorV_mV) metrics.ohmSweep.maxErrorV_mV = errV;
    if (errI > metrics.ohmSweep.maxErrorI_mA) metrics.ohmSweep.maxErrorI_mA = errI;

    // Tolerance: integer mV/mA rounding gives max error <= 1 unit
    const modeOk = telem.state.mode === expectedMode;
    const vOk = errV <= 1;
    const iOk = errI <= 1;
    const finiteOk = Number.isFinite(telem.voltage_V) && Number.isFinite(telem.current_A) && Number.isFinite(telem.power_W);

    if (modeOk && vOk && iOk && finiteOk) {
      metrics.ohmSweep.passed++;
    } else {
      metrics.ohmSweep.failed++;
      if (metrics.ohmSweep.failed <= 5) {
        console.error(`[FAIL] R=${rLoad.toFixed(4)}: expected ${expectedMode} (V=${expectedV_mV}mV, I=${expectedI_mA}mA), got ${telem.state.mode} (V=${telem.voltage_mV}mV, I=${telem.current_mA}mA)`);
      }
    }
  }

  const sweepElapsed = performance.now() - tStart;
  console.log(`[PASS 1A] Logarithmic Load Sweep (0.01..100,000 Ohm, ${SWEEP_POINTS.toLocaleString()} points):`);
  console.log(`          Passed: ${metrics.ohmSweep.passed}/${metrics.ohmSweep.points} (${(sweepElapsed).toFixed(2)}ms)`);
  console.log(`          Max Voltage Discrepancy: ${metrics.ohmSweep.maxErrorV_mV} mV, Max Current Discrepancy: ${metrics.ohmSweep.maxErrorI_mA} mA`);
  assert.equal(metrics.ohmSweep.failed, 0, 'Ohm\'s law logarithmic sweep produced calculation discrepancies');

  // 1B: Micro-Stepping Boundary Crossover (0.001 Ohm resolution around R_crit)
  const BOUNDARY_STEPS = 400;
  const rStart = R_CRIT - 0.2; // 5.800 Ohm
  let lastMode = null;
  let transitionCount = 0;

  for (let j = 0; j <= BOUNDARY_STEPS; j++) {
    const r = rStart + (j * 0.001); // 5.800 to 6.200 in 1mOhm steps
    mock.setLoadResistance(r);
    const telem = mock.getTelemetry();
    metrics.boundaryCrossover.points++;

    const expectedMode = (r < R_CRIT) ? 'CC' : 'CV';
    if (lastMode && lastMode !== telem.state.mode) {
      transitionCount++;
    }
    lastMode = telem.state.mode;

    if (telem.state.mode === expectedMode) {
      metrics.boundaryCrossover.passed++;
    } else {
      metrics.boundaryCrossover.failed++;
    }
  }

  metrics.boundaryCrossover.transitions = transitionCount;
  console.log(`[PASS 1B] Boundary Crossover Zoom around ${R_CRIT} Ohm (5.800..6.200 Ohm, step=0.001 Ohm):`);
  console.log(`          Passed: ${metrics.boundaryCrossover.passed}/${metrics.boundaryCrossover.points}, Transitions: ${transitionCount}`);
  assert.equal(metrics.boundaryCrossover.failed, 0, 'Boundary crossover had incorrect mode classification');
  assert.equal(transitionCount, 1, `Expected exactly 1 transition at crossover point, observed ${transitionCount}`);

  // 1C: Rapid Alternating Square-Wave Load Jitter (1,000 short <-> open switches)
  const JITTER_CYCLES = 1000;
  for (let k = 0; k < JITTER_CYCLES; k++) {
    metrics.squareWaveJitter.cycles++;
    // State 1: Short Circuit (0.01 Ohm -> CC mode)
    mock.setLoadResistance(0.01);
    const telemCC = mock.getTelemetry();

    // State 2: High Impedance (100,000 Ohm -> CV mode)
    mock.setLoadResistance(100000.0);
    const telemCV = mock.getTelemetry();

    if (telemCC.state.mode === 'CC' && telemCC.current_mA === 2000 &&
        telemCV.state.mode === 'CV' && telemCV.voltage_mV === 12000) {
      metrics.squareWaveJitter.passed++;
    } else {
      metrics.squareWaveJitter.failed++;
    }
  }

  console.log(`[PASS 1C] Rapid Square-Wave Jitter (${JITTER_CYCLES} cycles 0.01 Ohm <-> 100,000 Ohm):`);
  console.log(`          Passed: ${metrics.squareWaveJitter.passed}/${metrics.squareWaveJitter.cycles}`);
  assert.equal(metrics.squareWaveJitter.failed, 0, 'Square-wave load jitter failed mode settling');

  // 1D: Pathological / Adversarial Load Values
  const pathologicalValues = [
    { input: 0, desc: 'Zero resistance (clamp to 1e-6)', expectedMode: 'CC' },
    { input: -50, desc: 'Negative resistance (clamp to 1e-6)', expectedMode: 'CC' },
    { input: Infinity, desc: 'Infinite resistance', expectedMode: 'CV' },
    { input: NaN, desc: 'NaN resistance (fallback to 10 Ohm)', expectedMode: 'CV' },
    { input: null, desc: 'null resistance (fallback to 10 Ohm)', expectedMode: 'CV' },
    { input: undefined, desc: 'undefined resistance (fallback to 10 Ohm)', expectedMode: 'CV' },
    { input: 1e-10, desc: 'Sub-micro-ohm resistance', expectedMode: 'CC' },
    { input: 1e9, desc: 'Giga-ohm resistance', expectedMode: 'CV' }
  ];

  for (const testCase of pathologicalValues) {
    metrics.pathologicalLoads.tests++;
    mock.setLoadResistance(testCase.input);
    const telem = mock.getTelemetry();
    const isFiniteValues = Number.isFinite(telem.voltage_V) && Number.isFinite(telem.current_A) && !Number.isNaN(telem.power_W);
    const modeMatches = telem.state.mode === testCase.expectedMode;

    if (isFiniteValues && modeMatches && telem.voltage_mV >= 0 && telem.current_mA >= 0) {
      metrics.pathologicalLoads.passed++;
    } else {
      metrics.pathologicalLoads.failed++;
      console.error(`[FAIL 1D] Pathological value ${testCase.desc} failed:`, telem);
    }
  }

  console.log(`[PASS 1D] Pathological / Adversarial Load Resistances (${pathologicalValues.length} edge cases):`);
  console.log(`          Passed: ${metrics.pathologicalLoads.passed}/${metrics.pathologicalLoads.tests}`);
  assert.equal(metrics.pathologicalLoads.failed, 0, 'Pathological load resistance caused NaN, crash or invalid state');
}

runOhmLawStress();

// ============================================================================
// SECTION 2: 1,000 Rapid Concurrent Setpoint Requests & Queue Integrity
// ============================================================================
console.log('\n--- [SECTION 2] 1,000 Concurrent Setpoint Requests & Queue Serialization ---');

async function runConcurrentQueueStress() {
  const controller = new PowerController({
    isMock: true,
    pollingIntervalMs: 0, // Disable background poll during pure burst test
    timeoutMs: 1000
  });

  // Turn output on first
  await controller.setOutput(true);

  const CONCURRENT_REQUESTS = 1000;
  const executionOrder = [];
  const promises = [];

  console.log(`Dispatching ${CONCURRENT_REQUESTS} rapid concurrent setpoint requests...`);
  const tStart = performance.now();

  for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
    // Voltage ramp from 0.01V to 10.00V in 0.01V increments
    const v = Number(((i + 1) * 0.01).toFixed(2));
    const reqIndex = i;

    const p = controller.setVoltage(v).then((success) => {
      executionOrder.push({ index: reqIndex, voltage: v, success });
      return success;
    });
    promises.push(p);
  }

  const results = await Promise.all(promises);
  const tElapsed = performance.now() - tStart;

  metrics.concurrentSetpoints.total = CONCURRENT_REQUESTS;
  metrics.concurrentSetpoints.elapsedMs = tElapsed;
  metrics.concurrentSetpoints.opsPerSec = (CONCURRENT_REQUESTS / (tElapsed / 1000));

  let inversions = 0;
  for (let j = 0; j < executionOrder.length; j++) {
    if (executionOrder[j].index !== j) {
      inversions++;
    }
    if (executionOrder[j].success) {
      metrics.concurrentSetpoints.passed++;
    } else {
      metrics.concurrentSetpoints.failed++;
    }
  }

  metrics.concurrentSetpoints.inversions = inversions;

  console.log(`[PASS 2A] Executed ${CONCURRENT_REQUESTS} concurrent setpoints in ${tElapsed.toFixed(2)}ms:`);
  console.log(`          Throughput: ${metrics.concurrentSetpoints.opsPerSec.toFixed(1)} transactions/sec`);
  console.log(`          Average Latency: ${(tElapsed / CONCURRENT_REQUESTS).toFixed(3)} ms/tx`);
  console.log(`          Success Rate: ${metrics.concurrentSetpoints.passed}/${metrics.concurrentSetpoints.total}`);
  console.log(`          Queue Inversions (Race Conditions): ${inversions}`);

  assert.equal(metrics.concurrentSetpoints.failed, 0, 'Some concurrent setpoints failed');
  assert.equal(inversions, 0, `Priority queue suffered ${inversions} out-of-order race inversions`);

  // Verify final state matches the 1,000th request
  const finalTelemetry = controller.getTelemetry();
  const expectedFinalV = Number(((CONCURRENT_REQUESTS) * 0.01).toFixed(2));
  console.log(`          Final Setpoint in Controller: ${finalTelemetry.setVoltage_V}V (Expected: ${expectedFinalV}V)`);
  assert.equal(finalTelemetry.setVoltage_V, expectedFinalV, 'Final controller setpoint mismatch');

  // Verify mock internal state matches
  const mockState = controller.mockTransport.mock.getState();
  assert.equal(mockState.setVoltage_V, expectedFinalV, 'Mock internal voltage does not match last setpoint');

  await controller.close();

  // 2B: 1,000 Concurrent Setpoints with High-Frequency Background Polling (20ms)
  console.log('\n--- [SECTION 2B] Concurrent Setpoints with Active Cyclic Polling (20ms) ---');
  const pollingController = new PowerController({
    isMock: true,
    pollingIntervalMs: 20,
    timeoutMs: 1000
  });

  pollingController.startPolling(20);
  await pollingController.setOutput(true);
  let telemetryEventsCount = 0;
  pollingController.on('telemetry', () => {
    telemetryEventsCount++;
  });

  const BURST_COUNT = 1000;
  const burstPromises = [];
  const tBurstStart = performance.now();

  for (let k = 0; k < BURST_COUNT; k++) {
    const v = Number(((k % 30) + 1).toFixed(2));
    burstPromises.push(pollingController.setVoltage(v));
  }

  await Promise.all(burstPromises);
  const tBurstElapsed = performance.now() - tBurstStart;

  // Let background polling run for 100ms post-burst
  await sleep(100);

  console.log(`[PASS 2B] Blasted ${BURST_COUNT} setpoints during active 20ms cyclic polling in ${tBurstElapsed.toFixed(2)}ms:`);
  console.log(`          Telemetry Events Received: ${telemetryEventsCount}`);
  console.log(`          Queue lengths: high=${pollingController.highPriorityQueue.length}, low=${pollingController.lowPriorityQueue.length}`);
  assert.equal(pollingController.highPriorityQueue.length, 0, 'High priority queue did not drain completely');
  assert.equal(pollingController.lowPriorityQueue.length, 0, 'Low priority queue did not drain completely');
  assert.ok(telemetryEventsCount >= 1, 'Background polling was starved or stopped completely');

  await pollingController.close();
}

// ============================================================================
// SECTION 3: Emergency Stop Preemption under Heavy Queue Load
// ============================================================================
console.log('\n--- [SECTION 3] Emergency Stop Preemption under Heavy Load ---');

async function runEmergencyStopPreemptionStress() {
  const controller = new PowerController({
    isMock: true,
    pollingIntervalMs: 0,
    timeoutMs: 1000
  });

  await controller.setOutput(true);
  assert.equal(controller.getTelemetry().state.outputOn, true, 'Output should be ON before preemption test');

  const SETPOINTS_BEFORE_ESTOP = 500;
  const SETPOINTS_AFTER_ESTOP = 500;
  const completionTimeline = [];

  console.log(`Queueing ${SETPOINTS_BEFORE_ESTOP} setpoints, then injecting Emergency Stop (Priority 0), then ${SETPOINTS_AFTER_ESTOP} setpoints...`);

  const allPromises = [];

  // 1. Enqueue 500 setpoints
  for (let i = 0; i < SETPOINTS_BEFORE_ESTOP; i++) {
    const v = Number(((i + 1) * 0.01).toFixed(2));
    const p = controller.setVoltage(v).then(() => {
      completionTimeline.push({ type: 'setpoint', id: i });
    });
    allPromises.push(p);
  }

  // 2. Immediately inject Emergency Stop (Output OFF, Priority 0)
  const eStopStart = performance.now();
  const eStopPromise = controller.emergencyStop().then(() => {
    const eStopLatency = performance.now() - eStopStart;
    completionTimeline.push({ type: 'emergencyStop', latencyMs: eStopLatency });
  });
  allPromises.push(eStopPromise);

  // 3. Immediately enqueue 500 more setpoints
  for (let j = 0; j < SETPOINTS_AFTER_ESTOP; j++) {
    const v = Number(((j + 1) * 0.01).toFixed(2));
    const p = controller.setVoltage(v).then(() => {
      completionTimeline.push({ type: 'setpoint', id: 500 + j });
    });
    allPromises.push(p);
  }

  // Await complete drainage
  await Promise.all(allPromises);

  // Analyze preemption
  const eStopIndex = completionTimeline.findIndex((item) => item.type === 'emergencyStop');
  const eStopEntry = completionTimeline[eStopIndex];

  console.log(`[PASS 3A] Emergency Stop Position in Completed Sequence: #${eStopIndex + 1} of ${completionTimeline.length}`);
  console.log(`          Setpoints executed before E-Stop: ${eStopIndex}`);
  console.log(`          Emergency Stop Latency: ${eStopEntry.latencyMs.toFixed(3)} ms`);

  metrics.emergencyPreemption.tested = true;
  metrics.emergencyPreemption.pendingAtInject = SETPOINTS_BEFORE_ESTOP;
  metrics.emergencyPreemption.executedBeforeEStop = eStopIndex;
  metrics.emergencyPreemption.eStopLatencyMs = eStopEntry.latencyMs;

  assert.ok(eStopIndex <= 1, `Emergency stop did NOT preempt queue! Executed as item #${eStopIndex + 1}, expected <= 2`);
  assert.equal(controller.getTelemetry().state.outputOn, false, 'Output state must be OFF after emergency stop');

  metrics.emergencyPreemption.passed = true;
  console.log(`[PASS 3B] Preemption verified: E-Stop jumped ahead of ${SETPOINTS_BEFORE_ESTOP - eStopIndex} pending setpoints!`);

  // 3C: Multiple Consecutive Emergency Stops under Heavy Contention
  console.log('Testing multiple consecutive Emergency Stops under contention...');
  const multiEStopPromises = [];
  for (let m = 0; m < 50; m++) {
    multiEStopPromises.push(controller.emergencyStop());
  }
  await Promise.all(multiEStopPromises);
  assert.equal(controller.getTelemetry().state.outputOn, false, 'Output must remain OFF');
  console.log('[PASS 3C] 50 consecutive emergency stops drained cleanly without queue corruption');

  await controller.close();
}

// ============================================================================
// SECTION 4: Dual Transport & Noise Collision Resilience
// ============================================================================
console.log('\n--- [SECTION 4] Noise Collision & Slew Rate Resilience ---');

async function runNoiseAndSlewResilience() {
  // 4A: Checksum Collision Defense (1/256 false collision rejection)
  const controller = new PowerController({
    isMock: true,
    pollingIntervalMs: 0,
    timeoutMs: 1000
  });

  console.log('Testing 1/256 modulo-256 false checksum collision mitigation...');

  const setpointPromise = controller.setVoltage(15.0);

  const bogusPayload = Buffer.alloc(22, 0);
  bogusPayload[0] = 0x80;
  const bogusFrame = protocol.buildFrame(0x42, protocol.COMMANDS.READ_TELEMETRY, bogusPayload);

  controller.activeTransport.emit('frame', bogusFrame);

  const res = await setpointPromise;
  assert.equal(res, true, 'Real transaction failed after noisy collision injection');
  assert.equal(controller.getTelemetry().setVoltage_V, 15.0, 'Controller accepted false payload');
  metrics.noiseDefense.tested = true;
  metrics.noiseDefense.passed = true;
  console.log('[PASS 4A] Checksum collision frame safely discarded by multi-field address/command discriminator');

  // 4B: Rapid Transport Toggle under polling
  console.log('Testing seamless mock mode toggles...');
  for (let t = 0; t < 20; t++) {
    controller.setMockMode(t % 2 === 0);
  }
  controller.setMockMode(true);
  assert.equal(controller.getStatus().mode, 'mock');
  console.log('[PASS 4B] Rapid transport toggle (20 switches) maintained consistent state');

  await controller.close();

  // 4C: Slew Rate Ramping Fidelity (enableSlewRate = true)
  console.log('Testing slew rate voltage ramping dynamic physics...');
  const slewMock = new MockPowerSupply({
    model: '3645A',
    outputOn: true,
    remoteMode: true,
    enableSlewRate: true,
    slewRate_V_per_s: 50.0 // 50 V/s -> 10V takes ~200ms
  });

  slewMock.setVoltage(10.0);
  slewMock.setLoadResistance(100.0);

  let lastV = -1;
  let monotonic = true;
  const steps = 10;

  for (let s = 0; s < steps; s++) {
    await sleep(25);
    const telem = slewMock.getTelemetry();
    metrics.slewRate.steps++;
    if (telem.voltage_V < lastV) {
      monotonic = false;
    }
    lastV = telem.voltage_V;
  }

  await sleep(100);
  const finalTelem = slewMock.getTelemetry();
  metrics.slewRate.monotonic = monotonic;

  console.log(`[PASS 4C] Slew rate ramped monotonically to ${finalTelem.voltage_V}V (target 10.0V): monotonic=${monotonic}`);
  assert.ok(monotonic, 'Slew rate ramp was not monotonic');
  assert.ok(finalTelem.voltage_V >= 9.9, `Slew rate target not reached in expected timeframe: ${finalTelem.voltage_V}V`);
}

// ============================================================================
// MAIN RUNNER
// ============================================================================
async function main() {
  try {
    await runConcurrentQueueStress();
    await runEmergencyStopPreemptionStress();
    await runNoiseAndSlewResilience();

    console.log('\n================================================================');
    console.log('EMPIRICAL STRESS TEST HARNESS COMPLETED: ALL SUITES PASSED');
    console.log('================================================================');
    console.log(JSON.stringify(metrics, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('\n================================================================');
    console.error('EMPIRICAL STRESS TEST HARNESS FAILED WITH EXCEPTION:');
    console.error(err);
    console.error('================================================================');
    process.exit(1);
  }
}

main();
