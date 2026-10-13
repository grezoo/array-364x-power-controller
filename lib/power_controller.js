/**
 * lib/power_controller.js
 *
 * Array 364X / 3600 Series Power Supply Controller & Transport Layer
 * Pure Node.js CommonJS module - Zero mandatory external dependencies.
 *
 * Provides:
 * - Pluggable dual transport: MockTransport (virtual simulator) & SerialTransport (Windows COM port).
 * - Seamless runtime switching via setMockMode().
 * - Two-tier half-duplex transaction queue (Emergency Stop preemption, setpoint priority over polling).
 * - Defense against 1/256 false modulo-256 checksum collisions on noisy RS232 lines.
 * - Software safety limits (maxVoltage_V, maxCurrent_A) with immediate RangeError rejection.
 * - Non-blocking cyclic telemetry polling with unref'd timer handles.
 * - EventEmitter contract emitting 'telemetry', 'status', and 'error'.
 */

'use strict';

const EventEmitter = require('events');
const protocol = require('./array_protocol');

function getMockClass() {
  try {
    return require('./mock_power_supply');
  } catch {
    return null;
  }
}

function getSerialPortClass() {
  try {
    const sp = require('serialport');
    return sp.SerialPort || sp;
  } catch {
    return null;
  }
}

/**
 * Mock Transport Implementation wrapping MockPowerSupply.
 */
class MockTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    const MockClass = getMockClass();
    if (MockClass) {
      const opts = Object.assign({ remoteMode: true }, options);
      this.mock = typeof MockClass === 'function' ? new MockClass(opts) : MockClass;
    } else {
      this.mock = null;
    }
    this._isOpen = false;
  }

  isOpen() {
    return this._isOpen;
  }

  open() {
    this._isOpen = true;
    this.emit('open');
    return Promise.resolve();
  }

  close() {
    this._isOpen = false;
    this.emit('close');
    return Promise.resolve();
  }

  write(frameBuffer) {
    if (!this._isOpen || !this.mock) {
      return Promise.reject(new Error('Mock transport is not open'));
    }
    setImmediate(() => {
      if (!this._isOpen) return;
      try {
        const handler = this.mock.processFrame || this.mock.handleFrame;
        if (typeof handler === 'function') {
          const resp = handler.call(this.mock, frameBuffer);
          if (Buffer.isBuffer(resp)) {
            this.emit('frame', resp);
          }
        }
      } catch (err) {
        this.emit('error', err);
      }
    });
    return Promise.resolve();
  }

  setLoadResistance(ohms) {
    if (this.mock && typeof this.mock.setLoadResistance === 'function') {
      this.mock.setLoadResistance(ohms);
    }
  }
}

/**
/**
 * Serial Port Transport Implementation using serialport (if available) or built-in Windows PowerShell SerialPort bridge.
 * Note: Array 3311/3312 optical isolated RS232 adapters draw VCC from DTR (Pin 4) & RTS (Pin 7), so DTR/RTS are asserted.
 */
class SerialTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.portName = options.portName || 'COM3';
    this.baudRate = options.baudRate || 9600;
    this.serialPort = null;
    this.psProc = null;
    this.assembler = new protocol.FrameChunkAssembler();
    this._isOpen = false;
  }

  isOpen() {
    if (this.serialPort) return !!this.serialPort.isOpen;
    return this._isOpen;
  }

  open() {
    const SerialPort = getSerialPortClass();
    if (SerialPort) {
      return new Promise((resolve, reject) => {
        try {
          this.serialPort = new SerialPort({
            path: this.portName,
            baudRate: this.baudRate,
            autoOpen: false
          });

          this.serialPort.on('data', (chunk) => {
            const frames = this.assembler.push(chunk);
            for (const frame of frames) {
              this.emit('frame', frame);
            }
          });

          this.serialPort.on('error', (err) => {
            this.emit('error', err);
          });

          this.serialPort.on('close', () => {
            this._isOpen = false;
            this.emit('close');
          });

          this.serialPort.open((err) => {
            if (err) {
              this._isOpen = false;
              this.emit('error', err);
              reject(err);
            } else {
              if (typeof this.serialPort.set === 'function') {
                this.serialPort.set({ dtr: true, rts: true }, () => {});
              }
              this._isOpen = true;
              this.emit('open');
              resolve();
            }
          });
        } catch (err) {
          this._isOpen = false;
          this.emit('error', err);
          reject(err);
        }
      });
    }

    // Fallback: Native Windows PowerShell .NET SerialPort persistent bridge (zero external dependencies)
    if (process.platform === 'win32' && !this.portName.startsWith('MOCK') && !this.portName.startsWith('INVALID')) {
      return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const psScript = `
$ErrorActionPreference = 'Stop'
try {
  $p = New-Object System.IO.Ports.SerialPort('${this.portName}', ${Number(this.baudRate) || 19200}, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  $p.DtrEnable = $true
  $p.RtsEnable = $true
  $p.Open()
  Start-Sleep -Milliseconds 120
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  $rxBuf = New-Object byte[] 512
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line -eq 'CLOSE') { break }
    if ($line.StartsWith('TX:')) {
      $hex = $line.Substring(3).Trim()
      $bytes = New-Object byte[] ($hex.Length / 2)
      for ($i=0; $i -lt $bytes.Length; $i++) {
        $bytes[$i] = [Convert]::ToByte($hex.Substring($i*2, 2), 16)
      }
      Start-Sleep -Milliseconds 45
      $p.DiscardInBuffer()
      $p.Write($bytes, 0, $bytes.Length)
      $waited = 0
      $collected = 0
      while ($waited -lt 550 -and $collected -lt 26) {
        Start-Sleep -Milliseconds 15
        $waited += 15
        $avail = $p.BytesToRead
        if ($avail -gt 0) {
          $r = $p.Read($rxBuf, $collected, [Math]::Min($avail, 512 - $collected))
          $collected += $r
        }
      }
      if ($collected -gt 0) {
        $hexOut = [BitConverter]::ToString($rxBuf, 0, $collected).Replace('-', '')
        [Console]::Out.WriteLine('RX:' + $hexOut)
        [Console]::Out.Flush()
      } else {
        [Console]::Out.WriteLine('RX:EMPTY')
        [Console]::Out.Flush()
      }
    }
  }
  if ($p.IsOpen) { $p.Close() }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
        let settled = false;
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
        this.psProc = proc;
        let stdoutBuf = '';

        proc.stdout.on('data', (data) => {
          stdoutBuf += data.toString('utf8');
          const lines = stdoutBuf.split(/\r?\n/);
          stdoutBuf = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === 'READY' && !settled) {
              settled = true;
              this._isOpen = true;
              this.emit('open');
              resolve();
            } else if (trimmed === 'RX:EMPTY') {
              this.assembler.reset();
            } else if (trimmed.startsWith('RX:')) {
              const hex = trimmed.slice(3).trim();
              if (hex.length > 0) {
                const chunk = Buffer.from(hex, 'hex');
                const frames = this.assembler.push(chunk);
                for (const frame of frames) {
                  this.emit('frame', frame);
                }
              }
            }
          }
        });

        proc.stderr.on('data', (data) => {
          const msg = data.toString('utf8').trim();
          if (msg) {
            const err = new Error(msg);
            this.emit('error', err);
            if (!settled) {
              settled = true;
              this._isOpen = false;
              reject(err);
            }
          }
        });

        proc.on('close', () => {
          this._isOpen = false;
          this.psProc = null;
          this.emit('close');
          if (!settled) {
            settled = true;
            reject(new Error(`Failed to open serial port ${this.portName}`));
          }
        });
      });
    }

    return Promise.reject(new Error('serialport module is not installed'));
  }

  close() {
    return new Promise((resolve) => {
      if (this.psProc) {
        const proc = this.psProc;
        this.psProc = null;
        this._isOpen = false;
        this.assembler.reset();
        try {
          proc.stdin.write('CLOSE\n');
          proc.kill();
        } catch {}
        return resolve();
      }
      if (!this.serialPort || !this.serialPort.isOpen) {
        this._isOpen = false;
        return resolve();
      }
      this.serialPort.close(() => {
        this._isOpen = false;
        this.assembler.reset();
        resolve();
      });
    });
  }

  write(frameBuffer) {
    if (!this.isOpen()) {
      return Promise.reject(new Error('Serial port is not open'));
    }
    if (this.psProc && this.psProc.stdin && !this.psProc.stdin.destroyed) {
      return new Promise((resolve, reject) => {
        const hex = frameBuffer.toString('hex').toUpperCase();
        this.psProc.stdin.write(`TX:${hex}\n`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    return new Promise((resolve, reject) => {
      this.serialPort.write(frameBuffer, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Main PowerController Class
 */
class PowerController extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.address=0x00]
   * @param {boolean} [options.isMock=true]
   * @param {string} [options.portName='COM3']
   * @param {number} [options.baudRate=9600]
   * @param {number} [options.pollingIntervalMs=500]
   * @param {number} [options.timeoutMs=500]
   * @param {Object} [options.limits]
   * @param {number} [options.maxSoftwareVoltage]
   * @param {number} [options.maxSoftwareCurrent]
   */
  constructor(options = {}) {
    super();

    this.address = options.address !== undefined ? (options.address & 0xFF) : 0x00;
    this.isMock = options.isMock !== false;
    this.portName = options.portName || 'COM3';
    this.baudRate = options.baudRate || 9600;
    this.pollingIntervalMs = options.pollingIntervalMs || 500;
    this.timeoutMs = options.timeoutMs || 500;

    const maxV = options.maxSoftwareVoltage ?? options.limits?.maxVoltage_V ?? 30.0;
    const maxA = options.maxSoftwareCurrent ?? options.limits?.maxCurrent_A ?? 3.0;
    const maxP = options.limits?.maxPower_W ?? 90.0;

    this.safetyLimits = {
      maxVoltage_V: maxV,
      maxCurrent_A: maxA,
      maxPower_W: maxP
    };

    // Hardware maximum bounds reported by device telemetry (defaults to 30V / 90W safe compatible bounds)
    this.hardwareBounds = {
      maxVoltage_V: 30.0,
      maxPower_W: 90.0
    };

    // Setpoint tracking
    this.currentSetVoltage_V = 0.0;
    this.currentSetLimit_A = Math.min(3.0, this.safetyLimits.maxCurrent_A);
    this.outputOn = false;
    this.remoteMode = true;

    // I/V Sweep state
    this.sweepState = {
      running: false,
      aborted: false,
      points: [],
      lastFile: null
    };

    // Cached telemetry initialized to safe defaults
    this.lastTelemetry = {
      voltage_V: 0.0,
      current_A: 0.0,
      power_W: 0.0,
      voltage_mV: 0,
      current_mA: 0,
      maxVoltage_mV: Math.round(this.safetyLimits.maxVoltage_V * 1000),
      maxVoltage_V: this.safetyLimits.maxVoltage_V,
      maxCurrent_mA: Math.round(this.currentSetLimit_A * 1000),
      maxCurrent_A: this.currentSetLimit_A,
      maxPower_W: this.safetyLimits.maxPower_W,
      setVoltage_mV: 0,
      setVoltage_V: 0.0,
      state: {
        outputOn: false,
        mode: 'CV',
        overPower: false,
        remote: true,
        rawStatus: 0x08
      }
    };

    // Priority transaction queues
    this.highPriorityQueue = [];
    this.lowPriorityQueue = [];
    this.inFlight = null;
    this.pollingTimer = null;
    this.pollingEnabled = false;

    // Transports
    this.mockTransport = new MockTransport(Object.assign({ remoteMode: true }, options));
    this.serialTransport = new SerialTransport({ portName: this.portName, baudRate: this.baudRate });
    this.activeTransport = this.isMock ? this.mockTransport : this.serialTransport;

    this._setupTransportListeners(this.mockTransport);
    this._setupTransportListeners(this.serialTransport);

    if (this.isMock) {
      this.mockTransport.open();
    }
  }

  _emitError(err) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  _setupTransportListeners(transport) {
    transport.on('frame', (frame) => {
      if (transport === this.activeTransport) {
        this._handleIncomingFrame(frame);
      }
    });
    transport.on('error', (err) => {
      if (transport === this.activeTransport) {
        this._emitError(err);
      }
    });
  }

  /**
   * Initializes or updates controller configuration.
   * @param {Object} [config]
   * @returns {this}
   */
  init(config = {}) {
    if (config.address !== undefined) this.address = config.address & 0xFF;
    if (config.portName !== undefined) {
      this.portName = config.portName;
      if (this.serialTransport) this.serialTransport.portName = this.portName;
    }
    if (config.baudRate !== undefined) {
      this.baudRate = config.baudRate;
      if (this.serialTransport) this.serialTransport.baudRate = this.baudRate;
    }
    if (config.timeoutMs !== undefined) this.timeoutMs = config.timeoutMs;
    if (config.pollingIntervalMs !== undefined) this.pollingIntervalMs = config.pollingIntervalMs;

    if (config.limits) {
      this.setSafetyLimits(config.limits);
    }
    if (config.maxSoftwareVoltage !== undefined || config.maxSoftwareCurrent !== undefined) {
      this.setSafetyLimits({
        maxVoltage_V: config.maxSoftwareVoltage,
        maxCurrent_A: config.maxSoftwareCurrent
      });
    }

    const mockMode = config.isMock !== undefined ? !!config.isMock : this.isMock;
    this.setMockMode(mockMode);

    if (config.pollingIntervalMs !== undefined && config.pollingIntervalMs > 0) {
      this.startPolling(config.pollingIntervalMs);
    }

    return this;
  }

  /**
   * Switches active transport seamlessly between Mock and Serial.
   * @param {boolean} isMock
   */
  setMockMode(isMock) {
    const newMock = !!isMock;
    const modeChanged = (this.isMock !== newMock);
    this.isMock = newMock;
    this.activeTransport = this.isMock ? this.mockTransport : this.serialTransport;

    if (modeChanged) {
      if (this.inFlight) {
        clearTimeout(this.inFlight.timer);
        const abortedTx = this.inFlight;
        this.inFlight = null;
        if (typeof abortedTx.reject === 'function') abortedTx.reject(new Error('Transaction aborted: transport toggled'));
      }
      while (this.lowPriorityQueue.length > 0) {
        const lowTx = this.lowPriorityQueue.shift();
        if (lowTx && typeof lowTx.reject === 'function') lowTx.reject(new Error('Transaction cancelled: transport toggled'));
      }
    }

    if (!this.activeTransport.isOpen()) {
      this._openingPromise = this.activeTransport.open().catch((err) => {
        this._emitError(err);
      }).finally(() => {
        this._openingPromise = null;
      });
    }
    this.emit('status', {
      mode: this.isMock ? 'mock' : 'serial',
      connected: this.activeTransport.isOpen(),
      port: this.portName
    });
    if (modeChanged) {
      this._processQueue();
    }
  }

  /**
   * Adjusts virtual load resistance on the mock simulator.
   * @param {number} ohms
   */
  setVirtualLoad(ohms) {
    if (this.mockTransport) {
      this.mockTransport.setLoadResistance(ohms);
    }
  }

  /**
   * Updates software safety limits.
   * @param {Object} limits
   */
  setSafetyLimits(limits = {}) {
    if (limits.maxVoltage_V !== undefined) this.safetyLimits.maxVoltage_V = Number(limits.maxVoltage_V);
    if (limits.maxSoftwareVoltage !== undefined) this.safetyLimits.maxVoltage_V = Number(limits.maxSoftwareVoltage);
    if (limits.maxCurrent_A !== undefined) this.safetyLimits.maxCurrent_A = Number(limits.maxCurrent_A);
    if (limits.maxSoftwareCurrent !== undefined) this.safetyLimits.maxCurrent_A = Number(limits.maxSoftwareCurrent);
    if (limits.maxPower_W !== undefined) this.safetyLimits.maxPower_W = Number(limits.maxPower_W);
  }

  /**
   * Controls main output state (ON/OFF) and remote mode.
   * Turning OFF (Emergency Stop) has Priority 0 and jumps to head of queue.
   *
   * @param {boolean} on
   * @returns {Promise<boolean>}
   */
  setOutput(on) {
    const outputOn = !!on;
    const frame = protocol.encodeControl(this.address, {
      outputOn,
      remoteMode: this.remoteMode
    });
    const priority = outputOn ? 1 : 0; // Emergency Stop has Priority 0

    return this._enqueueTransaction({
      priority,
      expectedCmd: protocol.COMMANDS.RESPONSE_CHECK,
      address: this.address,
      frame,
      timeoutMs: this.timeoutMs,
      retries: this.isMock ? 1 : 3
    }).then((resp) => {
      this.outputOn = outputOn;
      this.lastTelemetry.state.outputOn = outputOn;
      this.emit('status', { outputOn: this.outputOn });
      return resp.success;
    });
  }

  /**
   * Immediate emergency stop preemption.
   * @returns {Promise<boolean>}
   */
  emergencyStop() {
    return this.setOutput(false);
  }

  /**
   * Sets target voltage setpoint in Volts.
   * Rejects immediately with RangeError if setpoint exceeds software safety limit.
   *
   * @param {number} volts
   * @returns {Promise<boolean>}
   */
  setVoltage(volts) {
    const rawV = Number(volts);
    if (!Number.isFinite(rawV) || rawV < 0) {
      return Promise.reject(new RangeError(`Invalid voltage setpoint: ${volts}`));
    }
    // Array 364X hardware voltage resolution is 10mV (0.01V)
    const v = Math.round(rawV * 100) / 100;
    if (v > this.safetyLimits.maxVoltage_V) {
      return Promise.reject(new RangeError(`Voltage ${v}V exceeds software safety limit ${this.safetyLimits.maxVoltage_V}V`));
    }

    const hwMaxV = Math.min(this.safetyLimits.maxVoltage_V, this.hardwareBounds?.maxVoltage_V || 30.0);
    const hwMaxP = Math.min(this.safetyLimits.maxPower_W, this.hardwareBounds?.maxPower_W || 90.0);
    const safeLimitA = Math.max(0.01, Number(this.currentSetLimit_A) || 0.5);
    this.currentSetLimit_A = safeLimitA;

    const frame = protocol.encodeSetParameters(this.address, {
      setVoltage_V: v,
      maxCurrent_A: safeLimitA,
      maxVoltage_V: Math.max(v, hwMaxV),
      maxPower_W: hwMaxP,
      newAddress: this.address
    });

    return this._enqueueTransaction({
      priority: 1,
      expectedCmd: protocol.COMMANDS.RESPONSE_CHECK,
      address: this.address,
      frame,
      timeoutMs: this.timeoutMs,
      retries: this.isMock ? 1 : 3
    }).then((resp) => {
      this.currentSetVoltage_V = v;
      this.lastTelemetry.setVoltage_mV = Math.round(v * 1000);
      this.lastTelemetry.setVoltage_V = v;
      return resp.success;
    });
  }

  /**
   * Sets current limit threshold in Amperes.
   * Rejects immediately with RangeError if limit exceeds software safety limit.
   * Minimum allowed current limit is 0.010 A (10 mA) — never 0.
   *
   * @param {number} amps
   * @returns {Promise<boolean>}
   */
  setCurrentLimit(amps) {
    const rawA = Number(amps);
    if (!Number.isFinite(rawA) || rawA < 0) {
      return Promise.reject(new RangeError(`Invalid current limit: ${amps}`));
    }
    const a = Math.max(0.01, Math.round(rawA * 1000) / 1000);
    if (a > this.safetyLimits.maxCurrent_A) {
      return Promise.reject(new RangeError(`Current ${a}A exceeds software safety limit ${this.safetyLimits.maxCurrent_A}A`));
    }

    const hwMaxV = Math.min(this.safetyLimits.maxVoltage_V, this.hardwareBounds?.maxVoltage_V || 30.0);
    const hwMaxP = Math.min(this.safetyLimits.maxPower_W, this.hardwareBounds?.maxPower_W || 90.0);

    const frame = protocol.encodeSetParameters(this.address, {
      setVoltage_V: this.currentSetVoltage_V,
      maxCurrent_A: a,
      maxVoltage_V: Math.max(this.currentSetVoltage_V, hwMaxV),
      maxPower_W: hwMaxP,
      newAddress: this.address
    });

    return this._enqueueTransaction({
      priority: 1,
      expectedCmd: protocol.COMMANDS.RESPONSE_CHECK,
      address: this.address,
      frame,
      timeoutMs: this.timeoutMs,
      retries: this.isMock ? 1 : 3
    }).then((resp) => {
      this.currentSetLimit_A = a;
      this.lastTelemetry.maxCurrent_mA = Math.round(a * 1000);
      this.lastTelemetry.maxCurrent_A = a;
      return resp.success;
    });
  }

  /**
   * Stops an active I/V Curve Sweep immediately and turns off output.
   */
  stopIVSweep() {
    this.sweepState.aborted = true;
    this.sweepState.running = false;
    return this.setOutput(false).catch(() => {});
  }

  /**
   * Executes an automated I/V Curve Tracer Sweep from startV to stopV with stepV increments.
   * Measures V, I, P at each step, emits 'sweep_point', stops if measured current >= currentLimit_A,
   * and returns the complete array of measured points.
   *
   * @param {Object} opts
   * @param {number} [opts.startV=0.0]
   * @param {number} [opts.stopV=5.0]
   * @param {number} [opts.stepV=0.5]
   * @param {number} [opts.currentLimit_A=1.0]
   * @param {number} [opts.dwellMs=650]
   * @param {Function} [opts.onPoint]
   * @returns {Promise<{points: Array, stopReason: string}>}
   */
  async runIVSweep(opts = {}) {
    if (this.sweepState.running) {
      throw new Error('I/V Sweep is already in progress!');
    }

    const startV = Math.round(Math.max(0, Number(opts.startV ?? 0.0)) * 100) / 100;
    const stopV = Math.round(Math.min(this.safetyLimits.maxVoltage_V, Number(opts.stopV ?? 5.0)) * 100) / 100;
    const rawStep = Math.abs(Number(opts.stepV ?? 0.5)) || 0.5;
    const stepV = Math.max(0.01, Math.round(rawStep * 100) / 100);
    const limitA = Math.max(0.01, Math.min(this.safetyLimits.maxCurrent_A, Number(opts.currentLimit_A ?? 1.0)));
    const dwellMs = Math.max(150, Number(opts.dwellMs ?? (this.isMock ? 200 : 550)));

    this.sweepState.running = true;
    this.sweepState.aborted = false;
    this.sweepState.points = [];
    let stopReason = 'completed';

    try {
      // Ensure Remote mode + Output ON and initial setpoints
      await this.setOutput(true);
      await this.setCurrentLimit(limitA);
      await this.setVoltage(startV);

      // Initial relay engagement wait on physical hardware
      await new Promise((r) => setTimeout(r, this.isMock ? 150 : 1200));

      const direction = stopV >= startV ? 1 : -1;
      const totalSteps = Math.floor(Math.abs(stopV - startV) / stepV + 1e-6);

      for (let idx = 0; idx <= totalSteps; idx++) {
        if (this.sweepState.aborted) {
          stopReason = 'aborted';
          break;
        }

        const targetV = Math.round((startV + direction * idx * stepV) * 100) / 100;
        await this.setVoltage(targetV);

        const maxWait = this.isMock ? dwellMs : Math.max(dwellMs, 3400);
        const tolV = Math.max(0.015, Math.min(0.04, stepV * 0.38));
        const startStepTime = Date.now();
        let t = await this._pollRawTelemetry();
        let lastRelatchTime = startStepTime;

        while (Date.now() - startStepTime < maxWait) {
          if (this.sweepState.aborted) break;
          await new Promise((r) => setTimeout(r, this.isMock ? dwellMs : 250));
          t = await this._pollRawTelemetry();
          const now = Date.now();
          const elapsed = now - startStepTime;
          const vMeas = t.voltage_V ?? 0;
          const vDiff = Math.abs(vMeas - targetV);
          const isCC = t.state?.mode === 'CC' || (t.current_A ?? 0) >= limitA * 0.95;
          if (elapsed >= dwellMs && (this.isMock || isCC || vDiff <= tolV)) {
            break;
          }
          // Hardware range/tap boundary re-latch (e.g. crossing 4.00V on Array 3645A):
          // Wait until output capacitor discharges <= 0.25V (or 550ms since last latch) then re-send 0x80
          if (!this.isMock && !isCC && vDiff > tolV) {
            if ((vMeas <= 0.25 && now - lastRelatchTime >= 320) || (now - lastRelatchTime >= 550)) {
              lastRelatchTime = Date.now();
              await this.setVoltage(targetV);
            }
          }
        }

        if (this.sweepState.aborted) {
          stopReason = 'aborted';
          break;
        }

        // Commit settled reading to public telemetry cache
        this.lastTelemetry = t;
        this.emit('telemetry', t);

        const pt = {
          step: idx + 1,
          timestamp: new Date().toISOString(),
          setVoltage_V: targetV,
          measuredVoltage_V: Number((t.voltage_V ?? 0).toFixed(2)),
          measuredCurrent_A: Number((t.current_A ?? 0).toFixed(3)),
          measuredPower_W: Number((t.power_W ?? 0).toFixed(2)),
          mode: t.state?.mode || 'CV'
        };

        this.sweepState.points.push(pt);
        this.emit('sweep_point', pt);
        if (typeof opts.onPoint === 'function') {
          opts.onPoint(pt);
        }

        // Check if current limit threshold reached or CC mode entered
        if (pt.measuredCurrent_A >= limitA * 0.98 || (pt.mode === 'CC' && pt.measuredCurrent_A > 0.005)) {
          stopReason = `current_limit_reached (${pt.measuredCurrent_A.toFixed(3)} A >= ${limitA.toFixed(3)} A)`;
          break;
        }
      }
    } finally {
      this.sweepState.running = false;
      try {
        await this.setVoltage(0.0);
        if (!this.isMock) {
          await new Promise((r) => setTimeout(r, 350));
          await this.setVoltage(0.0);
          await new Promise((r) => setTimeout(r, 650));
        }
      } catch {}
      try {
        await this.setOutput(false);
        await this._pollTelemetry();
      } catch {}
    }

    return {
      points: this.sweepState.points,
      stopReason
    };
  }

  /**
   * Returns latest synchronous cached telemetry object.
   * @returns {Object}
   */
  getTelemetry() {
    return this.lastTelemetry;
  }

  /**
   * Returns current controller and transport status.
   * @returns {Object}
   */
  getStatus() {
    return {
      mode: this.isMock ? 'mock' : 'serial',
      connected: this.activeTransport.isOpen(),
      outputOn: this.outputOn,
      port: this.portName,
      inFlight: this.inFlight !== null,
      queueLength: this.highPriorityQueue.length + this.lowPriorityQueue.length
    };
  }

  /**
   * Starts cyclic background telemetry polling.
   * @param {number} [intervalMs]
   */
  startPolling(intervalMs) {
    if (intervalMs && intervalMs > 0) {
      this.pollingIntervalMs = intervalMs;
    }
    this.pollingEnabled = true;
    this._scheduleNextPoll();
  }

  /**
   * Stops cyclic background telemetry polling.
   */
  stopPolling() {
    this.pollingEnabled = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  _scheduleNextPoll() {
    if (!this.pollingEnabled) return;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
    }
    this.pollingTimer = setTimeout(() => {
      this._pollTelemetry().finally(() => {
        this._scheduleNextPoll();
      });
    }, this.pollingIntervalMs);

    if (typeof this.pollingTimer.unref === 'function') {
      this.pollingTimer.unref();
    }
  }

  _pollTelemetry() {
    // Polling deduplication: do not enqueue if a telemetry query is already waiting
    if (this.lowPriorityQueue.length > 0) {
      return Promise.resolve();
    }

    const frame = protocol.encodeTelemetryQuery(this.address);
    return this._enqueueTransaction({
      priority: 2,
      expectedCmd: protocol.COMMANDS.READ_TELEMETRY,
      address: this.address,
      frame,
      timeoutMs: this.timeoutMs,
      retries: 0
    }).catch(() => {
      // Telemetry poll drops silently on timeout
    });
  }

  _pollRawTelemetry() {
    const frame = protocol.encodeTelemetryQuery(this.address);
    return this._enqueueTransaction({
      priority: 1,
      expectedCmd: protocol.COMMANDS.READ_TELEMETRY,
      address: this.address,
      frame,
      timeoutMs: this.timeoutMs,
      retries: 1,
      skipCacheUpdate: true
    }).catch(() => this.lastTelemetry);
  }

  _enqueueTransaction(item) {
    return new Promise((resolve, reject) => {
      const effectiveTimeout = this.isMock ? item.timeoutMs : Math.max(item.timeoutMs || 500, 1500);
      const tx = Object.assign({}, item, { timeoutMs: effectiveTimeout, resolve, reject });
      if (tx.priority === 0) {
        this.highPriorityQueue.unshift(tx); // Emergency Stop jumps to head
      } else if (tx.priority === 1) {
        this.highPriorityQueue.push(tx);
      } else {
        this.lowPriorityQueue.push(tx);
      }
      this._processQueue();
    });
  }

  _processQueue() {
    if (this.inFlight !== null) return;

    let tx = null;
    if (this.highPriorityQueue.length > 0) {
      tx = this.highPriorityQueue.shift();
    } else if (this.lowPriorityQueue.length > 0) {
      tx = this.lowPriorityQueue.shift();
    }

    if (!tx) return;

    this.inFlight = tx;
    tx.timer = setTimeout(() => {
      this._handleTimeout(tx);
    }, tx.timeoutMs);

    if (typeof tx.timer.unref === 'function') {
      tx.timer.unref();
    }

    this._writeTransportFrame(tx);
  }

  _writeTransportFrame(tx) {
    try {
      const doWrite = () => {
        if (this.inFlight !== tx) return;
        const writeResult = this.activeTransport.write(tx.frame);
        if (writeResult && typeof writeResult.catch === 'function') {
          writeResult.catch((err) => {
            if (this.inFlight === tx) {
              clearTimeout(tx.timer);
              this.inFlight = null;
              if (typeof tx.reject === 'function') tx.reject(err);
              this._processQueue();
            }
          });
        }
      };

      if (this._openingPromise) {
        this._openingPromise.then(doWrite).catch(() => doWrite());
      } else {
        doWrite();
      }
    } catch (err) {
      if (this.inFlight === tx) {
        clearTimeout(tx.timer);
        this.inFlight = null;
        if (typeof tx.reject === 'function') tx.reject(err);
        this._processQueue();
      }
    }
  }

  _handleTimeout(tx) {
    if (this.inFlight !== tx) return;

    if (tx.retries > 0) {
      tx.retries--;
      tx.timer = setTimeout(() => this._handleTimeout(tx), tx.timeoutMs);
      if (typeof tx.timer.unref === 'function') {
        tx.timer.unref();
      }
      this._writeTransportFrame(tx);
      return;
    }

    this.inFlight = null;
    tx.reject(new Error(`Transaction timeout awaiting cmd 0x${tx.expectedCmd.toString(16)}`));
    this._emitError(new Error(`Communication timeout on address 0x${tx.address.toString(16)}`));
    this._processQueue();
  }

  _handleIncomingFrame(frame) {
    if (!this.inFlight) return;
    const tx = this.inFlight;

    // 1. Frame Start & Checksum verification
    const parsed = protocol.parseFrame(frame);
    if (!parsed.valid) return;

    // 2. Multi-field correlation against noise & 1/256 modulo-256 false checksum collisions
    if (parsed.address !== tx.address && tx.address !== 0x00 && parsed.address !== 0x00) {
      return;
    }
    if (parsed.cmd !== tx.expectedCmd) {
      return;
    }

    // Authenticated frame matching current transaction
    clearTimeout(tx.timer);
    this.inFlight = null;

    if (tx.expectedCmd === protocol.COMMANDS.RESPONSE_CHECK) {
      const decoded = protocol.decodeResponse(frame);
      if (decoded.success) {
        tx.resolve(decoded);
      } else if (!this.isMock && tx.retries > 0) {
        tx.retries--;
        this.inFlight = tx;
        setTimeout(() => {
          if (this.inFlight === tx) {
            tx.timer = setTimeout(() => this._handleTimeout(tx), tx.timeoutMs);
            if (typeof tx.timer.unref === 'function') tx.timer.unref();
            this._writeTransportFrame(tx);
          }
        }, 120);
        return;
      } else {
        tx.reject(new Error(decoded.message || 'Command rejected (0x90)'));
      }
    } else if (tx.expectedCmd === protocol.COMMANDS.READ_TELEMETRY) {
      const decoded = protocol.decodeTelemetry(frame);
      if (decoded.maxVoltage_V > 0 && decoded.maxPower_W > 0) {
        this.hardwareBounds = {
          maxVoltage_V: decoded.maxVoltage_V,
          maxPower_W: decoded.maxPower_W
        };
      }
      if (!tx.skipCacheUpdate) {
        this.lastTelemetry = decoded;
        this.emit('telemetry', decoded);
      }
      tx.resolve(decoded);
    } else {
      tx.resolve(frame);
    }

    this._processQueue();
  }

  /**
   * Cleanly closes controller, clears all queues and timers, and disconnects transports.
   * @returns {Promise<void>}
   */
  async close() {
    this.stopPolling();
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      const aborted = this.inFlight;
      this.inFlight = null;
      if (typeof aborted.reject === 'function') aborted.reject(new Error('Controller closed'));
    }
    while (this.highPriorityQueue.length > 0) {
      const tx = this.highPriorityQueue.shift();
      if (tx && typeof tx.reject === 'function') tx.reject(new Error('Controller closed'));
    }
    while (this.lowPriorityQueue.length > 0) {
      const tx = this.lowPriorityQueue.shift();
      if (tx && typeof tx.reject === 'function') tx.reject(new Error('Controller closed'));
    }
    await this.mockTransport.close();
    await this.serialTransport.close();
  }

  /**
   * Alias to close() for lifecycle compatibility.
   * @returns {Promise<void>}
   */
  destroy() {
    return this.close();
  }
}

module.exports = PowerController;
module.exports.PowerController = PowerController;
module.exports.MockTransport = MockTransport;
module.exports.SerialTransport = SerialTransport;
