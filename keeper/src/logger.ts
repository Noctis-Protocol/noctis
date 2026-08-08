/**
 * @file Logging configuration
 * @description Winston logger setup for keeper service
 */

import winston from 'winston';

// Default logging configuration
const LOGGING = {
  LEVEL: process.env.LOG_LEVEL || 'info',
  FILE_ENABLED: process.env.LOG_FILE_ENABLED === 'true',
  FILE_PATH: process.env.LOG_FILE_PATH || 'logs/keeper.log',
};

/**
 * Create logger instance
 */
export const logger = winston.createLogger({
  level: LOGGING.LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'noctis-keeper' },
  transports: [
    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(
          ({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
            return `${timestamp} [${level}]: ${message} ${metaStr}`;
          }
        )
      ),
    }),
  ],
});

// Add file transport if enabled
if (LOGGING.FILE_ENABLED) {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    })
  );
  logger.add(
    new winston.transports.File({
      filename: LOGGING.FILE_PATH,
    })
  );
}

export default logger;
