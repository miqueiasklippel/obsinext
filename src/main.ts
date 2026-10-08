import { Notice, Plugin, TAbstractFile } from "obsidian";
import { DeletionModal } from "./deletion-modal";
import { readSecret } from "./secrets";
import { DEFAULT_SETTINGS, NextSyncSettings, NextSyncSettingTab } from "./settings";
import { SyncEngine, SyncReport, SyncState, isIgnoredPath } from "./sync";
import { NextcloudClient, validateRemoteFolder, validateServerUrl } from "./webdav";

interface StoredData {
  settings: NextSyncSettings;
  syncState: SyncState;
  stateKey: string;
  lastSync: number;
}

const DELETE_DEBOUNCE_MS = 600;

export default class NextSyncPlugin extends Plugin {
  settings: NextSyncSettings = { ...DEFAULT_SETTINGS };
  private syncState: SyncState = {};
  private stateKey = "";
  private lastSync = 0;
  private syncing = false;
  private queue: Promise<unknown> = Promise.resolve();
  private statusEl: HTMLElement | null = null;
  private autoSyncId: number | null = null;
  private deleteTimer: number | null = null;
  private readonly pendingDeletes = new Set<string>();
  private readonly ownDeletions = new Set<string>();

  async onload(): Promise<void> {
    await this.loadAll();

    this.addSettingTab(new NextSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "NextSync: sincronizar agora", () => void this.sync());
    this.statusEl = this.addStatusBarItem();
    this.updateIdleStatus();

    this.addCommand({ id: "sync-now", name: "Sincronizar agora", callback: () => void this.sync() });
    this.addCommand({
      id: "reset-state",
      name: "Redefinir estado de sincronização",
      callback: async () => {
        await this.resetState();
        new Notice("NextSync: estado de sincronização redefinido.");
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultDelete(file)));
      if (this.settings.syncOnStartup) void this.sync(true);
    });
    this.restartAutoSync();
  }

  onunload(): void {
    if (this.autoSyncId !== null) window.clearInterval(this.autoSyncId);
    if (this.deleteTimer !== null) window.clearTimeout(this.deleteTimer);
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  async resetState(): Promise<void> {
    await this.exclusive(async () => {
      this.syncState = {};
      this.stateKey = "";
      await this.persist();
    });
  }

  restartAutoSync(): void {
    if (this.autoSyncId !== null) {
      window.clearInterval(this.autoSyncId);
      this.autoSyncId = null;
    }
    const minutes = this.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.autoSyncId = window.setInterval(() => void this.sync(true), minutes * 60_000);
      this.registerInterval(this.autoSyncId);
    }
  }

  async testConnection(): Promise<{ id: string; displayName: string }> {
    const s = this.settings;
    const password = await this.resolvePassword();
    if (!s.serverUrl || !s.loginName || !password) {
      throw new Error("Preencha o endereço, o usuário e a senha de aplicativo.");
    }
    const user = await NextcloudClient.discoverUser(s.serverUrl, s.loginName, password);
    s.userId = user.id;
    await this.persist();
    return user;
  }

  async sync(silent = false): Promise<void> {
    if (this.syncing) {
      if (!silent) new Notice("NextSync: já há uma sincronização em andamento.");
      return;
    }
    this.syncing = true;
    this.setStatus("sincronizando…");
    try {
      await this.exclusive(() => this.runSync(silent));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[NextSync]", error);
      new Notice(`NextSync: ${message}`, 12_000);
    } finally {
      this.syncing = false;
      await this.persist();
      this.updateIdleStatus();
    }
  }

  private async runSync(silent: boolean): Promise<void> {
    const client = await this.createClient();
    this.alignStateWithTarget();

    const engine = new SyncEngine(this.app, client, this.settings, this.syncState, {
      onProgress: (done, total) => this.setStatus(total > 0 ? `sincronizando ${done}/${total}` : "sincronizando…"),
      persist: () => this.persist(),
      beforeLocalTrash: (path) => {
        this.ownDeletions.add(path);
      },
      confirmRemoteDeletions: async (paths) => {
        const choice = await new DeletionModal(this.app, {
          title: "Confirmar exclusões no Nextcloud",
          message: `${paths.length} arquivo(s) não existem mais no cofre. Deseja excluí-los também da pasta “${this.settings.remoteFolder}” no Nextcloud?`,
          keepHint: "Se mantiver, os arquivos serão baixados novamente para o cofre.",
          items: paths,
        }).ask();
        return choice === "delete";
      },
    });

    const report = await engine.run();
    this.lastSync = Date.now();
    this.notifyReport(report, silent);
  }

  private onVaultDelete(file: TAbstractFile): void {
    if (this.ownDeletions.delete(file.path)) return;
    const s = this.settings;
    if (!s.propagateDeletions || !s.confirmRemoteDeletion) return;
    if (isIgnoredPath(file.path, s.ignorePaths)) return;

    this.pendingDeletes.add(file.path);
    if (this.deleteTimer !== null) window.clearTimeout(this.deleteTimer);
    this.deleteTimer = window.setTimeout(() => {
      this.deleteTimer = null;
      const paths = [...this.pendingDeletes];
      this.pendingDeletes.clear();
      void this.exclusive(() => this.handleUserDeletion(paths)).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[NextSync]", error);
        new Notice(`NextSync: ${message}`, 10_000);
      });
    }, DELETE_DEBOUNCE_MS);
  }

  private async handleUserDeletion(deletedPaths: string[]): Promise<void> {
    if (this.stateKey !== this.currentTargetKey()) return;

    const affected = Object.keys(this.syncState)
      .filter((path) => deletedPaths.some((deleted) => path === deleted || path.startsWith(deleted + "/")))
      .filter((path) => this.app.vault.getAbstractFileByPath(path) === null)
      .sort();
    if (affected.length === 0) return;

    const choice = await new DeletionModal(this.app, {
      title: "Excluir também no Nextcloud?",
      message: `Você excluiu ${affected.length} arquivo(s) sincronizado(s). Eles também serão excluídos da pasta “${this.settings.remoteFolder}” no Nextcloud, onde ficarão na lixeira do servidor.`,
      keepHint: "Se mantiver, os arquivos continuarão no Nextcloud e voltarão para o cofre na próxima sincronização.",
      items: affected,
    }).ask();

    if (choice === "keep") {
      for (const path of affected) delete this.syncState[path];
      await this.persist();
      new Notice("NextSync: os arquivos foram mantidos no Nextcloud e voltarão na próxima sincronização.");
      return;
    }

    await this.deleteRemoteNow(affected);
  }

  private async deleteRemoteNow(paths: string[]): Promise<void> {
    let client: NextcloudClient;
    try {
      client = await this.createClient();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`NextSync: ${message} A exclusão será feita na próxima sincronização.`, 10_000);
      return;
    }

    let deleted = 0;
    let kept = 0;
    let failed = 0;
    for (const path of paths) {
      try {
        const result = await client.delete(path, this.syncState[path]?.etag);
        if (result === "changed") kept++;
        else deleted++;
        delete this.syncState[path];
      } catch (error) {
        failed++;
        console.error("[NextSync]", path, error);
      }
    }
    await this.persist();

    const parts = [`${deleted} arquivo(s) excluído(s) no Nextcloud`];
    if (kept) parts.push(`${kept} mantido(s) por terem sido alterados no servidor`);
    if (failed) parts.push(`${failed} pendente(s) para a próxima sincronização`);
    new Notice(`NextSync: ${parts.join("; ")}.`, kept || failed ? 10_000 : 5_000);
  }

  private async createClient(): Promise<NextcloudClient> {
    const s = this.settings;
    const password = await this.resolvePassword();
    if (!s.serverUrl || !s.loginName || !password) {
      throw new Error("Configure o endereço, o usuário e a senha de aplicativo nas configurações do plugin.");
    }
    if (!s.userId) {
      s.userId = (await NextcloudClient.discoverUser(s.serverUrl, s.loginName, password)).id;
      await this.persist();
    }
    return new NextcloudClient({
      serverUrl: s.serverUrl,
      loginName: s.loginName,
      password,
      userId: s.userId,
      remoteFolder: s.remoteFolder,
    });
  }

  private async resolvePassword(): Promise<string> {
    if (this.settings.passwordSecretId) {
      const secret = await readSecret(this.app, this.settings.passwordSecretId);
      if (secret) return secret;
    }
    return this.settings.appPassword;
  }

  private currentTargetKey(): string {
    const s = this.settings;
    try {
      return `${validateServerUrl(s.serverUrl)}|${s.userId}|${validateRemoteFolder(s.remoteFolder)}`;
    } catch {
      return "";
    }
  }

  private alignStateWithTarget(): void {
    const key = this.currentTargetKey();
    if (key !== this.stateKey) {
      this.syncState = {};
      this.stateKey = key;
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async loadAll(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<StoredData>;
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.syncState = data.syncState ?? {};
    this.stateKey = data.stateKey ?? "";
    this.lastSync = data.lastSync ?? 0;
  }

  private async persist(): Promise<void> {
    const data: StoredData = {
      settings: this.settings,
      syncState: this.syncState,
      stateKey: this.stateKey,
      lastSync: this.lastSync,
    };
    await this.saveData(data);
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(`NextSync: ${text}`);
  }

  private updateIdleStatus(): void {
    if (!this.lastSync) {
      this.setStatus("nunca sincronizado");
      return;
    }
    const date = new Date(this.lastSync);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    this.setStatus(`sincronizado às ${time}`);
  }

  private notifyReport(report: SyncReport, silent: boolean): void {
    const parts: string[] = [];
    if (report.uploaded) parts.push(`${report.uploaded} enviado(s)`);
    if (report.downloaded) parts.push(`${report.downloaded} baixado(s)`);
    if (report.deletedLocal) parts.push(`${report.deletedLocal} excluído(s) no cofre`);
    if (report.deletedRemote) parts.push(`${report.deletedRemote} excluído(s) no Nextcloud`);
    if (report.restored) parts.push(`${report.restored} restaurado(s) por alteração no servidor`);

    if (parts.length > 0 || !silent) {
      new Notice(`NextSync: ${parts.length > 0 ? parts.join(", ") : "tudo em dia"}.`);
    }
    if (report.conflicts.length > 0) {
      new Notice(
        `NextSync: ${report.conflicts.length} conflito(s). A versão do servidor foi guardada como cópia “(conflito …)”:\n` +
          report.conflicts.join("\n"),
        15_000,
      );
    }
    if (report.errors.length > 0) {
      new Notice(`NextSync: ${report.errors.length} erro(s):\n${report.errors.slice(0, 5).join("\n")}`, 15_000);
    }
  }
}
