import { type App, Modal, Setting } from "obsidian";

const MIN_COLS = 20;
const MAX_COLS = 40;
const MIN_ROWS = 3;
const MAX_ROWS = 30;

function sizeFor(text: string): { rows: number; cols: number } {
	const lines = text.split("\n");
	const longest = Math.max(...lines.map((line) => line.length));
	const cols = Math.min(Math.max(longest, MIN_COLS), MAX_COLS);
	let rows = 0;
	for (const line of lines) {
		rows += Math.max(Math.ceil(line.length / cols), 1);
	}
	return { rows: Math.min(Math.max(rows, MIN_ROWS), MAX_ROWS), cols };
}

function plainTextarea(parent: HTMLElement, rows: number, cols: number): HTMLTextAreaElement {
	const area = parent.createEl("textarea");
	area.rows = rows;
	area.cols = cols;
	area.spellcheck = false;
	area.autocapitalize = "off";
	area.setAttr("autocorrect", "off");
	return area;
}

export class TextModal extends Modal {
	titleText: string;
	text: string;
	textarea: HTMLTextAreaElement | null;

	constructor(app: App, title: string, text: string) {
		super(app);
		this.titleText = title;
		this.text = text;
		this.textarea = null;
	}

	onOpen(): void {
		this.setTitle(this.titleText);
		const { rows, cols } = sizeFor(this.text);
		const area = plainTextarea(this.contentEl, rows, cols);
		area.readOnly = true;
		area.value = this.text;
		this.textarea = area;
	}

	onClose(): void {
		if (this.textarea) {
			this.textarea.value = "";
			this.textarea = null;
		}
		this.text = "";
		this.contentEl.empty();
	}
}

export class TextEntryModal extends Modal {
	titleText: string;
	onResult: (text: string | null) => void;
	settled: boolean;
	textarea: HTMLTextAreaElement | null;

	constructor(app: App, title: string, onResult: (text: string | null) => void) {
		super(app);
		this.titleText = title;
		this.onResult = onResult;
		this.settled = false;
		this.textarea = null;
	}

	onOpen(): void {
		this.setTitle(this.titleText);
		const area = plainTextarea(this.contentEl, 6, MAX_COLS);
		this.textarea = area;
		new Setting(this.contentEl).addButton((button) => {
			button.setButtonText("Save").setCta().onClick(() => {
				this.settle(area.value);
				this.close();
			});
		});
	}

	onClose(): void {
		this.settle(null);
		if (this.textarea) {
			this.textarea.value = "";
			this.textarea = null;
		}
		this.contentEl.empty();
	}

	settle(value: string | null): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.onResult(value);
	}
}
