import { 
    App, Plugin, PluginSettingTab, Setting, Notice, 
    requestUrl, TFile, TFolder, AbstractInputSuggest 
} from 'obsidian';

// --- INTERFACES ---
interface AddToVaultSettings {
    apiUrl: string;
    apiToken: string;
    syncInterval: number;
    folderPath: string;
    geminiKey: string;
    geminiModel: string;
    availableModels: string[];
    templatePath: string;
    useMultipass: boolean;
}

const DEFAULT_SETTINGS: AddToVaultSettings = {
    apiUrl: 'http://192.168.100.11:8000',
    apiToken: '',
    syncInterval: 5,
    folderPath: 'Inbox',
    geminiKey: '',
    geminiModel: '',
    availableModels: [],
    templatePath: '',
    useMultipass: false
}

// --- SUGGESTERS (AUTOCOMPLETE) ---
class FileSuggest extends AbstractInputSuggest<TFile> {
    constructor(app: App, textInputEl: HTMLInputElement) {
        super(app, textInputEl);
    }
    getSuggestions(inputStr: string): TFile[] {
        const files = this.app.vault.getMarkdownFiles();
        return files.filter(f => f.path.toLowerCase().includes(inputStr.toLowerCase()));
    }
    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.setText(file.path);
    }
    selectSuggestion(file: TFile): void {
        if (this.textInputEl) {
            this.textInputEl.value = file.path;
            this.textInputEl.dispatchEvent(new Event('input'));
        }
        this.close();
    }
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
    constructor(app: App, textInputEl: HTMLInputElement) {
        super(app, textInputEl);
    }
    getSuggestions(inputStr: string): TFolder[] {
        const folders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
        return folders.filter(f => f.path.toLowerCase().includes(inputStr.toLowerCase()));
    }
    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path === '/' ? 'Root (Main folder)' : folder.path);
    }
    selectSuggestion(folder: TFolder): void {
        if (this.textInputEl) {
            this.textInputEl.value = folder.path === '/' ? '' : folder.path;
            this.textInputEl.dispatchEvent(new Event('input'));
        }
        this.close();
    }
}

