export interface DeadlineTimers {
	set(callback: () => void, ms: number): number;
	clear(handle: number): void;
}

export class DeadlineError extends Error {
	step: string;
	ms: number;

	constructor(step: string, ms: number) {
		super(`${step} did not complete within ${ms} ms`);
		this.name = "DeadlineError";
		this.step = step;
		this.ms = ms;
	}
}

const WINDOW_TIMERS: DeadlineTimers = {
	set(callback, ms) {
		return window.setTimeout(callback, ms);
	},
	clear(handle) {
		window.clearTimeout(handle);
	},
};

export async function withDeadline<T>(promise: Promise<T>, ms: number, step: string, timers: DeadlineTimers = WINDOW_TIMERS): Promise<T> {
	let handle = 0;
	const deadline = new Promise<never>((_, reject) => {
		handle = timers.set(() => reject(new DeadlineError(step, ms)), ms);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		timers.clear(handle);
	}
}
