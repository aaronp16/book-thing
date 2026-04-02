export function logKoboRequest(message: string, details?: Record<string, unknown>) {
	if (details) {
		console.log(`[kobo] ${message}`, details);
		return;
	}
	console.log(`[kobo] ${message}`);
}

export function logKoboError(message: string, error: unknown, details?: Record<string, unknown>) {
	if (details) {
		console.error(`[kobo] ${message}`, details, error);
		return;
	}
	console.error(`[kobo] ${message}`, error);
}
