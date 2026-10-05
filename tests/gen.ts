export type Gen = {
	readonly seed: number;
	bool(): boolean;
	int(lo: number, hi: number): number;
	bytes(n: number): Uint8Array;
	pick<T>(list: readonly T[]): T;
	string(alphabet: string, n: number): string;
};

export const SEED_BASE = 20261005;

const scramble = (seed: number): number => {
	let x = seed >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return (x ^ (x >>> 16)) >>> 0;
};

export function makeGen(seed: number): Gen {
	let state = scramble(seed) || 0x9e3779b9;
	const next = (): number => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state;
	};
	const int = (lo: number, hi: number): number => lo + Math.floor((next() / 2 ** 32) * (hi - lo + 1));
	return {
		seed,
		bool: () => int(0, 1) === 1,
		int,
		bytes: (n) => {
			const out = new Uint8Array(n);
			let word = 0;
			for (let i = 0; i < n; i += 1) {
				if (i % 4 === 0) {
					word = next();
				}
				out[i] = word & 0xff;
				word >>>= 8;
			}
			return out;
		},
		pick: <T>(list: readonly T[]): T => {
			if (list.length === 0) {
				throw new RangeError("pick needs a non-empty list");
			}
			return list[int(0, list.length - 1)] as T;
		},
		string: (alphabet, n) => {
			let out = "";
			for (let i = 0; i < n; i += 1) {
				out += alphabet.charAt(int(0, alphabet.length - 1));
			}
			return out;
		},
	};
}

export async function forAll(iterations: number, body: (g: Gen) => void | Promise<void>): Promise<void> {
	for (let i = 0; i < iterations; i += 1) {
		const g = makeGen(SEED_BASE + i);
		try {
			await body(g);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw Object.assign(new Error(`seed=${g.seed}: ${detail}`), { cause: error });
		}
	}
}
