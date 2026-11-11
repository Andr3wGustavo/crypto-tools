import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string, service = 'worker'): Logger {
  return pino({ level, base: { service }, timestamp: pino.stdTimeFunctions.isoTime });
}
