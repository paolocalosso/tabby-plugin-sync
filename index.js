/*
 * tabby-plugin-sync — keeps the installed Tabby plugins in sync across
 * machines through config.yaml.
 *
 * Tabby can sync config.yaml (built-in Config sync, or any file sync such
 * as Syncthing/Koofr/Dropbox), but the installed plugins live in the
 * plugins folder and aren't recorded anywhere. This plugin writes the list
 * of installed plugins into config.yaml (`pluginSync.plugins`) and, on each
 * machine, installs what's missing and removes what was uninstalled
 * elsewhere.
 *
 * Plain JavaScript, no build step: Tabby provides @angular/*, tabby-core,
 * tabby-settings and tabby-plugin-manager at runtime and compiles this
 * module JIT.
 *
 * How the merge works (planSync):
 *   desired  the shared list in config.yaml        { packageName: version }
 *   local    plugins installed on this machine     { packageName: { version, linked } }
 *   seen     what this machine had after its last sync (per machine, in config.yaml)
 *
 *   in desired, not here, never seen here  → install it
 *   in desired, not here, seen here before → it was uninstalled here → drop from desired
 *   here, not in desired, seen here before → it was uninstalled elsewhere → uninstall here
 *   here, not in desired, never seen here  → it was installed here → add to desired
 *   in both, desired newer                 → upgrade here
 *   in both, local newer                   → bump desired
 *
 * Machines are identified by an id stored in the plugins folder, so a fresh
 * Tabby install (empty plugins folder) counts as a new machine and gets
 * everything installed instead of wiping the list for everyone.
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const { NgModule, Injectable, Injector, Component } = require('@angular/core')
const { CommonModule } = require('@angular/common')
const { FormsModule } = require('@angular/forms')
const TabbyCore = require('tabby-core')
const {
    ConfigProvider, ConfigService, PlatformService, HostAppService,
    NotificationsService, AppService,
} = TabbyCore
const { SettingsTabProvider } = require('tabby-settings')

const SELF = 'tabby-plugin-sync'
const LOG = '[tabby-plugin-sync]'
const PACKAGE_RE = /^(tabby|terminus)-[a-zA-Z0-9._-]+$/
const STARTUP_DELAY_MS = 3000
const WATCH_DEBOUNCE_MS = 1500

const DEFAULTS = {
    enabled: true,
    // Uninstall here what was uninstalled on another machine
    removeMissing: true,
    // Reload Tabby's config when config.yaml changes on disk (file sync)
    reloadOnChange: true,
    // Shared list: { packageName: version }
    plugins: {},
    // Per machine: { id: { name, seen: [packageName], exclude: [packageName], lastSync } }
    machines: {},
}

/* ------------------------------------------------------------------ Utils */

function parseVersion (v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim())
    if (!m) return null
    return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence: <0 if a<b, 0 if equal, >0 if a>b. Unparseable sorts lowest. */
function compareVersions (a, b) {
    const pa = parseVersion(a)
    const pb = parseVersion(b)
    if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
    for (let i = 0; i < 3; i++) {
        if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
    }
    // A release is newer than its pre-releases
    if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length
    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
        const x = pa.pre[i]
        const y = pb.pre[i]
        if (x === undefined) return -1
        if (y === undefined) return 1
        const nx = /^\d+$/.test(x)
        const ny = /^\d+$/.test(y)
        if (nx && ny && +x !== +y) return +x - +y
        if (nx !== ny) return nx ? -1 : 1
        if (x !== y) return x < y ? -1 : 1
    }
    return 0
}

const clone = v => JSON.parse(JSON.stringify(v ?? null))

/* ------------------------------------------------------------------- Plan */

/**
 * Pure merge step, see the header comment.
 *
 * @param o.desired       { pkg: version } shared list
 * @param o.local         { pkg: { version, linked } } installed here (non-builtin)
 * @param o.seen          string[] | null — null on this machine's first sync
 * @param o.exclude       string[] packages this machine ignores
 * @param o.removeMissing boolean
 * @returns { desired, toInstall: [{pkg, version, upgrade}], toRemove: [pkg], declined: [pkg] }
 */
