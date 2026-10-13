/**
 * settings.js
 *
 * Node-RED Runtime Configuration for Array 364X / 3600 Series Power Supply Controller
 * Sandbox Isolated Environment: c:\GOOGLE PROJEKTEK\ArrayPWR
 */

'use strict';

const path = require('path');
const fs = require('fs');
const protocol = require('./lib/array_protocol');
const MockPowerSupply = require('./lib/mock_power_supply');
const PowerController = require('./lib/power_controller');

// Ensure logs directory exists for CSV logging
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {}
}

// Create singleton controller instance (defaults to COM3 @ 19200 baud, Addr 0x00)
const arrayPowerController = new PowerController({
  address: 0x00,
  isMock: false,
  portName: 'COM3',
  baudRate: 19200,
  pollingIntervalMs: 500,
  limits: {
    maxVoltage_V: 36.0,
    maxCurrent_A: 3.0,
    maxPower_W: 108.0
  }
});

module.exports = {
  uiPort: 1880,
  uiHost: '0.0.0.0',

  // Flow file configuration
  flowFile: 'flows.json',
  flowFilePretty: true,

  // Sandbox directory isolation
  userDir: __dirname,

  // Serve Dashboard at /ui
  ui: { path: 'ui' },

  // Editor configuration
  editorTheme: {
    projects: {
      enabled: false
    },
    page: {
      title: 'Array 364X Power Supply Controller'
    },
    header: {
      title: 'Array 364X / 3600 Series Controller'
    },
    tours: false
  },

  // Disable external telemetry
  telemetry: {
    enabled: false
  },

  // Logging configuration
  logging: {
    console: {
      level: 'info',
      metrics: false,
      audit: false
    }
  },

  // Inject Array Power Supply modules & controller into Node-RED global context
  functionGlobalContext: {
    arrayPower: arrayPowerController,
    ArrayPower: arrayPowerController,
    PowerController: PowerController,
    MockPowerSupply: MockPowerSupply,
    arrayProtocol: protocol,
    fs: fs,
    path: path,
    logsDir: logsDir
  },

  exportGlobalContextKeys: false
};
