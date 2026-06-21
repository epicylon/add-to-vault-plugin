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

    // LLM Provider Settings
    provider: string;
    apiKeys: Record<string, string>;
    selectedModels: Record<string, string>;
    availableModels: string[];

    // Templates
    templateArchivist: string;
    templateAnalyst: string;
    templateSynthesist: string;
    useMultipass: boolean;
}

const DEFAULT_SETTINGS: AddToVaultSettings = {
    apiUrl: 'http://192.168.100.11:8000',
    apiToken: '',
    syncInterval: 5,
    folderPath: 'Inbox',

    provider: 'gemini',
    apiKeys: {
        gemini: '',
        openai: '',
        anthropic: '',
        mistral: '',
        kimi: '',
        ollama: 'http://127.0.0.1:11434'
    },
    selectedModels: {
        gemini: '',
        openai: '',
        anthropic: '',
        mistral: '',
        kimi: '',
        ollama: ''
    },
    availableModels: [],

    templateArchivist: '',
    templateAnalyst: '',
    templateSynthesist: '',
    useMultipass: false
}

const PROVIDERS = [
    { id: 'gemini', name: 'Google Gemini', desc: 'Google AI Studio API Key' },
    { id: 'openai', name: 'OpenAI', desc: 'OpenAI API Key' },
    { id: 'anthropic', name: 'Anthropic', desc: 'Anthropic API Key' },
    { id: 'mistral', name: 'Mistral AI', desc: 'La Plateforme API Key' },
    { id: 'kimi', name: 'Kimi (Moonshot AI)', desc: 'Moonshot API Key' },
    { id: 'ollama', name: 'Ollama (Local)', desc: 'Your local Ollama URL (e.g. http://127.0.0.1:11434)' }
];

