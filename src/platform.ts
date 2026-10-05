import type { PlatformClass } from "./context.ts";

const IOS_VERSION_PATTERN = /OS (\d+)_(\d+)(?:_(\d+))?/;
const ANDROID_VERSION_PATTERN = /Android (\d+(?:\.\d+)*)/;

export interface PlatformFlags {
	isDesktopApp: boolean;
	isMobileApp: boolean;
	isIosApp: boolean;
	isAndroidApp: boolean;
	isMacOS: boolean;
}

export function classify(flags: PlatformFlags): PlatformClass {
	if (flags.isIosApp) {
		return "ios";
	}
	if (flags.isAndroidApp) {
		return "android";
	}
	if (flags.isDesktopApp) {
		return flags.isMacOS ? "macos" : "desktop-other";
	}
	return "unknown";
}

export function osVersionFromUa(cls: PlatformClass, ua: string): string {
	if (cls === "ios") {
		const match = IOS_VERSION_PATTERN.exec(ua);
		if (match === null) {
			return "unknown";
		}
		const [, major, minor, patch] = match;
		return [major, minor, patch].filter((part) => part !== undefined).join(".");
	}
	if (cls === "android") {
		const match = ANDROID_VERSION_PATTERN.exec(ua);
		return match?.[1] ?? "unknown";
	}
	return "not exposed";
}

export function approvalPresentation(cls: PlatformClass): "system-browser" | "selectable-text" {
	return cls === "macos" || cls === "desktop-other" ? "system-browser" : "selectable-text";
}