function planSync ({ desired, local, seen, exclude, removeMissing }) {
    const out = { desired: { ...desired }, toInstall: [], toRemove: [], declined: [] }
    const firstRun = !Array.isArray(seen)
    const seenSet = new Set(seen || [])
    const excluded = new Set(exclude || [])

    for (const [pkg, info] of Object.entries(local)) {
        if (excluded.has(pkg) || !PACKAGE_RE.test(pkg)) continue
        if (!(pkg in desired)) {
            if (!firstRun && seenSet.has(pkg)) {
                // Uninstalled on another machine
                if (info.linked || !removeMissing || pkg === SELF) {
                    out.declined.push(pkg)
                } else {
                    out.toRemove.push(pkg)
                }
            } else {
                // Installed here
                out.desired[pkg] = info.version
            }
            continue
        }
        const cmp = compareVersions(desired[pkg], info.version)
        if (cmp > 0 && !info.linked && pkg !== SELF) {
            out.toInstall.push({ pkg, version: desired[pkg], upgrade: true })
        } else if (cmp < 0) {
            out.desired[pkg] = info.version
        }
    }

    for (const [pkg, version] of Object.entries(desired)) {
        if (pkg in local || excluded.has(pkg) || !PACKAGE_RE.test(pkg)) continue
        if (!firstRun && seenSet.has(pkg)) {
            // Uninstalled here
            delete out.desired[pkg]
        } else {
            out.toInstall.push({ pkg, version, upgrade: false })
        }
    }

    const byName = (a, b) => (a.pkg || a).localeCompare(b.pkg || b)
    out.toInstall.sort(byName)
    out.toRemove.sort(byName)
    out.declined.sort(byName)
    return out
}

/* ---------------------------------------------------------------- Service */

class PluginSyncService {
    constructor (injector) {
        this.injector = injector
        this.started = false
        this.running = null
        this.queued = false
        this.inOwnOperation = false
        this.status = { lastSync: null, lastResult: null, errors: {}, pendingRestart: [] }
        this.watcher = null
        this.watchTimer = null
        this.pluginManager = null
        this.machineId = null
    }

    get config () { return this.injector.get(ConfigService) }
    get platform () { return this.injector.get(PlatformService) }
    get hostApp () { return this.injector.get(HostAppService) }
    get notifications () { return this.injector.get(NotificationsService) }

    get settings () {
        const s = this.config.store.pluginSync
        return {
            enabled: s.enabled !== false,
            removeMissing: s.removeMissing !== false,
            reloadOnChange: s.reloadOnChange !== false,
            plugins: clone(s.plugins) || {},
            machines: clone(s.machines) || {},
        }
    }

    /** Called once at app start */
    start () {
        if (this.started) return
        this.started = true
        try {
            this.pluginManager = this.findPluginManager()
        } catch (e) {
            console.error(LOG, 'Plugin manager not available, plugin sync disabled', e)
            return
        }
        this.patchPluginManager()

        const app = this.injector.get(AppService)
        app.ready$.subscribe(async () => {
            await this.config.ready$.toPromise()
            setTimeout(() => {
                this.sync({ reason: 'startup' }).catch(e => console.error(LOG, e))
                this.setupWatcher()
                this.watchSharedList()
            }, STARTUP_DELAY_MS)
        })
    }

    findPluginManager () {
        const { PluginManagerService } = require('tabby-plugin-manager')
        return this.injector.get(PluginManagerService)
    }

    /** Track installs/uninstalls made through Settings → Plugins */
    patchPluginManager () {
        const pm = this.pluginManager
        if (pm.__pluginSyncPatched) return
        pm.__pluginSyncPatched = true
        for (const method of ['installPlugin', 'uninstallPlugin']) {
            const original = pm[method].bind(pm)
            pm[method] = async (...args) => {
                const result = await original(...args)
                if (!this.inOwnOperation) {
                    this.sync({ reason: 'manual', apply: false }).catch(e => console.error(LOG, e))
                }
                return result
            }
        }
    }