const DEFAULT_TEMPLATE = `---
title: "{title}"
source: "{url}"
---

# {title}
{content}

Context: {vault_context}`;

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
            name: 'Sync settings, templates and context to server',
            callback: () => this.pushContextAndSettings()
        });

        if (this.settings.syncInterval > 0) {
            this.registerInterval(window.setInterval(() => {
                this.fetchInbox();
            }, this.settings.syncInterval * 60 * 1000));
        }
    }

    async loadSettings() {
        const loaded = await this.loadData();
        const settings = Object.assign({}, DEFAULT_SETTINGS, loaded) as AddToVaultSettings;

        // Deep merge nested provider dictionaries so new providers get default empty strings
        if (loaded?.apiKeys) {
            settings.apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...loaded.apiKeys };
        }
        if (loaded?.selectedModels) {
            settings.selectedModels = { ...DEFAULT_SETTINGS.selectedModels, ...loaded.selectedModels };
        }

        // --- MIGRATION from old single-provider settings ---
        if (loaded?.geminiKey && !settings.apiKeys.gemini) {
            settings.apiKeys.gemini = loaded.geminiKey;
        }
        if (loaded?.geminiModel && !settings.selectedModels.gemini) {
            settings.selectedModels.gemini = loaded.geminiModel;
        }
        if (loaded?.templatePath && !settings.templateAnalyst) {
            settings.templateAnalyst = loaded.templatePath;
        }

        this.settings = settings;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async fetchInbox() {
        if (!this.settings.apiToken) return;
        try {
            const baseUrl = this.settings.apiUrl.replace(/\/$/, '');
            const response = await requestUrl({
                url: `${baseUrl}/inbox`,
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
                    try { await this.app.vault.createFolder(folderPath); } 
                    catch(e) { console.error('Could not create folder:', e); }
                }

                let filePath = folderPath === '/' ? item.filename : `${folderPath}/${item.filename}`;
                let fileExists = this.app.vault.getAbstractFileByPath(filePath);

                if (!fileExists) {
                    await this.app.vault.create(filePath, item.content);
                    await requestUrl({
                        url: `${baseUrl}/inbox/${encodeURIComponent(item.filename)}`,
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

    async readTemplateFile(path: string, modeName: string): Promise<string> {
        if (!path) return "";
        let tp = path;
        if (!tp.endsWith('.md')) tp += '.md';

        const tplFile = this.app.vault.getAbstractFileByPath(tp);
        if (tplFile instanceof TFile) {
            return await this.app.vault.read(tplFile);
        } else {
            new Notice(`Warning: Could not find template for ${modeName}. Please check settings.`);
            return "";
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
                    if (cache.frontmatter && cache.frontmatter.tags) {
                        const fmTags = cache.frontmatter.tags;
                        if (Array.isArray(fmTags)) {
                            tags.push(...fmTags);
                        } else if (typeof fmTags === 'string') {
                            tags.push(...fmTags.split(',').map(t => String(t).trim()));
                        }
                    }
                    if (cache.tags) {
                        tags.push(...cache.tags.map(t => t.tag));
                    }
                }

                const cleanTags = [...new Set(tags.map(t => String(t).replace(/^#/, '').trim()))].filter(t => t.length > 0);
                return { path: file.basename, tags: cleanTags };
            });

            const baseUrl = this.settings.apiUrl.replace(/\/$/, '');

            await requestUrl({
                url: `${baseUrl}/update-index`,
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${this.settings.apiToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ notes: notesData })
            });

            // 2. Read local templates
            const contentArchivist = await this.readTemplateFile(this.settings.templateArchivist, "Archivist");
            const contentAnalyst = await this.readTemplateFile(this.settings.templateAnalyst, "Analyst");
            const contentSynthesist = await this.readTemplateFile(this.settings.templateSynthesist, "Synthesist");

            // 3. Send Settings, Templates, and Active Provider configuration
            const activeProvider = this.settings.provider;
            const activeKey = this.settings.apiKeys[activeProvider] || '';
            const activeModel = this.settings.selectedModels[activeProvider] || '';

            // Build payload: only include templates that have content.
            // Always include prompt_template as a fallback for the backend.
            const payload: Record<string, any> = {
                api_key: activeKey,
                provider: activeProvider,
                model: activeModel,
                prompt_template: contentAnalyst || DEFAULT_TEMPLATE,
                use_multipass: this.settings.useMultipass
            };

            if (contentArchivist) payload.template_archivist = contentArchivist;
            if (contentAnalyst) payload.template_analyst = contentAnalyst;
            if (contentSynthesist) payload.template_synthesist = contentSynthesist;

            await requestUrl({
                url: `${baseUrl}/update-prefs`,
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${this.settings.apiToken}`,
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify(payload)
            });

            new Notice(`Success! Settings, templates, tags, and context synced.`);
        } catch (error) {
            console.error('Push Context Error:', error);
            new Notice('Sync error. Open developer console (Ctrl+Shift+I) for details.');
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

        // --- 1. SERVER ---
        containerEl.createEl('h2', {text: 'Server'});

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

        new Setting(containerEl)
            .setName('Manual Sync')
            .setDesc('Push updated templates, active provider configuration, tags, and context to the server.')
            .addButton(btn => btn
                .setButtonText('Sync Everything Now')
                .setCta()
                .onClick(async () => {
                    await this.plugin.pushContextAndSettings();
                }));

        // --- 2. FOLDERS ---
        containerEl.createEl('h2', {text: 'Folders'});

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

        // --- 3. PROCESSING MODE TEMPLATES ---
        containerEl.createEl('h2', {text: 'Processing Mode Templates'});
        containerEl.createEl('p', {text: 'Configure the .md files defining the prompt for each mode. Variables: {title}, {url}, {content}, {vault_context}.', cls: 'setting-item-description'});

        new Setting(containerEl)
            .setName('Archivist Template')
            .addText(text => {
                new FileSuggest(this.app, text.inputEl);
                text.setPlaceholder('Templates/Archivist.md')
                    .setValue(this.plugin.settings.templateArchivist)
                    .onChange(async (value) => {
                        this.plugin.settings.templateArchivist = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Analyst Template')
            .addText(text => {
                new FileSuggest(this.app, text.inputEl);
                text.setPlaceholder('Templates/Analyst.md')
                    .setValue(this.plugin.settings.templateAnalyst)
                    .onChange(async (value) => {
                        this.plugin.settings.templateAnalyst = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Synthesist Template')
            .addText(text => {
                new FileSuggest(this.app, text.inputEl);
                text.setPlaceholder('Templates/Synthesist.md')
                    .setValue(this.plugin.settings.templateSynthesist)
                    .onChange(async (value) => {
                        this.plugin.settings.templateSynthesist = value;
                        await this.plugin.saveSettings();
                    });
            });

        // --- 4. LLM PROVIDERS ---
        containerEl.createEl('h2', {text: 'LLM Providers'});
        containerEl.createEl('p', {text: 'Toggle the provider you want to use. Keys are saved securely. You must validate the key to select a model.', cls: 'setting-item-description'});

        PROVIDERS.forEach(p => {
            const isActive = this.plugin.settings.provider === p.id;

            new Setting(containerEl)
                .setName(p.name)
                .setDesc(isActive ? 'Active Provider' : 'Click to activate')
                .addToggle(toggle => toggle
                    .setValue(isActive)
                    .onChange(async (value) => {
                        if (value) {
                            this.plugin.settings.provider = p.id;
                            this.plugin.settings.availableModels = []; // Reset models on switch
                            await this.plugin.saveSettings();
                        }
                        // Always re-render to enforce single-active-provider UI state
                        this.display();
                    })
                );

            // Only render Key Input, Validate Button, and Dropdown if this provider is active
            if (isActive) {
                new Setting(containerEl)
                    .setName(p.id === 'ollama' ? 'Local URL' : 'API Key')
                    .setDesc(p.desc)
                    .addText(text => text
                        .setValue(this.plugin.settings.apiKeys[p.id])
                        .onChange(async (value) => {
                            this.plugin.settings.apiKeys[p.id] = value;
                            await this.plugin.saveSettings();
                        })
                    )
                    .addButton(btn => btn
                        .setButtonText('Validate Key')
                        .setCta()
                        .onClick(async () => {
                            btn.setButtonText('Validating...');
                            try {
                                const baseUrl = this.plugin.settings.apiUrl.replace(/\/$/, '');
                                const keyToValidate = this.plugin.settings.apiKeys[p.id];
                                const res = await requestUrl({
                                    url: `${baseUrl}/validate-provider`,
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ provider: p.id, api_key: keyToValidate })
                                });
                                this.plugin.settings.availableModels = res.json.supported_models;
                                await this.plugin.saveSettings();
                                new Notice(`Success! Found ${this.plugin.settings.availableModels.length} models.`);
                                this.display(); 
                            } catch (e) {
                                new Notice(`Could not validate the key/URL for ${p.name}.`);
                            }
                            btn.setButtonText('Validate Key');
                        })
                    );

                if (this.plugin.settings.availableModels && this.plugin.settings.availableModels.length > 0) {
                    new Setting(containerEl)
                        .setName('Select LLM Model')
                        .addDropdown(drop => {
                            this.plugin.settings.availableModels.forEach(m => drop.addOption(m, m));

                            // Set to previously saved model or default to the first one available
                            const currentModel = this.plugin.settings.selectedModels[p.id];
                            if (currentModel && this.plugin.settings.availableModels.includes(currentModel)) {
                                drop.setValue(currentModel);
                            } else {
                                drop.setValue(this.plugin.settings.availableModels[0]);
                                this.plugin.settings.selectedModels[p.id] = this.plugin.settings.availableModels[0];
                                this.plugin.saveSettings(); // fire-and-forget is acceptable here
                            }

                            drop.onChange(async (value) => {
                                this.plugin.settings.selectedModels[p.id] = value;
                                await this.plugin.saveSettings();
                            });
                        });
                }
            }
        });

        // --- 5. ADVANCED SETTINGS ---
        containerEl.createEl('h2', {text: 'Advanced Settings'});

        new Setting(containerEl)
            .setName('Multi-Pass LLM Context (Recommended)')
            .setDesc('When enabled, the server uses an extra LLM call to classify domain tags first, strictly isolating internal linking. Helps prevent irrelevant cross-linking.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useMultipass)
                .onChange(async (value) => {
                    this.plugin.settings.useMultipass = value;
                    await this.plugin.saveSettings();
                }));
    }
}
