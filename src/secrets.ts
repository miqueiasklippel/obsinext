import * as obsidian from "obsidian";
import type { App, Setting } from "obsidian";

interface SecretStorageLike {
  getSecret(id: string): string | null | Promise<string | null>;
}

interface SecretComponentLike {
  setValue(value: string): SecretComponentLike;
  onChange(callback: (value: string) => unknown): SecretComponentLike;
}

type SecretComponentCtor = new (app: App, containerEl: HTMLElement) => SecretComponentLike;

type SettingWithComponent = Setting & {
  addComponent(factory: (el: HTMLElement) => unknown): Setting;
};

function secretStorage(app: App): SecretStorageLike | null {
  const storage = (app as unknown as { secretStorage?: SecretStorageLike }).secretStorage;
  return storage && typeof storage.getSecret === "function" ? storage : null;
}

function secretComponent(): SecretComponentCtor | null {
  const ctor = (obsidian as unknown as Record<string, unknown>).SecretComponent;
  return typeof ctor === "function" ? (ctor as SecretComponentCtor) : null;
}

export function isSecretStorageAvailable(app: App, setting?: Setting): boolean {
  const base = secretStorage(app) !== null && secretComponent() !== null;
  if (!base || !setting) return base;
  return typeof (setting as Partial<SettingWithComponent>).addComponent === "function";
}

export async function readSecret(app: App, id: string): Promise<string | null> {
  const storage = secretStorage(app);
  if (!storage || !id) return null;
  const value = await Promise.resolve(storage.getSecret(id));
  return value ? value : null;
}

export function addSecretPicker(
  app: App,
  setting: Setting,
  value: string,
  onChange: (id: string) => Promise<void>,
): void {
  const Ctor = secretComponent();
  if (!Ctor) return;
  (setting as SettingWithComponent).addComponent((el) =>
    new Ctor(app, el).setValue(value).onChange((id) => onChange(id)),
  );
}
