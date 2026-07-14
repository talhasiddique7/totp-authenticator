// SPDX-License-Identifier: GPL-3.0-or-later
// Main Popup — Primary dropdown menu content

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { AccountRow } from './accountRow.js';
import { EmptyState } from './emptyState.js';
import { AddAccountDialog } from './addAccountDialog.js';
import { ConfirmDeleteDialog } from './confirmDeleteDialog.js';
import * as AccountManager from '../lib/accountManager.js';

const REFRESH_INTERVAL_MS = 1000;

function entryText(entry) {
    return entry.clutter_text.get_text();
}

export const MainPopup = GObject.registerClass(
class MainPopup extends St.BoxLayout {
    _init(settings, path) {
        super._init({
            vertical: true,
            style_class: 'totp-main-popup',
        });

        this._settings = settings;
        this._path = path;
        this._accountRows = [];
        this._refreshTimerId = 0;
        this._searchActive = false;
        this._isDestroyed = false;

        this._buildUI();
    }

    _buildUI() {
        // Header bar
        const header = new St.BoxLayout({
            style_class: 'totp-popup-header',
            x_expand: true,
        });

        // TOTP icon from extension icons folder
        const iconPath = GLib.build_filenamev([this._path, 'icons', 'totp-symbolic.svg']);
        const iconFile = Gio.File.new_for_path(iconPath);
        const icon = new Gio.FileIcon({ file: iconFile });
        const headerIcon = new St.Icon({
            gicon: icon,
            icon_size: 18,
            style_class: 'totp-header-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(headerIcon);

        const titleLabel = new St.Label({
            text: 'Authenticator',
            style_class: 'totp-popup-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(titleLabel);

        // Add button
        const addButton = new St.Button({
            style_class: 'totp-header-button',
            child: new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 16 }),
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        addButton.connect('clicked', () => this._onAddAccount());
        header.add_child(addButton);

        // Settings button
        const settingsButton = new St.Button({
            style_class: 'totp-header-button',
            child: new St.Icon({ icon_name: 'emblem-system-symbolic', icon_size: 16 }),
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        settingsButton.connect('clicked', () => this._onOpenSettings());
        header.add_child(settingsButton);

        this.add_child(header);

        // Separator
        this.add_child(new St.Widget({
            style_class: 'totp-separator',
            x_expand: true,
            height: 1,
        }));

        // Search field
        this._searchEntry = new St.Entry({
            hint_text: 'Search accounts...',
            style_class: 'totp-search-entry',
            can_focus: true,
            x_expand: true,
        });
        this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this.add_child(this._searchEntry);

        // Scrollable account list
        this._scrollView = new St.ScrollView({
            style_class: 'totp-scroll-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });

        this._accountList = new St.BoxLayout({
            vertical: true,
            style_class: 'totp-account-list',
            x_expand: true,
        });
        this._scrollView.set_child(this._accountList);
        this.add_child(this._scrollView);

        // Empty state
        this._emptyState = new EmptyState(this._path);
        this._emptyState.connect('scan-qr', () => this._onAddAccount('qr'));
        this._emptyState.connect('enter-manually', () => this._onAddAccount('manual'));
        this.add_child(this._emptyState);
    }

    /**
     * Refresh the account list from storage.
     */
    refreshAccounts() {
        if (this._isDestroyed) return;

        // Clear existing rows
        this._accountRows.forEach(row => row.destroy());
        this._accountRows = [];
        this._accountList.destroy_all_children();

        // Load accounts
        const sortOrder = this._settings
            ? this._settings.get_string('sort-order')
            : 'manual';
        const accounts = AccountManager.getAccounts(sortOrder);

        // Toggle search visibility
        const showSearch = accounts.length > 5;
        if (showSearch) this._searchEntry.show();
        else this._searchEntry.hide();

        // Toggle empty state vs account list
        if (accounts.length === 0) {
            this._emptyState.show();
            this._scrollView.hide();
        } else {
            this._emptyState.hide();
            this._scrollView.show();

            const codeFont = this._settings
                ? this._settings.get_string('code-font')
                : 'Monospace';
            const codeFontSize = this._settings
                ? this._settings.get_int('code-size')
                : 28;
            for (const account of accounts) {
                const row = new AccountRow(account, {
                    codeFont,
                    codeFontSize,
                });
                row.connect('account-edit', (_w, id) => this._onEditAccount(id));
                row.connect('account-delete', (_w, id) => this._onDeleteAccount(id));
                row.connect('account-move-up', (_w, id) => {
                    this._useManualSort();
                    AccountManager.moveAccountUp(id);
                    this.refreshAccounts();
                });
                row.connect('account-move-down', (_w, id) => {
                    this._useManualSort();
                    AccountManager.moveAccountDown(id);
                    this.refreshAccounts();
                });
                this._accountList.add_child(row);
                this._accountRows.push(row);
            }
        }
    }

    _useManualSort() {
        if (this._settings && this._settings.get_string('sort-order') !== 'manual') {
            this._settings.set_string('sort-order', 'manual');
        }
    }

    /**
     * Start the periodic code refresh timer.
     */
    startRefreshTimer() {
        this.stopRefreshTimer();
        this._refreshTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_MS,
            () => {
                if (this._isDestroyed) return GLib.SOURCE_REMOVE;
                this._accountRows.forEach(row => row.refresh());
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    /**
     * Stop the periodic code refresh timer.
     */
    stopRefreshTimer() {
        if (this._refreshTimerId) {
            GLib.source_remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
    }

    _onSearchChanged() {
        const query = entryText(this._searchEntry).toLowerCase().trim();
        this._accountRows.forEach(row => {
            const acct = row.account;
            const match = !query ||
                (acct.issuer || '').toLowerCase().includes(query) ||
                (acct.label || '').toLowerCase().includes(query);
            if (match) row.show();
            else row.hide();
        });
    }

    _onAddAccount(tab = null) {
        const dialog = new AddAccountDialog();
        dialog.connect('account-added', () => {
            this.refreshAccounts();
        });
        dialog.connect('account-updated', () => {
            this.refreshAccounts();
        });
        dialog.open();
        if (tab === 'manual' && dialog._issuerEntry) {
            dialog._issuerEntry.grab_key_focus();
        }
    }

    _onEditAccount(id) {
        const account = AccountManager.getAccount(id);
        if (!account) {
            return;
        }

        const dialog = new AddAccountDialog();
        dialog.setAccount(account);
        dialog.connect('account-updated', () => {
            this.refreshAccounts();
        });
        dialog.open();
    }

    async _onDeleteAccount(id) {
        const account = AccountManager.getAccount(id);
        if (!account) {
            return;
        }

        const displayName = account.issuer || account.label || 'this account';
        const confirmDialog = new ConfirmDeleteDialog(displayName);
        confirmDialog.connect('confirmed', async () => {
            try {
                await AccountManager.deleteAccount(id);
                this.refreshAccounts();
            } catch (e) {
                console.error(`[TOTP] Failed to delete account: ${e.message}`);
            }
        });
        confirmDialog.open();
    }

    _onOpenSettings() {
        try {
            GLib.spawn_command_line_async(
                'gnome-extensions prefs gnome-totp-authenticator@talhasiddique7'
            );
        } catch (e) {
            console.error(`[TOTP] Failed to open settings: ${e.message}`);
        }
    }

    destroy() {
        this._isDestroyed = true;
        this.stopRefreshTimer();
        this._accountRows.forEach(row => row.destroy());
        this._accountRows = [];
        super.destroy();
    }
});