    get userPluginsPath () {
        return this.pluginManager?.userPluginsPath
    }

    /** Stable id for this Tabby installation, kept in the plugins folder */
    getMachineId () {
        if (this.machineId) return this.machineId
        const file = path.join(this.userPluginsPath, 'plugin-sync-machine.json')
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'))
            if (data && typeof data.id === 'string' && data.id) {
                this.machineId = data.id
                return this.machineId
            }
        } catch { }
        this.machineId = crypto.randomBytes(8).toString('hex')
        try {
            fs.writeFileSync(file, JSON.stringify({ id: this.machineId, created: new Date().toISOString() }, null, 2))
        } catch (e) {
            console.warn(LOG, 'Could not save machine id', e)
        }
        return this.machineId
    }

    isLinked (pkg) {
        try {
            return fs.lstatSync(path.join(this.userPluginsPath, 'node_modules', pkg)).isSymbolicLink()
        } catch {
            return false
        }
    }

    /** Non-builtin plugins installed here: { pkg: { version, linked } } */
    getLocal () {
        const local = {}
        for (const p of this.pluginManager.installedPlugins || []) {
            if (p.isBuiltin || !p.packageName) continue
            local[p.packageName] = { version: p.version, linked: this.isLinked(p.packageName) }
        }
        return local
    }

    /**
     * Run a sync. Serialized: a call during a running sync queues one more run.
     * @param opts.reason 'startup' | 'manual' | 'file' | 'button'
     * @param opts.apply  false = only update the shared list, don't install/remove
     */
    sync (opts = {}) {
        if (this.running) {
            this.queued = opts
            return this.running
        }
        this.running = this.doSync(opts).finally(() => {
            this.running = null
            if (this.queued) {
                const next = this.queued
                this.queued = false
                this.sync(next)
            }
        })
        return this.running
    }

    async doSync ({ reason = 'manual', apply = true } = {}) {
        // Work on the freshest config.yaml, or a stale copy in memory would
        // overwrite what other machines wrote in the meantime
        await this.reloadIfChangedOnDisk()
        const s = this.settings
        if (!s.enabled || !this.pluginManager) return null

        const id = this.getMachineId()
        const machine = s.machines[id] || {}
        const local = this.getLocal()
        const plan = planSync({
            desired: s.plugins,
            local,
            seen: machine.seen ?? null,
            exclude: machine.exclude || [],
            removeMissing: s.removeMissing,
        })

        const installed = []
        const removed = []
        const failed = []
        if (apply) {
            this.inOwnOperation = true
            try {
                for (const item of plan.toInstall) {
                    try {
                        await this.pluginManager.installPlugin(this.pluginInfo(item.pkg, item.version))
                        installed.push(item)
                        delete this.status.errors[item.pkg]
                    } catch (e) {
                        failed.push(item.pkg)
                        this.status.errors[item.pkg] = String(e?.message || e)
                        console.error(LOG, `Install of ${item.pkg}@${item.version} failed`, e)
                    }
                }
                for (const pkg of plan.toRemove) {
                    try {
                        await this.pluginManager.uninstallPlugin(this.pluginInfo(pkg, local[pkg].version))
                        removed.push(pkg)
                        delete this.status.errors[pkg]
                    } catch (e) {
                        failed.push(pkg)
                        this.status.errors[pkg] = String(e?.message || e)
                        console.error(LOG, `Uninstall of ${pkg} failed`, e)
                    }
                }
            } finally {
                this.inOwnOperation = false
            }
        }

        // What this machine has now that the shared list knows about
        const nowLocal = this.getLocal()
        const exclude = new Set(machine.exclude || [])
        const seen = Object.keys(plan.desired)
            .filter(pkg => pkg in nowLocal && !exclude.has(pkg))
            .concat(plan.declined.filter(pkg => pkg in nowLocal))
        const newMachine = {
            ...machine,
            name: os.hostname(),
            seen: [...new Set(seen)].sort(),
            exclude: [...exclude].sort(),
            lastSync: new Date().toISOString(),
        }

        // Re-read: the config may have been reloaded while we were installing
        const current = this.settings
        const machines = { ...current.machines, [id]: newMachine }
        const store = this.config.store.pluginSync
        const listChanged = JSON.stringify(plan.desired) !== JSON.stringify(current.plugins)
        const machineChanged = JSON.stringify({ ...newMachine, lastSync: 0 }) !== JSON.stringify({ ...(current.machines[id] || {}), lastSync: 0 })
        // Status first: saving emits changed$, which refreshes the settings page
        const result = { reason, installed, removed, failed, declined: plan.declined, time: new Date() }
        this.status.lastSync = result.time
        this.status.lastResult = result
        if (installed.length || removed.length) {
            this.status.pendingRestart = [
                ...new Set([...this.status.pendingRestart, ...installed.map(x => x.pkg), ...removed]),
            ]
            this.config.requestRestart()
        }

        if (listChanged || machineChanged || installed.length || removed.length) {
            store.plugins = plan.desired
            store.machines = machines
            this.lastSharedList = JSON.stringify(this.settings.plugins)
            await this.config.save()
        }

        if (installed.length || removed.length) {
            this.promptRestart(result)
        }
        if (failed.length) {
            this.notifications.error(`Plugin sync: could not update ${failed.join(', ')}`, 'See Settings → Plugin sync')
        }
        return result
    }

    pluginInfo (pkg, version) {
        return {
            name: pkg.replace(/^(tabby|terminus)-/, ''),
            packageName: pkg,
            version,
            description: '',
            author: '',
            isBuiltin: false,
            isLegacy: pkg.startsWith('terminus-'),
        }
    }

    async promptRestart (result) {
        const lines = [
            ...result.installed.map(x => `${x.upgrade ? 'Updated' : 'Installed'} ${x.pkg} ${x.version}`),
            ...result.removed.map(pkg => `Removed ${pkg}`),
        ]
        try {
            const r = await this.platform.showMessageBox({
                type: 'warning',
                message: 'Plugin sync updated your plugins',
                detail: `${lines.join('\n')}\n\nRestart Tabby to load the changes.`,
                buttons: ['Restart now', 'Later'],
                defaultId: 0,
                cancelId: 1,
            })
            if (r.response === 0) {
                this.hostApp.relaunch()
            }
        } catch (e) {
            this.notifications.info('Plugin sync updated your plugins', 'Restart Tabby to load them')
        }
    }

    /**
     * React when the shared list changes inside Tabby without touching the
     * file first, e.g. Tabby's built-in Config sync downloading a new config
     */
    watchSharedList () {
        this.lastSharedList = JSON.stringify(this.settings.plugins)
        this.config.changed$.subscribe(() => {
            const now = JSON.stringify(this.settings.plugins)
            if (now === this.lastSharedList) return
            this.lastSharedList = now
            if (!this.running) {
                this.sync({ reason: 'config' }).catch(e => console.error(LOG, e))
            }
        })
    }

    /** Watch config.yaml so changes from a file sync tool are picked up live */
    setupWatcher () {
        if (this.watcher) return
        let configPath = null
        try {
            configPath = this.platform.getConfigPath()
        } catch { }
        if (!configPath) return
        const dir = path.dirname(configPath)
        const base = path.basename(configPath)
        try {
            // Watch the folder: Tabby writes config.yaml atomically (rename),
            // which would orphan a watcher on the file itself
            this.watcher = fs.watch(dir, (_event, file) => {
                if (file && file !== base) return
                clearTimeout(this.watchTimer)
                this.watchTimer = setTimeout(() => this.onConfigFileChanged(), WATCH_DEBOUNCE_MS)
            })
            this.watcher.on('error', e => console.warn(LOG, 'watch error', e))
        } catch (e) {
            console.warn(LOG, 'Could not watch config.yaml', e)
        }
    }

    async onConfigFileChanged () {
        if (await this.reloadIfChangedOnDisk()) {
            await this.sync({ reason: 'file' })
        }
    }

    /**
     * If config.yaml on disk differs from Tabby's in-memory copy (a file sync
     * tool replaced it), reload it. Returns true when it reloaded.
     */
    async reloadIfChangedOnDisk () {
        if (!this.settings.reloadOnChange) return false
        let configPath = null
        try {
            configPath = this.platform.getConfigPath()
        } catch { }
        if (!configPath) return false
        let text
        try {
            text = fs.readFileSync(configPath, 'utf8')
        } catch {
            return false
        }
        // Tabby's own save: the file matches what's in memory
        if (text === this.config.readRaw()) return false
        // Encrypted configs would prompt for the password on every reload
        if (/^encrypted:\s*true\s*$/m.test(text)) return false
        try {
            await this.config.load()
            this.config.emitChange?.()
            console.info(LOG, 'config.yaml changed on disk, reloaded')
            return true
        } catch (e) {
            // Probably a half-written file; the next change event will retry
            console.warn(LOG, 'Could not reload config.yaml', e)
            return false
        }
    }

    /* ---- used by the settings page ---- */

    setExcluded (pkg, excluded) {
        const id = this.getMachineId()
        const machines = this.settings.machines
        const m = machines[id] || { name: os.hostname(), seen: null, exclude: [] }
        const set = new Set(m.exclude || [])
        if (excluded) set.add(pkg)
        else set.delete(pkg)
        m.exclude = [...set].sort()
        machines[id] = m
        this.config.store.pluginSync.machines = machines
        return this.config.save()
    }

    forgetMachine (id) {
        const machines = this.settings.machines
        delete machines[id]
        this.config.store.pluginSync.machines = machines
        return this.config.save()
    }

    /** Rows for the settings table */
    describe () {
        if (!this.pluginManager) return { available: false }
        const s = this.settings
        const id = this.getMachineId()
        const machine = s.machines[id] || {}
        const exclude = new Set(machine.exclude || [])
        const local = this.getLocal()
        const names = [...new Set([...Object.keys(s.plugins), ...Object.keys(local)])].sort()
        const rows = names.map(pkg => {
            const want = s.plugins[pkg]
            const have = local[pkg]
            let state
            if (exclude.has(pkg)) state = 'excluded'
            else if (this.status.errors[pkg]) state = 'error'
            else if (this.status.pendingRestart.includes(pkg)) state = 'restart'
            else if (have?.linked) state = 'linked'
            else if (!want) state = 'local-only'
            else if (!have) state = 'missing'
            else if (compareVersions(want, have.version) > 0) state = 'outdated'
            else state = 'ok'
            return { pkg, want, have: have?.version, linked: !!have?.linked, state, error: this.status.errors[pkg] }
        })
        const machines = Object.entries(s.machines)
            .map(([mid, m]) => ({ id: mid, name: m.name || mid, lastSync: m.lastSync, current: mid === id }))
            .sort((a, b) => (b.current - a.current) || String(a.name).localeCompare(String(b.name)))
        return { available: true, machineId: id, rows, machines }
    }
}
PluginSyncService.ctorParameters = () => [{ type: Injector }]
Injectable({ providedIn: 'root' })(PluginSyncService)

