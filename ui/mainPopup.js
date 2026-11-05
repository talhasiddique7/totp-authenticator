// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as AccountManager from '../lib/accountManager.js';
import { AccountRow } from './accountRow.js';
import { AddAccountDialog } from './addAccountDialog.js';
import { ConfirmDeleteDialog } from './confirmDeleteDialog.js';
import { EmptyState } from './emptyState.js';

const REFRESH_INTERVAL_MS = 1000;
const SEARCH_THRESHOLD = 5;

function entryText(entry) {
    return entry.clutter_text.get_text();
}

export const MainPopup = GObject.registerClass(
class MainPopup extends St.BoxLayout {
    _init(settings, path, options = {}) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'totp-main-popup',
        });

        this._settings = settings;
        this._path = path;
        this._onOpenPreferences = options.onOpenPreferences ?? null;
        this._accountRows = [];
        this._refreshTimerId = 0;
        this._isDestroyed = false;

        this._buildUI();
    }

    _buildUI() {
        const header = new St.BoxLayout({
            style_class: 'totp-popup-header',
            x_expand: true,
        });

        const iconPath = GLib.build_filenamev([this._path, 'icons', 'totp-symbolic.svg']);
        const iconFile = Gio.File.new_for_path(iconPath);
        header.add_child(new St.Icon({
            gicon: new Gio.FileIcon({ file: iconFile }),
            icon_size: 18,
            style_class: 'totp-header-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        header.add_child(new St.Label({
            text: 'Authenticator',
            style_class: 'totp-popup-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        header.add_child(this._createHeaderButton('list-add-symbolic', () => this._onAddAccount()));
        header.add_child(this._createHeaderButton('emblem-system-symbolic', () => this._onOpenSettings()));
        this.add_child(header);

        this.add_child(new St.Widget({
            style_class: 'totp-separator',
            x_expand: true,
            height: 1,
        }));

        this._searchEntry = new St.Entry({
            hint_text: 'Search accounts...',
            style_class: 'totp-search-entry',
            can_focus: true,
            x_expand: true,
        });
        this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this.add_child(this._searchEntry);

        this._scrollView = new St.ScrollView({
            style_class: 'totp-scroll-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });

        this._accountList = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'totp-account-list',
            x_expand: true,
        });
        this._scrollView.set_child(this._accountList);
        this.add_child(this._scrollView);

        this._emptyState = new EmptyState(this._path);
        this._emptyState.connect('scan-qr', () => this._onAddAccount('qr'));
        this._emptyState.connect('enter-manually', () => this._onAddAccount('manual'));
        this.add_child(this._emptyState);
    }

    _createHeaderButton(iconName, onClick) {
        const button = new St.Button({
            style_class: 'totp-header-button',
            child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        return button;
    }

    refreshAccounts() {
        if (this._isDestroyed) {
            return;
        }

        this._clearAccountRows();

        const sortOrder = this._settings ? this._settings.get_string('sort-order') : 'manual';
        const accounts = AccountManager.getAccounts(sortOrder);

        if (accounts.length > SEARCH_THRESHOLD) {
            this._searchEntry.show();
        } else {
            this._searchEntry.clutter_text.set_text('');
            this._searchEntry.hide();
        }

        if (accounts.length === 0) {
            this._emptyState.show();
            this._scrollView.hide();
            return;
        }

        this._emptyState.hide();
        this._scrollView.show();

        const codeFont = this._settings ? this._settings.get_string('code-font') : 'Monospace';
        const codeFontSize = this._settings ? this._settings.get_int('code-size') : 28;

        for (const account of accounts) {
            const row = this._createAccountRow(account, codeFont, codeFontSize);
            this._accountList.add_child(row);
            this._accountRows.push(row);
        }

        this._onSearchChanged();
    }

    _clearAccountRows() {
        this._accountRows.forEach(row => row.destroy());
        this._accountRows = [];
        this._accountList.destroy_all_children();
    }

    _createAccountRow(account, codeFont, codeFontSize) {
        const row = new AccountRow(account, { codeFont, codeFontSize });
        row.connect('account-edit', (_widget, id) => this._onEditAccount(id));
        row.connect('account-delete', (_widget, id) => this._onDeleteAccount(id));
        row.connect('account-move-up', (_widget, id) => this._moveAccount(id, -1));
        row.connect('account-move-down', (_widget, id) => this._moveAccount(id, 1));
        return row;
    }

    _moveAccount(id, direction) {
        this._useManualSort();

        if (direction < 0) {
            AccountManager.moveAccountUp(id);
        } else {
            AccountManager.moveAccountDown(id);
        }

        this.refreshAccounts();
    }

    _useManualSort() {
        if (this._settings && this._settings.get_string('sort-order') !== 'manual') {
            this._settings.set_string('sort-order', 'manual');
        }
    }

    startRefreshTimer() {
        this.stopRefreshTimer();
        this._refreshTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_MS,
            () => {
                if (this._isDestroyed) {
                    return GLib.SOURCE_REMOVE;
                }

                this._accountRows.forEach(row => row.refresh());
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    stopRefreshTimer() {
        if (this._refreshTimerId) {
            GLib.source_remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
    }

    clearSensitiveState() {
        this._clearAccountRows();
    }

    _onSearchChanged() {
        const query = entryText(this._searchEntry).toLowerCase().trim();

        this._accountRows.forEach(row => {
            const account = row.account;
            const match = !query
                || (account.issuer || '').toLowerCase().includes(query)
                || (account.label || '').toLowerCase().includes(query);

            if (match) {
                row.show();
            } else {
                row.hide();
            }
        });
    }

    _onAddAccount(tab = null) {
        const dialog = new AddAccountDialog();
        this._connectDialogRefresh(dialog);
        dialog.open();

        if (tab === 'manual') {
            dialog.focusPrimaryField();
        } else if (tab === 'qr') {
            dialog.scanQrCode('screen');
        }
    }

    _onEditAccount(id) {
        const account = AccountManager.getAccount(id);
        if (!account) {
            return;
        }

        const dialog = new AddAccountDialog();
        dialog.setAccount(account);
        this._connectDialogRefresh(dialog);
        dialog.open();
    }

    _connectDialogRefresh(dialog) {
        const refreshIfOpen = () => {
            if (this._refreshTimerId) {
                this.refreshAccounts();
            }
        };
        dialog.connect('account-added', refreshIfOpen);
        dialog.connect('account-updated', refreshIfOpen);
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
                if (this._refreshTimerId) {
                    this.refreshAccounts();
                }
            } catch (error) {
                console.error(`[TOTP] Failed to delete account: ${error.message}`);
            }
        });
        confirmDialog.open();
    }

    _onOpenSettings() {
        this._onOpenPreferences?.();
    }

    destroy() {
        this._isDestroyed = true;
        this.stopRefreshTimer();
        this._clearAccountRows();
        super.destroy();
    }
});
