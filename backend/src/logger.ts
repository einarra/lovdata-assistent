import pino from 'pino';
import { join } from 'node:path';
import { env } from './config/env.js';

// Base logger configuration
const baseConfig: pino.LoggerOptions = {
  level: env.LOG_LEVEL
};

// Configure logger based on environment
let logger: pino.Logger;

if (env.NODE_ENV === 'development') {
  // Development: use pretty printing to console
  // Create logger with pretty transport - this is async but pino handles it
  try {
    logger = pino({
      ...baseConfig,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          singleLine: false
        }
      }
    });
  } catch (err) {
    // Fallback to basic logger if transport fails
    console.error('Failed to initialize pino-pretty transport, using basic logger:', err);
    logger = pino(baseConfig);
  }
  
  // If LOG_FILE is set, also write JSON to file (but don't interfere with console output)
  if (env.LOG_FILE) {
    try {
      const logPath = env.LOG_FILE.startsWith('/') 
        ? env.LOG_FILE 
        : join(process.cwd(), env.LOG_FILE);
      
      // Create file stream for JSON logging
      const fileStream = pino.destination({
        dest: logPath,
        append: true,
        sync: false
      });
      
      // Create JSON logger for file
      const fileLogger = pino(baseConfig, fileStream);
      
      // Intercept all log methods to also write JSON to file
      // Use a more robust approach that preserves the original logger behavior
      const wrapLogMethod = (level: string) => {
        const original = (logger as any)[level].bind(logger);
        (logger as any)[level] = function(obj: any, msg?: string, ...args: any[]) {
          // Write JSON to file (async, don't block)
          try {
            if (typeof obj === 'string') {
              // If first arg is a string, it's the message
              (fileLogger as any)[level]({}, obj, ...args);
            } else if (obj && typeof obj === 'object') {
              // If first arg is an object
              (fileLogger as any)[level](obj, msg, ...args);
            } else {
              // No first arg, just message
              (fileLogger as any)[level](msg, ...args);
            }
          } catch (err) {
            // Don't let file logging errors break console logging
            // Silent fail for file logging
          }
          // Always write to console (pretty format)
          return original(obj, msg, ...args);
        };
      };
      
      ['info', 'warn', 'error', 'debug', 'trace', 'fatal'].forEach(wrapLogMethod);
    } catch (err) {
      // If file logging setup fails, just continue with console logging
      console.warn('Failed to setup file logging:', err);
    }
  }
} else {
  // Production: JSON format
  if (env.LOG_FILE) {
    const logPath = env.LOG_FILE.startsWith('/') 
      ? env.LOG_FILE 
      : join(process.cwd(), env.LOG_FILE);
    
    const fileStream = pino.destination({
      dest: logPath,
      append: true,
      sync: false
    });
    
    // Multistream: JSON to both stdout and file
    logger = pino(
      baseConfig,
      pino.multistream([
        { level: env.LOG_LEVEL, stream: process.stdout },
        { level: env.LOG_LEVEL, stream: fileStream }
      ])
    );
  } else {
    // Just JSON to stdout
    logger = pino(baseConfig);
  }
}

export { logger };
