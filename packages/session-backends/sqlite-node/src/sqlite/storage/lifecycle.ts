export interface TimerHandle {
	unref?(): void;
}

export interface TimerFactory {
	schedule(callback: () => void, delayMs: number): TimerHandle;
	cancel(handle: TimerHandle): void;
}

export const nativeTimerFactory: TimerFactory = {
	schedule(callback, delayMs) {
		return setTimeout(callback, delayMs);
	},
	cancel(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};
