'use strict';

const { createLogger, format, transports } = require('winston');
const Transport = require('winston-transport');

// ── In-memory ring buffer (configurable size, set during initLogger) ───────────

let _logBufferMax = 500;   // overridden in initLogger() from config.log_buffer_size
const _logBuffer    = [];
const _logListeners = new Set();

/**
 * Custom Winston transport that accumulates log entries in a ring buffer and
 * notifies live listeners (used by the WebSocket API to stream logs to the panel).
 */
class RingBufferTransport extends Transport {
  constructor(opts) { super(opts); }

  log(info, callback) {
    // Extract channel from the leading [xxx] prefix in the message (e.g. "[devices] ...")
    const _msg = info.message ?? '';
    const chanMatch = _msg.match(/^\[([^\]]+)\]/);
    const rawChan   = chanMatch?.[1] ?? 'system';
    const CHAN_MAP  = {
      main:      'system',
      zigbee:    'network',
      devices:   'devices',
      ws:        'websocket',
      avail:     'availability',
      configure: 'configure',
      command:   'command',
      message:   'messages',
      event:     'system',
    };
    const channel = CHAN_MAP[rawChan] ?? rawChan;

    const entry = {
      ts:      info.timestamp ?? new Date().toISOString(),
      // Symbol.for('level') holds the raw (un-colourised) level string in Winston 3
      level:   info[Symbol.for('level')] ?? info.level ?? 'info',
      channel,
      msg:     _msg,
    };
    _logBuffer.push(entry);
    if (_logBuffer.length > _logBufferMax) _logBuffer.shift();
    for (const cb of _logListeners) {
      try { cb(entry); } catch (_) { /* never let a listener crash the logger */ }
    }
    this.emit('logged', info);
    callback();
  }
}

/** Return a copy of the current log buffer. */
function getLogs()        { return [..._logBuffer]; }
/** Clear the log buffer. */
function clearLogs()      { _logBuffer.length = 0; }
/** Register a callback invoked on every new log entry. */
function onLogEntry(cb)   { _logListeners.add(cb); }
/** Deregister a previously-registered callback. */
function offLogEntry(cb)  { _logListeners.delete(cb); }

// ── Winston logger ────────────────────────────────────────────────────────────

let _logger = null;

/**
 * Initialise the global logger. Call once at startup.
 * @param {string} level  - 'debug' | 'info' | 'warning' | 'error'
 */
function initLogger(level = 'info', bufferSize = 500) {
  _logBufferMax = bufferSize;
  const winstonLevel = level === 'warning' ? 'warn' : level;

  _logger = createLogger({
    level: winstonLevel,
    format: format.combine(
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;
      })
    ),
    transports: [
      new transports.Console(),
      new RingBufferTransport(),
    ],
  });

  return _logger;
}

function getLogger() {
  if (!_logger) initLogger();
  return _logger;
}

module.exports = { initLogger, getLogger, getLogs, clearLogs, onLogEntry, offLogEntry };