class PluginSyncConfigProvider extends ConfigProvider {
    constructor () {
        super()
        this.defaults = { pluginSync: clone(DEFAULTS) }
        this.platformDefaults = {}
    }
}
Injectable()(PluginSyncConfigProvider)

/* --------------------------------------------------------------- Settings */

const STATE_LABELS = {
    'ok': 'In sync',
    'missing': 'Will be installed',
    'outdated': 'Will be updated',
    'local-only': 'Will be added',
    'linked': 'Dev link, not touched',
    'excluded': 'Excluded here',
    'restart': 'Restart to load',
    'error': 'Error',
}

const SETTINGS_TEMPLATE = `
<h3>Plugin sync</h3>
<p class="ps-intro">
    Keeps the installed plugins the same on every machine that shares this
    <code>config.yaml</code> (Config sync, Syncthing, Koofr…). The list is
    stored in the config under <code>pluginSync</code>.
</p>

<div *ngIf="!info.available" class="alert alert-warning">
    Tabby's plugin manager isn't available, so plugin sync can't run.
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Enable</div>
        <div class="description">Install missing plugins at startup and keep the shared list up to date</div>
    </div>
    <toggle [(ngModel)]="config.store.pluginSync.enabled" (ngModelChange)="save()"></toggle>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Remove plugins uninstalled elsewhere</div>
        <div class="description">When off, plugins removed on another machine stay installed here</div>
    </div>
    <toggle [(ngModel)]="config.store.pluginSync.removeMissing" (ngModelChange)="save()"></toggle>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Reload config.yaml when it changes on disk</div>
        <div class="description">For file sync tools: picks up changes from other machines without a restart, and stops Tabby from overwriting them</div>
    </div>
    <toggle [(ngModel)]="config.store.pluginSync.reloadOnChange" (ngModelChange)="save()"></toggle>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Sync now</div>
        <div class="description">
            <span *ngIf="sync.status.lastSync">Last sync {{ sync.status.lastSync | date:'HH:mm:ss' }}<span *ngIf="lastSummary">: {{ lastSummary }}</span></span>
            <span *ngIf="!sync.status.lastSync">Not synced yet in this session</span>
        </div>
    </div>
    <button class="btn btn-secondary" (click)="syncNow()" [disabled]="busy || !info.available">
        {{ busy ? 'Syncing…' : 'Sync now' }}
    </button>
</div>

<div class="form-line" *ngIf="sync.status.pendingRestart.length">
    <div class="header">
        <div class="title">Restart needed</div>
        <div class="description">{{ sync.status.pendingRestart.join(', ') }}</div>
    </div>
    <button class="btn btn-warning" (click)="restart()">Restart Tabby</button>
</div>

<h4 class="mt-4">Plugins</h4>
<table class="table ps-table" *ngIf="info.rows?.length">
    <thead>
        <tr>
            <th>Plugin</th>
            <th>Shared</th>
            <th>Here</th>
            <th>Status</th>
            <th class="ps-center">Sync here</th>
        </tr>
    </thead>
    <tbody>
        <tr *ngFor="let row of info.rows; trackBy: trackRow">
            <td><strong>{{ row.pkg }}</strong></td>
            <td>{{ row.want || '—' }}</td>
            <td>{{ row.have || '—' }}</td>
            <td>
                <span class="ps-state" [ngClass]="'ps-' + row.state" [title]="row.error || ''">{{ label(row.state) }}</span>
            </td>
            <td class="ps-center">
                <input type="checkbox" class="form-check-input"
                    [checked]="row.state !== 'excluded'"
                    [disabled]="row.pkg === self"
                    (change)="toggleExcluded(row, $event.target.checked)">
            </td>
        </tr>
    </tbody>
</table>
<p *ngIf="info.available && !info.rows?.length" class="ps-muted">No plugins installed yet.</p>

<h4 class="mt-4">Machines</h4>
<table class="table ps-table" *ngIf="info.machines?.length">
    <tbody>
        <tr *ngFor="let m of info.machines">
            <td><strong>{{ m.name }}</strong> <span *ngIf="m.current" class="ps-muted">(this machine)</span></td>
            <td class="ps-muted">{{ m.lastSync ? (m.lastSync | date:'d MMM y, HH:mm') : 'never' }}</td>
            <td class="ps-right">
                <button *ngIf="!m.current" class="btn btn-link btn-sm" (click)="forget(m)">Forget</button>
            </td>
        </tr>
    </tbody>
</table>
<p class="ps-muted">
    Forget a machine you don't use anymore, or after reinstalling Tabby on it.
</p>
`

