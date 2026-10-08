import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NextSyncPlugin from "./main";
import { addSecretPicker, isSecretStorageAvailable } from "./secrets";

export interface NextSyncSettings {
  serverUrl: string;
  loginName: string;
  appPassword: string;
  passwordSecretId: string;
  userId: string;
  remoteFolder: string;
  autoSyncMinutes: number;
  syncOnStartup: boolean;
  propagateDeletions: boolean;
  confirmRemoteDeletion: boolean;
  maxDeletions: number;
  ignorePaths: string[];
}

export const DEFAULT_SETTINGS: NextSyncSettings = {
  serverUrl: "",
  loginName: "",
  appPassword: "",
  passwordSecretId: "",
  userId: "",
  remoteFolder: "Obsidian",
  autoSyncMinutes: 0,
  syncOnStartup: false,
  propagateDeletions: true,
  confirmRemoteDeletion: true,
  maxDeletions: 50,
  ignorePaths: [],
};

export class NextSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: NextSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderConnection(containerEl);
    this.renderSync(containerEl);
    this.renderSafety(containerEl);
    this.renderMaintenance(containerEl);
  }

  private renderConnection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Conexão com o Nextcloud").setHeading();

    new Setting(containerEl)
      .setName("Endereço do servidor")
      .setDesc("Somente a raiz do Nextcloud, com HTTPS. Exemplo: https://nuvem.exemplo.com")
      .addText((text) =>
        text
          .setPlaceholder("https://nuvem.exemplo.com")
          .setValue(s.serverUrl)
          .onChange(async (value) => {
            s.serverUrl = value.trim();
            s.userId = "";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Usuário")
      .setDesc("Nome de login do Nextcloud (pode ser o e-mail).")
      .addText((text) =>
        text.setValue(s.loginName).onChange(async (value) => {
          s.loginName = value.trim();
          s.userId = "";
          await this.plugin.saveSettings();
        }),
      );

    this.renderPassword(containerEl);

    new Setting(containerEl)
      .setName("Pasta remota")
      .setDesc("Pasta do Nextcloud que espelhará este cofre. É criada automaticamente se não existir.")
      .addText((text) =>
        text.setValue(s.remoteFolder).onChange(async (value) => {
          s.remoteFolder = value.trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        }),
      );

    const status = new Setting(containerEl)
      .setName("Testar conexão")
      .setDesc(s.userId ? `Conectado como “${s.userId}”.` : "Conexão ainda não verificada.");
    status.addButton((button) =>
      button
        .setButtonText("Testar conexão")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Testando…");
          try {
            const user = await this.plugin.testConnection();
            status.setDesc(`Conectado como “${user.displayName}” (ID: ${user.id}).`);
            new Notice(`NextSync: conexão bem-sucedida como ${user.displayName}.`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            status.setDesc(`Falha: ${message}`);
            new Notice(`NextSync: ${message}`, 8000);
          } finally {
            button.setDisabled(false).setButtonText("Testar conexão");
          }
        }),
    );
  }

  private renderPassword(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const setting = new Setting(containerEl).setName("Senha de aplicativo");

    if (isSecretStorageAvailable(this.app, setting)) {
      setting.setDesc(
        "Guardada no armazenamento de segredos do Obsidian, fora do arquivo de configuração do plugin. " +
          "Crie a senha em Configurações pessoais → Segurança → Dispositivos e sessões do Nextcloud.",
      );
      addSecretPicker(this.app, setting, s.passwordSecretId, async (id) => {
        s.passwordSecretId = id;
        s.appPassword = "";
        s.userId = "";
        await this.plugin.saveSettings();
      });
      if (s.appPassword) {
        new Setting(containerEl)
          .setName("Senha antiga em texto simples")
          .setDesc("Há uma senha gravada no arquivo de configuração. Selecione um segredo acima ou remova-a.")
          .addButton((button) =>
            button
              .setButtonText("Remover")
              .setWarning()
              .onClick(async () => {
                s.appPassword = "";
                await this.plugin.saveSettings();
                this.display();
              }),
          );
      }
      return;
    }

    setting
      .setDesc(
        "O armazenamento de segredos do Obsidian não está disponível neste dispositivo; " +
          "a senha ficará no arquivo data.json do plugin. Use uma senha de aplicativo exclusiva e revogável.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.setValue(s.appPassword).onChange(async (value) => {
          s.appPassword = value.trim();
          s.userId = "";
          await this.plugin.saveSettings();
        });
      });
  }

  private renderSync(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Sincronização").setHeading();

    new Setting(containerEl)
      .setName("Sincronização automática")
      .setDesc("Intervalo em minutos entre sincronizações automáticas. Use 0 para desativar.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.setValue(String(s.autoSyncMinutes)).onChange(async (value) => {
          s.autoSyncMinutes = Math.max(0, Math.floor(Number(value) || 0));
          await this.plugin.saveSettings();
          this.plugin.restartAutoSync();
        });
      });

    new Setting(containerEl).setName("Sincronizar ao abrir o Obsidian").addToggle((toggle) =>
      toggle.setValue(s.syncOnStartup).onChange(async (value) => {
        s.syncOnStartup = value;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl)
      .setName("Pastas ignoradas")
      .setDesc("Uma por linha, relativas ao cofre. Arquivos e pastas ocultos, como .obsidian, já são ignorados.")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text
          .setPlaceholder("Rascunhos\nAnexos/Grandes")
          .setValue(s.ignorePaths.join("\n"))
          .onChange(async (value) => {
            s.ignorePaths = value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.plugin.saveSettings();
          });
      });
  }

  private renderSafety(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Segurança").setHeading();

    new Setting(containerEl)
      .setName("Propagar exclusões")
      .setDesc(
        "Ativado: excluir um arquivo de um lado o exclui do outro. Desativado: o arquivo excluído é restaurado a partir do outro lado.",
      )
      .addToggle((toggle) =>
        toggle.setValue(s.propagateDeletions).onChange(async (value) => {
          s.propagateDeletions = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Confirmar exclusões no Nextcloud")
      .setDesc(
        "Ao excluir uma nota ou pasta sincronizada, pergunta se ela também deve ser excluída no Nextcloud. " +
          "A mesma confirmação é pedida quando uma sincronização for excluir arquivos no servidor.",
      )
      .setDisabled(!s.propagateDeletions)
      .addToggle((toggle) =>
        toggle
          .setValue(s.confirmRemoteDeletion)
          .setDisabled(!s.propagateDeletions)
          .onChange(async (value) => {
            s.confirmRemoteDeletion = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Limite de exclusões por sincronização")
      .setDesc("Se uma sincronização for excluir mais arquivos do que isso, ela é cancelada. Use 0 para não limitar.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.setValue(String(s.maxDeletions)).onChange(async (value) => {
          s.maxDeletions = Math.max(0, Math.floor(Number(value) || 0));
          await this.plugin.saveSettings();
        });
      });
  }

  private renderMaintenance(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Manutenção").setHeading();

    new Setting(containerEl)
      .setName("Redefinir estado de sincronização")
      .setDesc(
        "Esquece o histórico das sincronizações anteriores. Na próxima vez, os arquivos serão comparados como " +
          "numa primeira sincronização: nada é excluído e as diferenças viram cópias de conflito.",
      )
      .addButton((button) =>
        button
          .setButtonText("Redefinir")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetState();
            new Notice("NextSync: estado de sincronização redefinido.");
          }),
      );
  }
}
