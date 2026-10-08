import { App, Modal, Setting } from "obsidian";

export type DeletionChoice = "delete" | "keep";

export interface DeletionPrompt {
  title: string;
  message: string;
  keepHint: string;
  items: string[];
}

const VISIBLE_ITEMS = 12;

export class DeletionModal extends Modal {
  private choice: DeletionChoice = "keep";
  private resolver: ((choice: DeletionChoice) => void) | null = null;

  constructor(app: App, private readonly prompt: DeletionPrompt) {
    super(app);
  }

  ask(): Promise<DeletionChoice> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.prompt.title);
    contentEl.addClass("nextsync-deletion-modal");
    contentEl.createEl("p", { text: this.prompt.message });

    const list = contentEl.createEl("ul", { cls: "nextsync-deletion-list" });
    for (const item of this.prompt.items.slice(0, VISIBLE_ITEMS)) {
      list.createEl("li", { text: item });
    }
    const hidden = this.prompt.items.length - VISIBLE_ITEMS;
    if (hidden > 0) {
      contentEl.createEl("p", { text: `… e mais ${hidden} arquivo(s).`, cls: "nextsync-deletion-more" });
    }
    contentEl.createEl("p", { text: this.prompt.keepHint, cls: "setting-item-description" });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Manter no Nextcloud").onClick(() => this.finish("keep")),
      )
      .addButton((button) =>
        button
          .setButtonText("Excluir também no Nextcloud")
          .setWarning()
          .onClick(() => this.finish("delete")),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.choice);
    this.resolver = null;
  }

  private finish(choice: DeletionChoice): void {
    this.choice = choice;
    this.close();
  }
}