const SETTINGS_STYLES = [`
:host { display: block; }
.ps-intro, .ps-muted { opacity: 0.75; }
.ps-table { margin-bottom: 0.5rem; }
.ps-table td, .ps-table th { vertical-align: middle; }
.ps-center { text-align: center; }
.ps-right { text-align: right; }
.ps-state { white-space: nowrap; font-size: 0.9em; }
.ps-ok { opacity: 0.7; }
.ps-missing, .ps-outdated, .ps-local-only, .ps-restart { color: var(--bs-warning, #e0a800); }
.ps-error { color: var(--bs-danger, #dc3545); cursor: help; }
.ps-linked, .ps-excluded { opacity: 0.6; font-style: italic; }
`]

class PluginSyncSettingsComponent {
    constructor (config, sync, hostApp) {
        this.config = config
        this.sync = sync
        this.hostApp = hostApp
        this.self = SELF
        this.busy = false
        this.info = { available: false }
        this.sub = null
    }

    ngOnInit () {
        this.refresh()
        this.sub = this.config.changed$.subscribe(() => this.refresh())
    }

    ngOnDestroy () {
        this.sub?.unsubscribe()
    }

    refresh () {
        try {
            this.info = this.sync.describe()
        } catch (e) {
            console.error(LOG, e)
            this.info = { available: false }
        }
    }

