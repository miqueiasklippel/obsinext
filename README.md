# Obsinext

Sync your Obsidian vault with a folder on your **Nextcloud** server over WebDAV.
Works on desktop (Linux, Windows, macOS) and mobile (Android, iOS).

> The plugin interface is currently in Brazilian Portuguese. Documentação em português: [README.pt-BR.md](README.pt-BR.md).

## Features

- Two-way sync between the vault and a Nextcloud folder of your choice.
- Change detection by local modification time and size plus the Nextcloud ETag, so only changed files are transferred.
- Conflict handling without data loss: when a file changes on both sides, the server version is kept as `note (conflito YYYY-MM-DD HHMMSS).md` next to the local one.
- Optional confirmation before deletions reach Nextcloud, both when you delete a note or folder and when a sync is about to delete files on the server.
- Safeguards against accidental mass deletion: a configurable deletion limit and a stop when either side suddenly appears empty.
- The app password is stored in Obsidian's secret storage, not in the plugin's configuration file.
- Manual sync (ribbon icon or command), automatic sync every *N* minutes, and sync on startup.

## Requirements

- Obsidian 1.11.4 or later.
- A Nextcloud account and an **app password** (*Personal settings → Security → Devices & sessions*).

## Installation

From Obsidian: *Settings → Community plugins → Browse*, search for **Obsinext**, then install and enable it.

Manual installation: download `main.js`, `manifest.json` and `styles.css` from the latest release and copy them to `<vault>/.obsidian/plugins/obsinext/`.

## Setup

1. Open *Settings → Obsinext*.
2. Fill in:
   - **Server address**: only the root of your Nextcloud, using HTTPS (for example, `https://cloud.example.com`).
   - **Username**: your Nextcloud login.
   - **App password**: pick or create a secret in Obsidian's secret storage.
   - **Remote folder**: the Nextcloud folder that will mirror the vault. It is created if it does not exist.
3. Select **Testar conexão** (Test connection).

## How sync works

| Situation | Action |
|---|---|
| Changed only in the vault | Uploaded to Nextcloud |
| Changed only on Nextcloud | Downloaded to the vault |
| Changed on both sides | Conflict copy of the server version, local version kept and uploaded |
| New file on one side | Copied to the other side |
| Deleted in the vault | Deleted on Nextcloud (after confirmation, if enabled) |
| Deleted on Nextcloud | Local file moved to the vault's `.trash` folder |
| Deleted on one side and changed on the other | The changed version is restored |

On the first sync, files that exist on both sides are compared byte by byte. If they differ, a conflict copy is created and nothing is overwritten.

## Disclosures

- **Network use**: the plugin connects only to the Nextcloud server you configure. It uses the Nextcloud WebDAV endpoint (`/remote.php/dav/files/…`) to list, upload, download and delete files in the chosen folder, and the OCS API (`/ocs/v2.php/cloud/user`) to verify credentials and find your user ID. No other remote services are contacted.
- **Account**: a Nextcloud account on a server of your choice is required.
- **Payment**: free. No payment is required.
- **Telemetry**: none.
- **Files outside the vault**: the plugin does not access files outside the vault.

## Security

- HTTPS is required. Plain HTTP is accepted only for `localhost`.
- Sync of the account's root folder is not allowed; a remote folder is mandatory.
- Remote file names containing `..`, backslashes or control characters are ignored.
- Server-side deletions use `If-Match` with the last known ETag. A file changed on Nextcloud since the last sync is never deleted; it is restored to the vault instead.
- Local deletions go to the vault's `.trash` folder; server deletions go to the Nextcloud trash bin.
- Changing the server, user or remote folder resets the sync history automatically.

## Known limitations

- Hidden files and folders, including the `.obsidian` configuration folder, are not synced.
- Empty folders are not created or deleted.
- Renaming a file is handled as a deletion followed by a creation.
- Transfers run one at a time.

## Building from source

```bash
npm install
npm run build
```

Requires Node.js 18 or later.

## License

[MIT](LICENSE)
