export class SqliteFileQueue {
	#tail: Promise<void> = Promise.resolve();

	enqueue<T>(job: () => T | Promise<T>): Promise<T> {
		const result = this.#tail.then(job);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	drain(): Promise<void> {
		return this.#tail;
	}
}