    get lastSummary () {
        const r = this.sync.status.lastResult
        if (!r) return ''
        const parts = []
        if (r.installed.length) parts.push(`${r.installed.length} installed`)
        if (r.removed.length) parts.push(`${r.removed.length} removed`)
        if (r.failed.length) parts.push(`${r.failed.length} failed`)
        return parts.length ? parts.join(', ') : 'nothing to do'
    }

    label (state) { return STATE_LABELS[state] || state }
    trackRow (_i, row) { return row.pkg }

    save () {
        this.config.save()
    }

    async syncNow () {
        this.busy = true
        try {
            await this.sync.sync({ reason: 'button' })
        } finally {
            this.busy = false
            this.refresh()
        }
    }

    async toggleExcluded (row, checked) {
        await this.sync.setExcluded(row.pkg, !checked)
        this.refresh()
    }

    async forget (m) {
        await this.sync.forgetMachine(m.id)
        this.refresh()
    }

    restart () {
        this.hostApp.relaunch()
    }
}
PluginSyncSettingsComponent.ctorParameters = () => [
    { type: ConfigService },
    { type: PluginSyncService },
    { type: HostAppService },
]
Component({
    selector: 'plugin-sync-settings',
    template: SETTINGS_TEMPLATE,
    styles: SETTINGS_STYLES,
})(PluginSyncSettingsComponent)

class PluginSyncSettingsTabProvider extends SettingsTabProvider {
    constructor () {
        super()
        this.id = 'plugin-sync'
        this.icon = 'sync'
        this.title = 'Plugin sync'
    }

    getComponentType () {
        return PluginSyncSettingsComponent
    }
}
Injectable()(PluginSyncSettingsTabProvider)

/* ----------------------------------------------------------------- Module */

class PluginSyncModule {
    constructor (sync) {
        sync.start()
    }
}
PluginSyncModule.ctorParameters = () => [{ type: PluginSyncService }]
NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCore.default,
    ],
    declarations: [
        PluginSyncSettingsComponent,
    ],
    providers: [
        { provide: ConfigProvider, useClass: PluginSyncConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: PluginSyncSettingsTabProvider, multi: true },
    ],
})(PluginSyncModule)

module.exports = {
    default: PluginSyncModule,
    PluginSyncService,
    PluginSyncSettingsComponent,
    planSync,
    compareVersions,
    DEFAULTS,
}
