// SPDX-License-Identifier: GPL-3.0-or-later
// Add Account Dialog — Modal dialog for adding/editing TOTP accounts

import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";

import * as AccountManager from "../lib/accountManager.js";
import * as LogoFetcher from "../lib/logoFetcher.js";
import * as QRScanner from "../lib/qrScanner.js";
import { parseOtpauthUri } from "../lib/otpauth.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function entryGetText(entry) {
  return entry.clutter_text.get_text();
}

function entrySetText(entry, value) {
  entry.clutter_text.set_text(value ?? "");
}

// ─── Component ───────────────────────────────────────────────────────────────

export const AddAccountDialog = GObject.registerClass(
  {
    Signals: {
      "account-added": {},
      "account-updated": {},
    },
  },
  class AddAccountDialog extends ModalDialog.ModalDialog {

    // ── Lifecycle ────────────────────────────────────────────────────────────

    _init() {
      super._init({
        styleClass: "totp-add-account-dialog",
        destroyOnClose: true,
      });

      this._editingAccount    = null;
      this._selectedLogoUrl   = null;
      this._selectedLogoPath  = null;
      this._selectedLogoSource = null;
      this._logoFetchTimeoutId = 0;
      this._selectedAlgorithm = "SHA1";
      this._selectedDigits    = 6;
      this._selectedPeriod    = 30;
      this._busy              = false;

      this._buildUI();
    }

    // ── UI Construction ──────────────────────────────────────────────────────

    _buildUI() {
      // Root container
      const root = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "totp-dialog-root",
        x_expand: true,
      });

      // ── Title bar ─────────────────────────────────────────────────────────
      const titleBar = new St.BoxLayout({
        style_class: "totp-dialog-titlebar",
        x_expand: true,
      });

      const titleIcon = new St.Icon({
        icon_name: "security-high-symbolic",
        style_class: "totp-dialog-icon",
      });
      titleBar.add_child(titleIcon);

      const titleStack = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL });
      this._titleLabel = new St.Label({
        text: "Add Account",
        style_class: "totp-dialog-title",
      });
      this._subtitleLabel = new St.Label({
        text: "TOTP / Two-factor authentication",
        style_class: "totp-dialog-subtitle",
      });
      titleStack.add_child(this._titleLabel);
      titleStack.add_child(this._subtitleLabel);
      titleBar.add_child(titleStack);
      root.add_child(titleBar);

      // Separator
      root.add_child(new St.Widget({ style_class: "totp-separator", x_expand: true }));

      const qrActions = new St.BoxLayout({
        style_class: "totp-form-row",
        x_expand: true,
      });
      this._scanScreenButton = new St.Button({
        label: "Capture Screen Area",
        style_class: "totp-button totp-button-secondary",
        reactive: true,
        can_focus: true,
        x_expand: true,
      });
      this._scanScreenButton.connect("clicked", () => this.scanQrCode("screen"));
      this._scanCameraButton = new St.Button({
        label: "Use Camera",
        style_class: "totp-button totp-button-secondary",
        reactive: true,
        can_focus: true,
        x_expand: true,
      });
      this._scanCameraButton.connect("clicked", () => this.scanQrCode("camera"));
      qrActions.add_child(this._scanScreenButton);
      qrActions.add_child(this._scanCameraButton);
      root.add_child(qrActions);

      // ── Section header ─────────────────────────────────────────────────────
      root.add_child(new St.Label({
        text: "MANUAL ENTRY",
        style_class: "totp-section-divider",
      }));

      // ── Row 1: Issuer | Account ────────────────────────────────────────────
      const row1 = new St.BoxLayout({ style_class: "totp-form-row", x_expand: true });

      const issuerCell = this._makeCell("SERVICE / ISSUER");
      this._issuerEntry = this._makeEntry("e.g. Google, GitHub");
      issuerCell.add_child(this._issuerEntry);

      // Logo preview inline under issuer
      this._logoPreview = new St.Bin({
        style_class: "totp-logo-preview",
        visible: false,
        x_align: Clutter.ActorAlign.START,
      });
      issuerCell.add_child(this._logoPreview);

      const labelCell = this._makeCell("ACCOUNT");
      this._labelEntry = this._makeEntry("e.g. user@example.com");
      labelCell.add_child(this._labelEntry);

      row1.add_child(issuerCell);
      row1.add_child(labelCell);
      root.add_child(row1);

      // ── Row 2: Site URL | Secret ───────────────────────────────────────────
      const row2 = new St.BoxLayout({ style_class: "totp-form-row", x_expand: true });

      const siteCell = this._makeCell("SITE URL (OPTIONAL)");
      this._siteUrlEntry = this._makeEntry("https://google.com");
      this._siteUrlEntry.clutter_text.connect("text-changed", () => this._onSiteUrlChanged());
      siteCell.add_child(this._siteUrlEntry);

      const secretCell = this._makeCell("SECRET KEY (BASE32)");
      this._secretEntry = this._makeEntry("JBSWY3DPEHPK3PXP");
      this._secretEntry.clutter_text.set_password_char("\u2022"); // show as dots

      // Toggle secret visibility
      this._secretToggle = new St.Button({
        label: "Show",
        style_class: "totp-dropdown-button",
        reactive: true,
        can_focus: true,
      });
      this._secretVisible = false;
      this._secretToggle.connect("clicked", () => {
        this._secretVisible = !this._secretVisible;
        this._secretEntry.clutter_text.set_password_char(
          this._secretVisible ? "\0" : "\u2022"
        );
        this._secretToggle.set_label(this._secretVisible ? "Hide" : "Show");
      });
      const secretRow = new St.BoxLayout({ style_class: "totp-secret-row", x_expand: true });
      secretRow.add_child(this._secretEntry);
      secretRow.add_child(this._secretToggle);
      secretCell.add_child(secretRow);

      row2.add_child(siteCell);
      row2.add_child(secretCell);
      root.add_child(row2);

      // ── Row 3: Algorithm | Digits | Period ────────────────────────────────
      const row3 = new St.BoxLayout({ style_class: "totp-form-row", x_expand: true });

      // Algorithm
      const algoCell = this._makeCell("ALGORITHM");
      this._algorithmDropdown = this._makeDropdown("SHA1 ▾", () => this._cycleAlgorithm());
      algoCell.add_child(this._algorithmDropdown);

      // Digits
      const digitsCell = this._makeCell("DIGITS");
      this._digitsDropdown = this._makeDropdown("6 ▾", () => this._cycleDigits());
      digitsCell.add_child(this._digitsDropdown);

      // Period
      const periodCell = this._makeCell("PERIOD (SEC)");
      this._periodDropdown = this._makeDropdown("30 ▾", () => this._cyclePeriod());
      periodCell.add_child(this._periodDropdown);

      row3.add_child(algoCell);
      row3.add_child(digitsCell);
      row3.add_child(periodCell);
      root.add_child(row3);

      // ── Primary action button ──────────────────────────────────────────────
      this._submitBtn = new St.Button({
        label: "Add Account",
        style_class: "totp-btn-primary",
        reactive: true,
        can_focus: true,
        x_expand: true,
      });
      this._submitBtn.connect("clicked", () => {
        if (this._busy) return;
        this._onAddManual();
      });
      root.add_child(this._submitBtn);

      // ── Status label ───────────────────────────────────────────────────────
      this._statusLabel = new St.Label({
        text: "",
        style_class: "totp-status",
        x_expand: true,
      });
      root.add_child(this._statusLabel);

      this.contentLayout.add_child(root);

      // ── Dialog footer button ───────────────────────────────────────────────
      this.addButton({
        label: "Cancel",
        action: () => this.close(),
        key: Clutter.KEY_Escape,
      });
    }

    // ── Small factory helpers ─────────────────────────────────────────────────

    _makeCell(labelText) {
      const cell = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
      });
      cell.add_child(new St.Label({
        text: labelText,
        style_class: "totp-field-label",
      }));
      return cell;
    }

    _makeEntry(hint) {
      return new St.Entry({
        hint_text: hint,
        style_class: "totp-entry",
        can_focus: true,
        x_expand: true,
      });
    }

    _makeDropdown(label, onClick) {
      const btn = new St.Button({
        label,
        style_class: "totp-dropdown-button",
        can_focus: true,
        reactive: true,
        x_expand: true,
      });
      btn.connect("clicked", onClick);
      return btn;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Call before open() to switch to edit mode. */
    setAccount(account) {
      this._editingAccount = account;
      this._titleLabel.set_text("Edit Account");
      this._subtitleLabel.set_text("Update your TOTP account details");
      this._submitBtn.set_label("Save Changes");
      this._populateFromAccount();
    }

    focusPrimaryField() {
      this._issuerEntry?.grab_key_focus();
    }

    async scanQrCode(source = "screen") {
      if (this._busy) return;

      this._setBusy(true);
      this._setStatus("Scanning for an otpauth QR code…");
      try {
        const uri = source === "camera"
          ? await QRScanner.scanCamera()
          : await QRScanner.scanScreenArea();
        const account = parseOtpauthUri(uri);
        if (account.type !== "totp") {
          throw new Error("HOTP accounts are not supported");
        }

        entrySetText(this._issuerEntry, account.issuer);
        entrySetText(this._labelEntry, account.label);
        entrySetText(this._secretEntry, account.secret);
        this._selectedAlgorithm = account.algorithm;
        this._selectedDigits = account.digits;
        this._selectedPeriod = account.period;
        this._refreshDropdownLabels();
        this._setStatus("QR code decoded. Review the details before saving.", "ok");
      } catch (error) {
        this._setStatus(`QR scan failed: ${error.message}`, "error");
      } finally {
        this._setBusy(false);
      }
    }

    // ── Populate fields from existing account ─────────────────────────────────

    _populateFromAccount() {
      const a = this._editingAccount;
      if (!a) return;

      entrySetText(this._issuerEntry, a.issuer ?? "");
      entrySetText(this._labelEntry,  a.label  ?? "");
      entrySetText(this._siteUrlEntry, a.siteUrl ?? "");

      // Secret: keep empty — hint explains behaviour
      entrySetText(this._secretEntry, "");
      this._secretEntry.hint_text = "Leave blank to keep existing secret";

      this._selectedAlgorithm = a.algorithm ?? "SHA1";
      this._selectedDigits    = a.digits    ?? 6;
      this._selectedPeriod    = a.period    ?? 30;

      this._refreshDropdownLabels();

      if (a.logoUrl || a.logoPath) {
        this._selectedLogoUrl = a.logoUrl;
        this._selectedLogoPath = a.logoPath ?? null;
        this._selectedLogoSource = a.siteUrl || null;
        this._showLogoPreview(a.logoPath || a.logoUrl);
      }
    }

    // ── Logo fetching ──────────────────────────────────────────────────────────

    _onSiteUrlChanged() {
      const url    = entryGetText(this._siteUrlEntry).trim();
      this._scheduleLogo(url ? () => this._fetchLogo(url) : null);
    }

    _scheduleLogo(fn) {
      if (this._logoFetchTimeoutId) {
        GLib.source_remove(this._logoFetchTimeoutId);
        this._logoFetchTimeoutId = 0;
      }
      if (!fn) {
        this._logoPreview.visible = false;
        this._selectedLogoUrl = null;
        this._selectedLogoPath = null;
        this._selectedLogoSource = null;
        return;
      }
      this._logoFetchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        this._logoFetchTimeoutId = 0;
        fn();
        return GLib.SOURCE_REMOVE;
      });
    }

    async _fetchLogo(siteUrl) {
      const logo = await LogoFetcher.fetchLogo(siteUrl);

      const curUrl    = entryGetText(this._siteUrlEntry).trim();
      if (curUrl !== siteUrl || !logo?.url) return;

      this._selectedLogoUrl = logo.url;
      this._selectedLogoPath = logo.path ?? null;
      this._selectedLogoSource = siteUrl;
      this._showLogoPreview(logo.path || logo.url);
    }

    _showLogoPreview(logoRef) {
      const iconProps = {
        icon_size: 18,
        style_class: "totp-logo-icon",
      };

      if (logoRef && !String(logoRef).startsWith("http")) {
        const file = Gio.File.new_for_path(logoRef);
        if (!file.query_exists(null)) {
          this._logoPreview.visible = false;
          return;
        }
        iconProps.gicon = new Gio.FileIcon({ file });
      } else {
        iconProps.icon_name = "image-x-generic-symbolic";
      }

      this._logoPreview.set_child(new St.Icon(iconProps));
      this._logoPreview.visible = true;
    }

    // ── Dropdown cycling ───────────────────────────────────────────────────────

    _cycleAlgorithm() {
      const opts  = ["SHA1", "SHA256", "SHA512"];
      const idx   = opts.indexOf(this._selectedAlgorithm);
      this._selectedAlgorithm = opts[(idx + 1) % opts.length];
      this._algorithmDropdown.set_label(`${this._selectedAlgorithm} ▾`);
    }

    _cycleDigits() {
      const opts = [6, 7, 8];
      const idx  = opts.indexOf(this._selectedDigits);
      this._selectedDigits = opts[(idx + 1) % opts.length];
      this._digitsDropdown.set_label(`${this._selectedDigits} ▾`);
    }

    _cyclePeriod() {
      const opts = [30, 60];
      const idx  = opts.indexOf(this._selectedPeriod);
      this._selectedPeriod = opts[(idx + 1) % opts.length];
      this._periodDropdown.set_label(`${this._selectedPeriod} ▾`);
    }

    _refreshDropdownLabels() {
      this._algorithmDropdown.set_label(`${this._selectedAlgorithm} ▾`);
      this._digitsDropdown.set_label(`${this._selectedDigits} ▾`);
      this._periodDropdown.set_label(`${this._selectedPeriod} ▾`);
    }

    // ── Status helpers ────────────────────────────────────────────────────────

    _setStatus(text, kind = "neutral") {
      // kind: "neutral" | "ok" | "error"
      this._statusLabel.set_text(text);
      this._statusLabel.remove_style_class_name("totp-status-error");
      this._statusLabel.remove_style_class_name("totp-status-ok");
      if (kind === "error") this._statusLabel.add_style_class_name("totp-status-error");
      if (kind === "ok")    this._statusLabel.add_style_class_name("totp-status-ok");
    }

    _setBusy(busy) {
      this._busy = busy;
      this._submitBtn.reactive = !busy;
      // Dim the button while working
      this._submitBtn.opacity = busy ? 140 : 255;
    }

    // ── Main submit handler ────────────────────────────────────────────────────

    async _onAddManual() {
      try {
        const issuer    = entryGetText(this._issuerEntry).trim();
        const label     = entryGetText(this._labelEntry).trim();
        const siteUrl   = entryGetText(this._siteUrlEntry).trim();
        const rawSecret = entryGetText(this._secretEntry).trim();
        const secret    = rawSecret.replace(/\s+/g, "").toUpperCase();

        const algorithm = this._selectedAlgorithm ?? "SHA1";
        const digits    = this._selectedDigits    ?? 6;
        const period    = this._selectedPeriod    ?? 30;
        const logoSource = siteUrl;

        if (!this._editingAccount && !secret) {
          this._setStatus("Secret key is required.", "error");
          return;
        }
        if (secret && !/^[A-Z2-7]+=*$/.test(secret)) {
          this._setStatus("Secret must be a valid Base32 string.", "error");
          return;
        }
        if (!issuer && !label) {
          this._setStatus("Please enter at least a service name or account.", "error");
          return;
        }

        if (logoSource && (this._selectedLogoSource !== logoSource || !this._selectedLogoPath)) {
          this._setBusy(true);
          this._setStatus("Fetching logo…");
          const logo = await LogoFetcher.fetchLogo(logoSource);
          if (logo?.url) {
            this._selectedLogoUrl = logo.url;
            this._selectedLogoPath = logo.path ?? null;
            this._selectedLogoSource = logoSource;
            this._showLogoPreview(logo.path || logo.url);
          }
        }

        const accountData = {
          label,
          issuer: issuer || "Unknown",
          siteUrl: siteUrl || null,
          algorithm,
          digits,
          period,
          logoUrl: this._selectedLogoUrl || null,
          logoPath: this._selectedLogoPath || null,
        };

        this._setBusy(true);

        if (this._editingAccount) {
          this._setStatus("Saving changes…");

          await AccountManager.updateAccountWithSecret(
            this._editingAccount.id,
            accountData,
            secret || null,
          );

          this._setStatus("Account updated successfully.", "ok");
          this.emit("account-updated");
        } else {
          this._setStatus("Adding account…");
          await AccountManager.addAccount({ ...accountData, secret });

          this._setStatus("Account added successfully.", "ok");
          this.emit("account-added");
        }

        this._resetFields();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
          this.close();
          return GLib.SOURCE_REMOVE;
        });
      } catch (e) {
        console.error(`[TOTP] _onAddManual: ${e.message}`);
        this._setStatus(`Error: ${e.message}`, "error");
        this._setBusy(false);
      }
    }

    // ── Reset ─────────────────────────────────────────────────────────────────

    _resetFields() {
      entrySetText(this._issuerEntry,  "");
      entrySetText(this._labelEntry,   "");
      entrySetText(this._siteUrlEntry, "");
      entrySetText(this._secretEntry,  "");
      this._logoPreview.visible = false;
      this._selectedLogoUrl = null;
      this._selectedLogoPath = null;
      this._selectedLogoSource = null;
      this._setBusy(false);
    }

    // ── Cleanup ────────────────────────────────────────────────────────────────

    destroy() {
      if (this._logoFetchTimeoutId) {
        GLib.source_remove(this._logoFetchTimeoutId);
        this._logoFetchTimeoutId = 0;
      }
      super.destroy();
    }
  },
);
