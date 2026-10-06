import { type App, Notice, type Plugin, PluginSettingTab, Setting, type TextComponent } from "obsidian";
import { type PluginSettings, validateIndexerUrl } from "./settings.ts";

export interface SettingsHost {
	settings: PluginSettings;
	saveSettings(next: PluginSettings): Promise<void>;
}

export class IndexerSettingTab extends PluginSettingTab {
	host: SettingsHost;

	constructor(app: App, plugin: Plugin & SettingsHost) {
		super(app, plugin);
		this.host = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Indexer URL")
			.setDesc("Only an HTTPS URL is accepted")
			.addText((text) => {
				text.setValue(this.host.settings.indexerUrl);
				text.inputEl.addEventListener("change", () => {
					void this.commit(text);
				});
			});
	}

	async commit(text: TextComponent): Promise<void> {
		const result = validateIndexerUrl(text.getValue());
		if (!result.ok) {
			text.setValue(this.host.settings.indexerUrl);
			new Notice("Only an HTTPS URL is accepted");
			return;
		}
		await this.host.saveSettings({ ...this.host.settings, indexerUrl: result.url });
		text.setValue(result.url);
	}
}
