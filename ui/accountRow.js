// SPDX-License-Identifier: GPL-3.0-or-later
// Account Row — Single account list item widget
// Displays issuer, label, OTP code, countdown arc, and copy button.

import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { generateTOTP, getTimeRemaining } from "../lib/totp.js";
import * as AccountManager from "../lib/accountManager.js";
import * as LogoFetcher from "../lib/logoFetcher.js";

const EXPIRING_THRESHOLD_S = 7;
const COPY_FEEDBACK_DURATION_MS = 1200;

function cssQuotedFontFamily(fontFamily) {
  return `"${String(fontFamily || "Monospace").replace(/["\\]/g, "")}"`;
}

export const AccountRow = GObject.registerClass(
  {
    Signals: {
      "code-copied": { param_types: [GObject.TYPE_STRING] },
      "account-edit": { param_types: [GObject.TYPE_STRING] },
      "account-delete": { param_types: [GObject.TYPE_STRING] },
      "account-move-up": { param_types: [GObject.TYPE_STRING] },
      "account-move-down": { param_types: [GObject.TYPE_STRING] },
      "request-refresh": {},
    },
  },
  class AccountRow extends St.BoxLayout {
    /**
     * @param {object} account - Account metadata object
     * @param {object} [options] - Display options
     * @param {string} [options.codeFont='Monospace'] - Font for OTP code
     * @param {number} [options.codeFontSize=28] - Font size for OTP code
     */
    _init(account, options = {}) {
      super._init({
        style_class: "totp-account-row",
        vertical: false,
        reactive: true,
        track_hover: true,
        can_focus: true,
        x_expand: true,
      });

      this._account = account;
      this._currentCode = "";
      this._codeFont = options.codeFont || "Monospace";
      this._codeFontSize = options.codeFontSize || 28;
      this._copyFeedbackTimeoutId = 0;
      this._isDestroyed = false;

      this._buildUI();
      this._setupContextMenu();
      this._refreshCode();

      this.connect("destroy", () => this._onDestroy());
    }

    /**
     * Build the row UI layout.
     * @private
     */
    _buildUI() {
      // === Avatar (logo or colored circle with initial letter) ===
      this._avatar = new St.Bin({
        style_class: "totp-account-avatar",
        style: `background-color: ${this._account.color || "#1a73e8"};`,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
      });

      const logoRef = this._account.logoPath || this._account.logoUrl;
      if (!this._setLogoAvatar(logoRef)) {
        this._setLetterAvatar();
        this._fetchAndSetLogo();
      }

      this.add_child(this._avatar);

      // === Info column (issuer + label + code) ===
      const infoBox = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        style_class: "totp-account-info",
        y_align: Clutter.ActorAlign.CENTER,
      });

      // Issuer name
      this._issuerLabel = new St.Label({
        text: this._account.issuer || "Unknown",
        style_class: "totp-account-issuer",
      });
      infoBox.add_child(this._issuerLabel);

      // Account label / email
      this._accountLabel = new St.Label({
        text: this._account.label || "",
        style_class: "totp-account-label",
      });
      infoBox.add_child(this._accountLabel);

      // OTP Code display
      this._codeLabel = new St.Label({
        text: "••• •••",
        style_class: "totp-account-code",
        style: `font-family: ${cssQuotedFontFamily(this._codeFont)}; font-size: ${this._codeFontSize}px;`,
      });
      infoBox.add_child(this._codeLabel);

      this.add_child(infoBox);

      // === Right side: countdown + copy button ===
      const actionsBox = new St.BoxLayout({
        vertical: true,
        style_class: "totp-account-actions",
        y_align: Clutter.ActorAlign.CENTER,
      });

      // Progress arc (simple text-based for reliability)
      this._progressBar = new St.DrawingArea({
        width: 32,
        height: 32,
        style_class: "totp-progress-arc",
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._progressBar.connect("repaint", () => this._paintArc());
      actionsBox.add_child(this._progressBar);

      this._copyButton = new St.Button({
        style_class: "totp-copy-button",
        child: new St.Icon({
          icon_name: "edit-copy-symbolic",
          icon_size: 16,
        }),
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._copyButton.connect("clicked", () => this._copyCodeToClipboard());
      actionsBox.add_child(this._copyButton);

      this.add_child(actionsBox);
    }

    /**
     * Paint the countdown arc using Cairo.
     * @private
     */
    _paintArc() {
      const cr = this._progressBar.get_context();
      const [width, height] = this._progressBar.get_surface_size();
      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) / 2 - 3;
      const lineWidth = 2.5;

      const remaining = getTimeRemaining(this._account.period || 30);
      const fraction = remaining / (this._account.period || 30);

      // Clear
      cr.setOperator(0); // CLEAR
      cr.paint();
      cr.setOperator(2); // OVER

      // Background track
      cr.setLineWidth(lineWidth);
      cr.setLineCap(1); // ROUND
      cr.setSourceRGBA(0.5, 0.5, 0.5, 0.15);
      cr.arc(centerX, centerY, radius, 0, 2 * Math.PI);
      cr.stroke();

      // Progress arc
      if (fraction > 0) {
        let r, g, b;
        if (remaining <= EXPIRING_THRESHOLD_S) {
          // Amber to red
          const t = 1 - remaining / EXPIRING_THRESHOLD_S;
          r = 0.91 + (0.8 - 0.91) * t;
          g = 0.58 + (0.13 - 0.58) * t;
          b = 0.04 + (0.13 - 0.04) * t;
        } else {
          // Accent blue
          r = 0.1;
          g = 0.45;
          b = 0.91;
        }

        cr.setSourceRGBA(r, g, b, 0.9);
        cr.setLineWidth(lineWidth);
        cr.setLineCap(1);

        const startAngle = -Math.PI / 2;
        const endAngle = startAngle + 2 * Math.PI * fraction;
        cr.arc(centerX, centerY, radius, startAngle, endAngle);
        cr.stroke();
      }

      // Seconds text
      cr.setSourceRGBA(0.85, 0.85, 0.85, 0.9);
      cr.selectFontFace("Sans", 0, 1); // NORMAL, BOLD
      cr.setFontSize(10);
      const text = `${remaining}`;
      const extents = cr.textExtents(text);
      cr.moveTo(
        centerX - extents.width / 2 - extents.xBearing,
        centerY - extents.height / 2 - extents.yBearing,
      );
      cr.showText(text);

      cr.$dispose();
    }

    /**
     * Set up right-click context menu.
     * @private
     */
    _setupContextMenu() {
      this._contextMenuManager = new PopupMenu.PopupMenuManager(this);

      this.connect("button-press-event", (actor, event) => {
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
          this._showContextMenu(this);
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });
    }

    /**
     * Show account actions menu.
     * @private
     */
    _showContextMenu(sourceActor) {
      if (this._contextMenu) {
        this._contextMenu.destroy();
      }

      this._contextMenu = new PopupMenu.PopupMenu(sourceActor, 0.5, St.Side.TOP);
      this._contextMenu.actor.add_style_class_name("totp-account-menu");
      this._contextMenu.actor.hide();
      this._contextMenu.connect("open-state-changed", (_menu, isOpen) => {
        if (!isOpen && this._contextMenu) {
          this._contextMenu.destroy();
          this._contextMenu = null;
        }
      });

      const editItem = new PopupMenu.PopupMenuItem("Edit Account");
      editItem.connect("activate", () => {
        this.emit("account-edit", this._account.id);
      });
      this._contextMenu.addMenuItem(editItem);

      const moveUpItem = new PopupMenu.PopupMenuItem("Move Up");
      moveUpItem.connect("activate", () => {
        this.emit("account-move-up", this._account.id);
      });
      this._contextMenu.addMenuItem(moveUpItem);

      const moveDownItem = new PopupMenu.PopupMenuItem("Move Down");
      moveDownItem.connect("activate", () => {
        this.emit("account-move-down", this._account.id);
      });
      this._contextMenu.addMenuItem(moveDownItem);

      this._contextMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      const deleteItem = new PopupMenu.PopupMenuItem("Delete Account");
      deleteItem.connect("activate", () => {
        this.emit("account-delete", this._account.id);
      });
      this._contextMenu.addMenuItem(deleteItem);

      Main.uiGroup.add_child(this._contextMenu.actor);
      this._contextMenuManager.addMenu(this._contextMenu);
      this._contextMenu.open();
    }

    /**
     * Refresh the OTP code display.
     */
    _refreshCode() {
      if (this._isDestroyed) return;

      try {
        // Get secret from keyring (sync for UI responsiveness)
        const secret = AccountManager.getSecretSync(this._account.id);
        if (!secret) {
          this._codeLabel.text = "No Key";
          this._codeLabel.add_style_class_name("totp-code-error");
          return;
        }

        // Generate TOTP code
        const code = generateTOTP({
          secret,
          algorithm: this._account.algorithm || "SHA1",
          digits: this._account.digits || 6,
          period: this._account.period || 30,
        });

        this._currentCode = code;

        // Format code with space in middle (e.g., "482 301")
        const mid = Math.ceil(code.length / 2);
        this._codeLabel.text = `${code.substring(0, mid)} ${code.substring(mid)}`;

        const remaining = getTimeRemaining(this._account.period || 30);

        // Update visual state based on remaining time
        this._updateExpiryState(remaining);

        // Repaint arc
        this._progressBar.queue_repaint();
      } catch (e) {
        this._codeLabel.text = "Error";
        this._codeLabel.add_style_class_name("totp-code-error");
        console.error(
          `[TOTP] Code generation error for ${this._account.issuer}: ${e.message}`,
        );
      }
    }

    /**
     * Update visual styling when code is about to expire.
     * @private
     */
    _updateExpiryState(remaining) {
      if (remaining <= EXPIRING_THRESHOLD_S) {
        this._codeLabel.add_style_class_name("totp-code-expiring");
      } else {
        this._codeLabel.remove_style_class_name("totp-code-expiring");
      }
    }

    /**
     * Copy the current OTP code to the clipboard so it can be pasted.
     * @private
     */
    _copyCodeToClipboard() {
      if (!this._currentCode) return;

      const clipboard = St.Clipboard.get_default();
      clipboard.set_text(St.ClipboardType.CLIPBOARD, this._currentCode);

      AccountManager.touchAccount(this._account.id);
      this._showCopyFeedback();
      this.emit("code-copied", this._account.id);
    }

    /**
     * Show short visual feedback after copying.
     * @private
     */
    _showCopyFeedback() {
      if (!this._copyButton) return;

      const icon = this._copyButton.child;
      icon.icon_name = "emblem-ok-symbolic";
      this._copyButton.add_style_class_name("totp-copy-success");

      if (this._copyFeedbackTimeoutId) {
        GLib.source_remove(this._copyFeedbackTimeoutId);
      }

      this._copyFeedbackTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        COPY_FEEDBACK_DURATION_MS,
        () => {
          if (!this._isDestroyed && this._copyButton) {
            icon.icon_name = "edit-copy-symbolic";
            this._copyButton.remove_style_class_name("totp-copy-success");
          }
          this._copyFeedbackTimeoutId = 0;
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    /**
     * Update the display (called by parent timer).
     */
    refresh() {
      this._refreshCode();
    }

    /**
     * Get the account ID.
     * @returns {string}
     */
    get accountId() {
      return this._account.id;
    }

    /**
     * Get the account data.
     * @returns {object}
     */
    get account() {
      return this._account;
    }

    /**
     * Set avatar with a logo image.
     * @private
     */
    _setLogoAvatar(logoRef) {
      if (!logoRef || String(logoRef).startsWith("http")) {
        return false;
      }

      const file = Gio.File.new_for_path(logoRef);
      if (!file.query_exists(null)) return false;

      this._avatar.child = new St.Icon({
        gicon: new Gio.FileIcon({ file }),
        icon_size: 24,
        style_class: "totp-account-avatar-logo",
      });
      return true;
    }

    /**
     * Set avatar with a letter (fallback).
     * @private
     */
    _setLetterAvatar() {
      const avatarLetter = (this._account.issuer ||
        this._account.label ||
        "?")[0].toUpperCase();
      this._avatar.child = new St.Label({
        text: avatarLetter,
        style: "font-size: 14px; font-weight: bold; color: white;",
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
      });
    }

    /**
     * Fetch logo asynchronously and update avatar.
     * @private
     */
    async _fetchAndSetLogo() {
      const logo = await LogoFetcher.fetchLogo(
        this._account.siteUrl || this._account.issuer,
      );
      if (!logo?.url || this._isDestroyed) return;

      this._account.logoUrl = logo.url;
      this._account.logoPath = logo.path ?? null;

      if (logo.path) {
        this._setLogoAvatar(logo.path);
      }

      AccountManager.updateAccount(this._account.id, {
        logoUrl: logo.url,
        logoPath: logo.path ?? null,
      });
    }

    /**
     * Clean up on destroy.
     * @private
     */
    _onDestroy() {
      this._isDestroyed = true;

      if (this._copyFeedbackTimeoutId) {
        GLib.source_remove(this._copyFeedbackTimeoutId);
        this._copyFeedbackTimeoutId = 0;
      }

      if (this._contextMenu) {
        this._contextMenu.destroy();
        this._contextMenu = null;
      }
    }
  },
);
