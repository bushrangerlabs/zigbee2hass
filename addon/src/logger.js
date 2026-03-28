'use strict';

const { createLogger, format, transports } = require('winston');

let _logger = null;

/**
 * Initialise the global logger. Call once at startup.
 * @param {string} level  - 'debug' | 'info' | 'warning' | 'error'
 */
function initLogger(level = 'info') {
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
    transports: [new transports.Console()],
  });

  return _logger;
}

function getLogger() {
  if (!_logger) initLogger();
  return _logger;
}

module.exports = { initLogger, getLogger };
