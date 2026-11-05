// SPDX-License-Identifier: GPL-3.0-or-later
// Confirm Delete Dialog — asks user before removing an account.

import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";

export const ConfirmDeleteDialog = GObject.registerClass(
  {
    Signals: {
      confirmed: {},
    },
  },
  class ConfirmDeleteDialog extends ModalDialog.ModalDialog {
    _init(accountName = "this account") {
      super._init({
        styleClass: "totp-add-account-dialog",
        destroyOnClose: true,
      });

      const content = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "totp-dialog-content",
      });

      content.add_child(
        new St.Label({
          text: "Delete Account",
          style_class: "totp-dialog-title",
        }),
      );

      content.add_child(
        new St.Label({
          text: `Are you sure you want to delete ${accountName}?`,
          style_class: "totp-dialog-status",
        }),
      );

      this.contentLayout.add_child(content);

      this.addButton({
        label: "Cancel",
        action: () => this.close(),
      });
      this.addButton({
        label: "Delete",
        action: () => {
          this.emit("confirmed");
          this.close();
        },
      });
    }
  },
);
