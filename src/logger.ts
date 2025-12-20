export function logInfo(message: string, meta?: Record<string, unknown>) {
  if (meta) console.info(message, meta);
  else console.info(message);
}

export function logError(message: string, error?: unknown) {
  if (error instanceof Error) {
    console.error(message, { message: error.message, stack: error.stack });
  } else {
    console.error(message, error);
  }
}
