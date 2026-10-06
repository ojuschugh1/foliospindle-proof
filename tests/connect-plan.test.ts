import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConnectPlan, type ConnectResult, type EntryOutcome, buildConnectResult, planConnect } from "../src/commands/connect.ts";

type RegisterOutcome = "resolves" | "rejects";
type ConnectFields = Omit<ConnectResult, "publicKeyHex">;

interface RecordInput {
	reconnecting: boolean;
	entryOutcome: EntryOutcome | null;
	plan: ConnectPlan;
	registerOutcome: RegisterOutcome;
}

const ENTRY_OUTCOMES: EntryOutcome[] = ["cancelled", "invalid", "mismatch", "match"];
const PLANS: ConnectPlan[] = ["registerFresh", "registerWith", "refuse"];
const REGISTER_OUTCOMES: RegisterOutcome[] = ["resolves", "rejects"];
const PLAN_ENTRIES: Record<ConnectPlan, Pick<RecordInput, "reconnecting" | "entryOutcome">> = {
	registerFresh: { reconnecting: false, entryOutcome: null },
	registerWith: { reconnecting: true, entryOutcome: "match" },
	refuse: { reconnecting: true, entryOutcome: "mismatch" },
};
const APP_ID = "0123456789abcdef".repeat(4);
const PUBLIC_KEY_HEX = "ab12cd";

const expectedPlan = (reconnecting: boolean, entryOutcome: EntryOutcome | null): ConnectPlan =>
	!reconnecting ? "registerFresh" : entryOutcome === "match" ? "registerWith" : "refuse";

const expectedKey = (plan: ConnectPlan, registerOutcome: RegisterOutcome): string =>
	(plan === "registerFresh" || plan === "registerWith") && registerOutcome === "resolves" ? PUBLIC_KEY_HEX : "";

function expectedStep(entryOutcome: EntryOutcome | null, registerOutcome: RegisterOutcome): string | null {
	if (entryOutcome === "cancelled" || entryOutcome === "invalid") {
		return "phrase-entry";
	}
	if (entryOutcome === "mismatch") {
		return "matchesExistingAppKey";
	}
	return registerOutcome === "rejects" ? "register" : null;
}

const fieldsFor = (input: RecordInput, seedStored: boolean): ConnectFields => ({
	indexerUrl: "https://sia.storage",
	appId: APP_ID,
	approvalPresentation: "system-browser",
	requestConnectionMs: 10,
	approvalWaitMs: 20,
	reconnecting: input.reconnecting,
	plan: input.plan,
	entryOutcome: input.entryOutcome,
	seedStored,
	replacedPreviousSeed: false,
	secretId: "foliospindle-proof-app-key",
});

function recordInputs(): RecordInput[] {
	const inputs: RecordInput[] = [];
	for (const entryOutcome of ENTRY_OUTCOMES) {
		for (const registerOutcome of REGISTER_OUTCOMES) {
			inputs.push({ reconnecting: true, entryOutcome, plan: planConnect(true, entryOutcome), registerOutcome });
		}
	}
	for (const registerOutcome of REGISTER_OUTCOMES) {
		inputs.push({ reconnecting: false, entryOutcome: null, plan: planConnect(false, null), registerOutcome });
	}
	for (const plan of PLANS) {
		for (const registerOutcome of REGISTER_OUTCOMES) {
			inputs.push({ ...PLAN_ENTRIES[plan], plan, registerOutcome });
		}
	}
	return inputs;
}

test("foliospindle-proof Property 9: Connect branch selection", () => {
	let visited = 0;
	for (const reconnecting of [false, true]) {
		for (const entryOutcome of ENTRY_OUTCOMES) {
			assert.equal(planConnect(reconnecting, entryOutcome), expectedPlan(reconnecting, entryOutcome), `(${reconnecting}, ${entryOutcome})`);
			visited += 1;
		}
	}
	assert.equal(visited, 8);
	assert.equal(planConnect(false, null), "registerFresh");

	const inputs = recordInputs();
	assert.equal(inputs.length, 16);
	for (const input of inputs) {
		const { reconnecting, entryOutcome, plan, registerOutcome } = input;
		const label = `(${reconnecting}, ${entryOutcome}, ${plan}, ${registerOutcome})`;
		assert.equal(planConnect(reconnecting, entryOutcome), plan, label);
		const registered = registerOutcome === "resolves";
		const key = expectedKey(plan, registerOutcome);
		const fields = fieldsFor(input, key !== "");
		const before = { ...fields };
		const result = buildConnectResult(fields, plan, registered, PUBLIC_KEY_HEX);
		assert.equal(result.publicKeyHex, key, label);
		assert.equal(result.publicKeyHex !== "", plan !== "refuse" && registered, label);
		assert.deepEqual(result, { ...fields, publicKeyHex: key }, label);
		assert.deepEqual(fields, before, label);
		assert.equal("publicKeyHex" in fields, false, label);
		assert.notEqual(result, fields, label);
		const step = expectedStep(entryOutcome, registerOutcome);
		assert.equal(step === null, result.publicKeyHex !== "", label);
		assert.equal(step === "register", plan !== "refuse" && !registered, label);
		assert.equal(step === "phrase-entry", entryOutcome === "cancelled" || entryOutcome === "invalid", label);
		assert.equal(step === "matchesExistingAppKey", entryOutcome === "mismatch", label);
		assert.equal(step === "phrase-entry" || step === "matchesExistingAppKey", plan === "refuse", label);
	}
});

test("buildConnectResult copies the fields and carries the key only after a successful register", () => {
	const fields = fieldsFor({ reconnecting: true, entryOutcome: "match", plan: "registerWith", registerOutcome: "resolves" }, true);
	assert.equal(buildConnectResult(fields, "registerWith", true, PUBLIC_KEY_HEX).publicKeyHex, PUBLIC_KEY_HEX);
	assert.equal(buildConnectResult(fields, "registerFresh", true, PUBLIC_KEY_HEX).publicKeyHex, PUBLIC_KEY_HEX);
	assert.equal(buildConnectResult(fields, "registerWith", false, PUBLIC_KEY_HEX).publicKeyHex, "");
	assert.equal(buildConnectResult(fields, "refuse", true, PUBLIC_KEY_HEX).publicKeyHex, "");
	assert.equal("publicKeyHex" in fields, false);
});
