import type { SecretStore } from "./context.ts";
import { fromBase64Url, toBase64Url } from "./encoding.ts";

export const SECRET_ID = "foliospindle-proof-app-key";

const SEED_LENGTH = 32;

export function readSeed(store: SecretStore): Uint8Array | null {
	const value = store.getSecret(SECRET_ID);
	if (value === null || value === "") {
		return null;
	}
	const seed = fromBase64Url(value);
	if (seed === null || seed.length !== SEED_LENGTH) {
		return null;
	}
	return seed;
}

export function storeSeed(store: SecretStore, seed: Uint8Array): void {
	store.setSecret(SECRET_ID, toBase64Url(seed, false));
}

export function clearSeed(store: SecretStore): boolean {
	const present = readSeed(store) !== null;
	store.setSecret(SECRET_ID, "");
	return present;
}
