import { App, TFile, TFolder, normalizePath } from "obsidian";
import { NextcloudClient, RemoteEntry } from "./webdav";
import { ObsinextSettings } from "./settings";

export interface FileState {
  localMtime: number;
  localSize: number;
  etag: string;
}

export type SyncState = Record<string, FileState>;

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  restored: number;
  conflicts: string[];
  errors: string[];
}

export interface SyncHooks {
  onProgress(done: number, total: number): void;
  persist(): Promise<void>;
  beforeLocalTrash(path: string): void;
  confirmRemoteDeletions(paths: string[]): Promise<boolean>;
}

type ActionKind = "upload" | "download" | "deleteLocal" | "deleteRemote" | "conflict" | "compare" | "forget";

interface Action {
  kind: ActionKind;
  path: string;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

export function conflictPath(path: string, date: Date, sequence = 1): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const suffix = sequence > 1 ? ` ${sequence}` : "";
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${base} (conflito ${stamp}${suffix})${ext}`;
}

export function isIgnoredPath(path: string, ignorePaths: string[]): boolean {
  if (path.split("/").some((segment) => segment.startsWith("."))) return true;
  return ignorePaths.some((raw) => {
    const prefix = raw.trim().replace(/^\/+|\/+$/g, "");
    return prefix.length > 0 && (path === prefix || path.startsWith(prefix + "/"));
  });
}

export class SyncEngine {
  private remoteDirs = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly client: NextcloudClient,
    private readonly settings: ObsinextSettings,
    private readonly state: SyncState,
    private readonly hooks: SyncHooks,
  ) {}

  async run(): Promise<SyncReport> {
    const report: SyncReport = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      restored: 0,
      conflicts: [],
      errors: [],
    };

    const local = new Map<string, TFile>();
    for (const file of this.app.vault.getFiles()) {
      if (!isIgnoredPath(file.path, this.settings.ignorePaths)) local.set(file.path, file);
    }

    const listing = await this.client.listAll();
    if (!listing.rootExists) await this.client.ensureRoot();
    this.remoteDirs = listing.dirs;
    for (const skipped of listing.skipped) {
      report.errors.push(`${skipped}: nome inválido no servidor, ignorado por segurança.`);
    }

    const remote = new Map<string, RemoteEntry>();
    for (const [path, entry] of listing.files) {
      if (!isIgnoredPath(path, this.settings.ignorePaths)) remote.set(path, entry);
    }

    this.assertNotWiped(local.size, remote.size);

    const actions = this.plan(local, remote);
    this.assertDeletionLimit(actions);
    await this.confirmRemoteDeletions(actions);

    for (const action of actions) {
      if (action.kind === "forget") delete this.state[action.path];
    }
    const work = actions.filter((action) => action.kind !== "forget");

    let done = 0;
    this.hooks.onProgress(done, work.length);
    for (const action of work) {
      try {
        await this.execute(action, local, remote, report);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.errors.push(`${action.path}: ${message}`);
        console.error("[Obsinext]", action.kind, action.path, error);
      }
      done++;
      this.hooks.onProgress(done, work.length);
      if (done % 25 === 0) await this.hooks.persist();
    }
    return report;
  }

  private assertNotWiped(localCount: number, remoteCount: number): void {
    const known = Object.keys(this.state).length;
    if (known === 0) return;
    const hint =
      "Por segurança, nada foi alterado. Se isso for intencional, use “Redefinir estado de sincronização” e sincronize novamente.";
    if (remoteCount === 0 && localCount > 0) {
      throw new Error(`A pasta remota está vazia, embora já tenha havido sincronizações. ${hint}`);
    }
    if (localCount === 0 && remoteCount > 0) {
      throw new Error(`O cofre está vazio, embora já tenha havido sincronizações. ${hint}`);
    }
  }

  private assertDeletionLimit(actions: Action[]): void {
    const limit = this.settings.maxDeletions;
    if (limit <= 0) return;
    const deletions = actions.filter((a) => a.kind === "deleteLocal" || a.kind === "deleteRemote").length;
    if (deletions > limit) {
      throw new Error(
        `Esta sincronização apagaria ${deletions} arquivos, acima do limite configurado (${limit}). ` +
          "Nada foi alterado. Confira o ocorrido e, se estiver tudo certo, aumente o limite temporariamente.",
      );
    }
  }

  private async confirmRemoteDeletions(actions: Action[]): Promise<void> {
    if (!this.settings.confirmRemoteDeletion) return;
    const pending = actions.filter((a) => a.kind === "deleteRemote");
    if (pending.length === 0) return;
    const approved = await this.hooks.confirmRemoteDeletions(pending.map((a) => a.path));
    if (!approved) {
      for (const action of pending) action.kind = "download";
    }
  }

  private plan(local: Map<string, TFile>, remote: Map<string, RemoteEntry>): Action[] {
    const paths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(this.state)]);
    const propagate = this.settings.propagateDeletions;
    const actions: Action[] = [];

    for (const path of paths) {
      const localFile = local.get(path);
      const remoteEntry = remote.get(path);
      const known = this.state[path];
      const localChanged =
        !!localFile && !!known && (localFile.stat.mtime !== known.localMtime || localFile.stat.size !== known.localSize);
      const remoteChanged = !!remoteEntry && !!known && remoteEntry.etag !== known.etag;

      if (localFile && remoteEntry) {
        if (!known) actions.push({ kind: "compare", path });
        else if (localChanged && remoteChanged) actions.push({ kind: "conflict", path });
        else if (localChanged) actions.push({ kind: "upload", path });
        else if (remoteChanged) actions.push({ kind: "download", path });
      } else if (localFile) {
        if (!known || localChanged) actions.push({ kind: "upload", path });
        else actions.push({ kind: propagate ? "deleteLocal" : "upload", path });
      } else if (remoteEntry) {
        if (!known || remoteChanged) actions.push({ kind: "download", path });
        else actions.push({ kind: propagate ? "deleteRemote" : "download", path });
      } else if (known) {
        actions.push({ kind: "forget", path });
      }
    }
    return actions;
  }

  private async execute(
    action: Action,
    local: Map<string, TFile>,
    remote: Map<string, RemoteEntry>,
    report: SyncReport,
  ): Promise<void> {
    const { path } = action;
    switch (action.kind) {
      case "upload":
        await this.upload(local.get(path) as TFile);
        report.uploaded++;
        return;

      case "download":
        if (await this.download(path, remote.get(path) as RemoteEntry)) report.downloaded++;
        else report.conflicts.push(path);
        return;

      case "compare":
        if (!(await this.compare(local.get(path) as TFile, remote.get(path) as RemoteEntry))) {
          report.conflicts.push(path);
        }
        return;

      case "conflict": {
        const { data } = await this.client.get(path);
        await this.resolveConflict(local.get(path) as TFile, data, remote.get(path) as RemoteEntry);
        report.conflicts.push(path);
        return;
      }

      case "deleteLocal": {
        const file = local.get(path) as TFile;
        this.hooks.beforeLocalTrash(path);
        await this.app.vault.trash(file, false);
        delete this.state[path];
        report.deletedLocal++;
        return;
      }

      case "deleteRemote": {
        const result = await this.client.delete(path, this.state[path]?.etag);
        if (result === "changed") {
          delete this.state[path];
          await this.download(path, remote.get(path) as RemoteEntry);
          report.restored++;
        } else {
          delete this.state[path];
          report.deletedRemote++;
        }
        return;
      }

      case "forget":
        delete this.state[path];
        return;
    }
  }

  private async compare(file: TFile, entry: RemoteEntry): Promise<boolean> {
    const { data, etag } = await this.client.get(file.path);
    if (file.stat.size === entry.size) {
      const { mtime, size } = file.stat;
      const localData = await this.app.vault.readBinary(file);
      if (sameBytes(data, localData)) {
        this.state[file.path] = { localMtime: mtime, localSize: size, etag: etag || entry.etag };
        return true;
      }
    }
    await this.resolveConflict(file, data, entry);
    return false;
  }

  private async resolveConflict(file: TFile, remoteData: ArrayBuffer, entry: RemoteEntry): Promise<void> {
    const copyPath = this.uniqueConflictPath(file.path);
    await this.writeLocal(copyPath, remoteData, entry.mtime);
    const copy = this.app.vault.getAbstractFileByPath(copyPath);
    if (copy instanceof TFile) await this.upload(copy);
    await this.upload(file);
  }

  private uniqueConflictPath(path: string): string {
    const now = new Date();
    let sequence = 1;
    let candidate = conflictPath(path, now, sequence);
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      sequence++;
      candidate = conflictPath(path, now, sequence);
    }
    return candidate;
  }

  private async upload(file: TFile): Promise<void> {
    const { mtime, size } = file.stat;
    const data = await this.app.vault.readBinary(file);
    const parent = parentOf(file.path);
    if (parent) await this.client.ensureDir(parent, this.remoteDirs);
    const etag = await this.client.put(file.path, data, mtime);
    this.state[file.path] = { localMtime: mtime, localSize: size, etag };
  }

  private async download(path: string, entry: RemoteEntry): Promise<boolean> {
    const { data, etag } = await this.client.get(path);
    const current = this.app.vault.getAbstractFileByPath(path);
    const known = this.state[path];
    if (
      current instanceof TFile &&
      (!known || current.stat.mtime !== known.localMtime || current.stat.size !== known.localSize)
    ) {
      await this.resolveConflict(current, data, entry);
      return false;
    }
    await this.writeLocal(path, data, entry.mtime);
    const stat = await this.app.vault.adapter.stat(path);
    this.state[path] = {
      localMtime: stat?.mtime ?? 0,
      localSize: stat?.size ?? data.byteLength,
      etag: etag || entry.etag,
    };
    return true;
  }

  private async writeLocal(path: string, data: ArrayBuffer, mtime: number): Promise<void> {
    const options = mtime > 0 ? { mtime } : undefined;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data, options);
      return;
    }
    if (existing) throw new Error(`Já existe uma pasta com o nome “${path}”.`);
    await this.ensureLocalFolder(parentOf(path));
    await this.app.vault.createBinary(path, data, options);
  }

  private async ensureLocalFolder(folder: string): Promise<void> {
    if (!folder) return;
    let current = "";
    for (const segment of folder.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(normalizePath(current));
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`Já existe um arquivo com o nome da pasta “${current}”.`);
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
      }
    }
  }
}
