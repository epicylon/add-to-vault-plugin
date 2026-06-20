# Add To Vault (Obsidian Plugin)
The official companion plugin for the self-hosted **[Add To Vault](https://github.com/epicylon/add-to-vault)** service. This plugin securely bridges your local Obsidian vault with your external AI processing server.

**Transparency Notice:** *This project is "vibe-coded"*. The architecture, logic, and build configuration were primarily written by Google's Gemini Pro under the direction of a human project manager.

## Overview
This plugin sits quietly in your Obsidian vault to perform two main tasks: securely pushing your vault's index to the server (enabling context-aware AI linking), and periodically pulling newly generated markdown summaries from your self-hosted server directly into your local inbox.

## Installation
You can install the Add To Vault plugin in two ways:

**1. Community Plugins (Recommended)**
* Open Obsidian Settings -> Community Plugins.
* Turn off "Safe Mode" if you haven't already.
* Click "Browse" and search for **Add To Vault**.
* Install and enable the plugin.

**2. Manual Installation (Releases)**
* Go to the [Releases](https://github.com/yourusername/add-to-vault-plugin/releases) tab of this repository.
* Download the latest `main.js` and `manifest.json` files.
* Place both files inside a new folder at `your-vault/.obsidian/plugins/add-to-vault/`.
* Restart Obsidian and enable the plugin in your settings.

## Backend Server Requirements
This plugin requires an active, self-hosted instance of the backend server to function. Please refer to the main repository for backend setup instructions:

**[Add To Vault Server Repository](https://github.com/epicylon/add-to-vault)**
