import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlatformClass } from "../src/context.ts";
import { approvalPresentation, classify, osVersionFromUa, type PlatformFlags } from "../src/platform.ts";

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const ELECTRON_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) obsidian/1.11.4 Chrome/138.0.7204.97 Electron/37.2.3 Safari/537.36";

const flagsOf = (bits: number): PlatformFlags => ({
	isDesktopApp: (bits & 1) !== 0,
	isMobileApp: (bits & 2) !== 0,
	isIosApp: (bits & 4) !== 0,
	isAndroidApp: (bits & 8) !== 0,
	isMacOS: (bits & 16) !== 0,
});

const referenceClass = (flags: PlatformFlags): PlatformClass =>
	flags.isIosApp
		? "ios"
		: flags.isAndroidApp
			? "android"
			: flags.isDesktopApp
				? (flags.isMacOS ? "macos" : "desktop-other")
				: "unknown";

test("classify maps every flag combination to the expected class", () => {
	for (let bits = 0; bits < 32; bits += 1) {
		const flags = flagsOf(bits);
		assert.equal(classify(flags), referenceClass(flags), `flags ${JSON.stringify(flags)}`);
	}
	assert.equal(classify({ isDesktopApp: true, isMobileApp: false, isIosApp: false, isAndroidApp: false, isMacOS: true }), "macos");
	assert.equal(classify({ isDesktopApp: false, isMobileApp: true, isIosApp: true, isAndroidApp: false, isMacOS: false }), "ios");
	assert.equal(classify({ isDesktopApp: false, isMobileApp: true, isIosApp: false, isAndroidApp: true, isMacOS: false }), "android");
	assert.equal(classify({ isDesktopApp: true, isMobileApp: false, isIosApp: false, isAndroidApp: false, isMacOS: false }), "desktop-other");
	assert.equal(classify({ isDesktopApp: false, isMobileApp: false, isIosApp: false, isAndroidApp: false, isMacOS: false }), "unknown");
});

test("osVersionFromUa reads the iOS, Android and Electron user agents", () => {
	assert.equal(osVersionFromUa("ios", IOS_UA), "26.4");
	assert.equal(osVersionFromUa("ios", IOS_UA.replace("OS 26_4", "OS 26_4_1")), "26.4.1");
	assert.equal(osVersionFromUa("android", ANDROID_UA), "15");
	assert.equal(osVersionFromUa("macos", ELECTRON_UA), "not exposed");
	assert.equal(osVersionFromUa("desktop-other", ELECTRON_UA), "not exposed");
	assert.equal(osVersionFromUa("unknown", ELECTRON_UA), "not exposed");
	assert.equal(osVersionFromUa("ios", ANDROID_UA), "unknown");
	assert.equal(osVersionFromUa("ios", ELECTRON_UA), "unknown");
	assert.equal(osVersionFromUa("android", IOS_UA), "unknown");
});

test("approvalPresentation per class", () => {
	assert.equal(approvalPresentation("macos"), "system-browser");
	assert.equal(approvalPresentation("desktop-other"), "system-browser");
	assert.equal(approvalPresentation("ios"), "selectable-text");
	assert.equal(approvalPresentation("android"), "selectable-text");
	assert.equal(approvalPresentation("unknown"), "selectable-text");
});
