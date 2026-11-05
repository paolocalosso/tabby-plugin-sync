# tabby-plugin-sync

Keep the installed [Tabby](https://github.com/Eugeny/tabby) plugins the same
on every machine.

Tabby can sync `config.yaml` — with its built-in Config sync, or with any
file sync tool (Syncthing, Koofr, Dropbox, Nextcloud…) — but the plugins you
install live in the plugins folder and aren't recorded anywhere, so every
new machine starts without them. This plugin writes the list of installed
plugins into `config.yaml`, and on each machine:

- installs the plugins that are missing
- updates plugins that are newer elsewhere
- removes plugins you uninstalled on another machine (optional)
- adds plugins you install here to the shared list

When it changes something it asks you to restart Tabby, since plugins load
at startup.

## Install

Install it on **every** machine (this one plugin can't install itself):
Settings → Plugins, search for **plugin-sync**, click Install, restart
Tabby. Make sure `config.yaml` is synced between the machines, through
Settings → Config sync or your file sync tool.

On the first machine, the plugin records what you have installed. On the
others, it installs whatever is missing, and adds what they had that the
first machine didn't. No plugins are removed on a machine's first sync.

## Settings

**Settings → Plugin sync** shows every plugin with its version in the
shared list and on this machine, and what will happen to it. From there
you can:

- turn the sync on or off
- choose whether plugins uninstalled elsewhere are removed here
- untick a plugin to stop syncing it on this machine only
- run a sync now and restart Tabby
- see the machines that share the list, and forget old ones

## Using a file sync tool

Tabby reads `config.yaml` only at startup and rewrites the whole file every
time it saves a setting. With a file sync tool that means changes coming
from another machine are ignored while Tabby runs, and then overwritten by
the next save.

With **Reload config.yaml when it changes on disk** turned on (the
default), this plugin watches the file and reloads Tabby's config when it
changes, so those changes are picked up live and no longer get lost. It
also re-reads the file before every sync. If `config.yaml` is a symlink
into a synced dotfiles folder, the plugin watches the real file. Encrypted
configs are never reloaded automatically, since that would ask for the
password each time.

## How it works

The shared list lives in `config.yaml` under `pluginSync.plugins`, with each
machine's last known state under `pluginSync.machines`. A sync is a
three-way merge between the shared list, the plugins installed here, and
what this machine had after its previous sync. That last part is what
tells the two cases apart: a plugin that is missing here because you
uninstalled it here (drop it from the list), or because it was installed
elsewhere (install it here).

Each Tabby installation gets an id, kept in
`plugins/plugin-sync-machine.json`. A fresh Tabby install with an empty
plugins folder is treated as a new machine, so it gets everything installed
instead of wiping the list for everyone.

Plugins symlinked into the plugins folder for development are never
upgraded or removed, and the plugin never removes itself.

Installs go through Tabby's own plugin manager, so the same rules apply:
only `tabby-*` and `terminus-*` packages from npm, with the versions in the
list.

## License

MIT © Paolo Calosso
