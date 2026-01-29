type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG" | "ALERT";

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function log(level: LogLevel, message: string, data?: any): void {
  const timestamp = formatTimestamp();
  const prefix = `[APEX] ${timestamp} [${level}]`;
  
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  info: (message: string, data?: any) => log("INFO", message, data),
  warn: (message: string, data?: any) => log("WARN", message, data),
  error: (message: string, data?: any) => log("ERROR", message, data),
  debug: (message: string, data?: any) => log("DEBUG", message, data),
  alert: (message: string, data?: any) => log("ALERT", message, data),
};