// --- MAIN PLUGIN CLASS ---
export default class AddToVaultPlugin extends Plugin {
    settings: AddToVaultSettings;

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new AddToVaultSettingTab(this.app, this));

        this.addCommand({
            id: 'fetch-inbox',
            name: 'Fetch notes from server',
            callback: () => this.fetchInbox()
        });

        this.addCommand({
            id: 'push-context-settings',
            name: 'Sync settings, template and context to server',
            callback: () => this.pushContextAndSettings()
        });

        // Automatic background fetch
        if (this.settings.syncInterval > 0) {
            this.registerInterval(window.setInterval(() => {
                this.fetchInbox();
            }, this.settings.syncInterval * 60 * 1000));
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async fetchInbox() {
        if (!this.settings.apiToken) return;
        try {
            const response = await requestUrl({
                url: `${this.settings.apiUrl}/inbox`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.settings.apiToken}` }
            });

            const data = response.json;
            if (!data.items || data.items.length === 0) return;

            let processed = 0;
            for (const item of data.items) {
                let folderPath = this.settings.folderPath || '/';
                const folder = this.app.vault.getAbstractFileByPath(folderPath);
                
                if (!folder && folderPath !== '/') {
                    try {
                        await this.app.vault.createFolder(folderPath);
                    } catch(e) {
                        console.error('Could not create folder:', e);
                    }
                }

                let filePath = folderPath === '/' ? item.filename : `${folderPath}/${item.filename}`;
                let fileExists = this.app.vault.getAbstractFileByPath(filePath);
                
                if (!fileExists) {
                    await this.app.vault.create(filePath, item.content);
                    await requestUrl({
                        url: `${this.settings.apiUrl}/inbox/${encodeURIComponent(item.filename)}`,
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${this.settings.apiToken}` }
                    });
                    processed++;
                }
            }
            if (processed > 0) new Notice(`Add To Vault: Fetched ${processed} new notes!`);
        } catch (error) {
            console.error('Fetch Error:', error);
        }
    }

    async pushContextAndSettings() {
        if (!this.settings.apiToken) {
            new Notice('Missing API Token for the server!');
            return;
        }

        try {
            // 1. Send Context (Filenames + Tags)
            const files = this.app.vault.getMarkdownFiles();
            const notesData = files.map(file => {
                const cache = this.app.metadataCache.getFileCache(file);
                let tags: string[] = [];

                if (cache) {
                    // Fetch from YAML Frontmatter
                    if (cache.frontmatter && cache.frontmatter.tags) {
                        const fmTags = cache.frontmatter.tags;
                        if (Array.isArray(fmTags)) {
                            tags.push(...fmTags);
                        } else if (typeof fmTags === 'string') {
                            tags.push(...fmTags.split(',').map(t => t.trim()));
                        }
                    }
                    // Fetch inline tags (e.g., #tag in body)
                    if (cache.tags) {
                        tags.push(...cache.tags.map(t => t.tag));
                    }
                }

                // Clean tags (remove # and duplicates)
                const cleanTags = [...new Set(tags.map(t => t.replace(/^#/, '').trim()))].filter(t => t.length > 0);

                return {
                    path: file.basename,
                    tags: cleanTags
                };
            });

            await requestUrl({
                url: `${this.settings.apiUrl}/update-index`,
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${this.settings.apiToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ notes: notesData })
            });

            // 2. Read local template
            let templateContent = "";
            if (this.settings.templatePath) {
                let tp = this.settings.templatePath;
                if (!tp.endsWith('.md')) {
                    tp += '.md';
                }

                const tplFile = this.app.vault.getAbstractFileByPath(tp);
                if (tplFile instanceof TFile) {
                    templateContent = await this.app.vault.read(tplFile);
                } else {
                    new Notice(`Warning: Could not find template "${tp}". Using default.`);
                    templateContent = `---\ntitle: "{title}"\nsource: "{url}"\n---\n\n# {title}\n{content}\n\nContext: {vault_context}`;
                }
            }

            // 3. Send Settings, Template and Toggles
            if (this.settings.geminiKey) {
                await requestUrl({
                    url: `${this.settings.apiUrl}/update-prefs`,
                    method: 'POST',
                    headers: { 
                        'Authorization': `Bearer ${this.settings.apiToken}`,
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        api_key: this.settings.geminiKey,
                        model: this.settings.geminiModel || "gemini-2.5-flash",
                        prompt_template: templateContent,
                        use_multipass: this.settings.useMultipass
                    })
                });
            }

            new Notice(`Success! Settings, tags, template, and context synced.`);
        } catch (error) {
            console.error(error);
            new Notice('Sync error. Ensure your server is running and reachable.');
        }
    }
}

// --- SETTINGS TAB ---
class AddToVaultSettingTab extends PluginSettingTab {
    plugin: AddToVaultPlugin;

    constructor(app: App, plugin: AddToVaultPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        containerEl.createEl('h2', {text: 'Server & Security'});

        new Setting(containerEl)
            .setName('API URL')
            .setDesc('Address to your self-hosted server (e.g. http://192.168.100.11:8000)')
            .addText(text => text
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Server API Token')
            .setDesc('Bearer token for authentication against your server.')
            .addText(text => text
                .setValue(this.plugin.settings.apiToken)
                .onChange(async (value) => {
                    this.plugin.settings.apiToken = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h2', {text: 'Artificial Intelligence (Gemini)'});

        new Setting(containerEl)
            .setName('Gemini API Key')
            .setDesc('Your private Google AI Studio key (securely stored on your server).')
            .addText(text => text
                .setValue(this.plugin.settings.geminiKey)
                .onChange(async (value) => {
                    this.plugin.settings.geminiKey = value;
                    await this.plugin.saveSettings();
                }))
            .addButton(btn => btn
                .setButtonText('Validate Key')
                .setCta()
                .onClick(async () => {
                    btn.setButtonText('Validating...');
                    try {
                        const res = await requestUrl({
                            url: `${this.plugin.settings.apiUrl}/validate-gemini`,
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ api_key: this.plugin.settings.geminiKey })
                        });
                        this.plugin.settings.availableModels = res.json.supported_models;
                        await this.plugin.saveSettings();
                        new Notice(`Success! Found ${this.plugin.settings.availableModels.length} models.`);
                        this.display(); 
                    } catch (e) {
                        new Notice('Could not validate the key.');
                    }
                    btn.setButtonText('Validate Key');
                }));

        if (this.plugin.settings.availableModels && this.plugin.settings.availableModels.length > 0) {
            new Setting(containerEl)
                .setName('Select LLM Model')
                .addDropdown(drop => {
                    this.plugin.settings.availableModels.forEach(m => drop.addOption(m, m));
                    drop.setValue(this.plugin.settings.geminiModel);
                    drop.onChange(async (value) => {
                        this.plugin.settings.geminiModel = value;
                        await this.plugin.saveSettings();
                    });
                });
        }

        containerEl.createEl('h2', {text: 'Folders & Templates'});

        new Setting(containerEl)
            .setName('Inbox Folder')
            .setDesc('Folder in your vault where new notes are saved. (Type to search)')
            .addText(text => {
                new FolderSuggest(this.app, text.inputEl);
                text.setValue(this.plugin.settings.folderPath)
                    .onChange(async (value) => {
                        this.plugin.settings.folderPath = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('LLM Prompt Template')
            .setDesc('Path to your .md file. Variables: {title}, {url}, {content}, {vault_context}. (Type to search)')
            .addText(text => {
                new FileSuggest(this.app, text.inputEl);
                text.setPlaceholder('Templates/InboxTemplate.md')
                    .setValue(this.plugin.settings.templatePath)
                    .onChange(async (value) => {
                        this.plugin.settings.templatePath = value;
                        await this.plugin.saveSettings();
                    });
            });

        containerEl.createEl('h2', {text: 'Advanced Settings'});

        new Setting(containerEl)
            .setName('Multi-Pass LLM Context (Beta)')
            .setDesc('When enabled, the server uses an extra LLM call to classify domain tags first, strictly isolating internal linking. Helps prevent irrelevant cross-linking.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useMultipass)
                .onChange(async (value) => {
                    this.plugin.settings.useMultipass = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('br');
        new Setting(containerEl)
            .setName('Manual Sync')
            .setDesc('Push updated template, keys, tags, and context to the server.')
            .addButton(btn => btn
                .setButtonText('Sync Everything Now')
                .setCta()
                .onClick(async () => {
                    await this.plugin.pushContextAndSettings();
                }));
    }
}
