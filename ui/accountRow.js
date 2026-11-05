// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as AccountManager from '../lib/accountManager.js';
import * as LogoFetcher from '../lib/logoFetcher.js';
import { generateTOTP, getTimeRemaining } from '../lib/totp.js';
import { ProgressArc } from './progressArc.js';

const COPY_FEEDBACK_DURATION_MS = 1200;
const DEFAULT_CODE_FONT = 'Monospace';
const DEFAULT_CODE_SIZE = 28;
const DEFAULT_PERIOD = 30;
const EXPIRING_THRESHOLD_S = 7;

function cssQuotedFontFamily(fontFamily) {
    return `"${String(fontFamily || DEFAULT_CODE_FONT).replace(/["\\]/g, '')}"`;
}

function formatCode(code) {
    const midpoint = Math.ceil(code.length / 2);
    return `${code.substring(0, midpoint)} ${code.substring(midpoint)}`;
}

export const AccountRow = GObject.registerClass(
{
    Signals: {
        'account-edit': { param_types: [GObject.TYPE_STRING] },
        'account-delete': { param_types: [GObject.TYPE_STRING] },
        'account-move-up': { param_types: [GObject.TYPE_STRING] },
        'account-move-down': { param_types: [GObject.TYPE_STRING] },
    },
},
class AccountRow extends St.BoxLayout {
    _init(account, options = {}) {
        super._init({
            style_class: 'totp-account-row',
            reactive: true,
            track_hover: true,
            can_focus: true,
            x_expand: true,
        });

        this._account = account;
        this._currentCode = '';
        this._secret = null;
        this._secretLoaded = false;
        this._secretLoadPromise = null;
        this._codeFont = options.codeFont || DEFAULT_CODE_FONT;
        this._codeFontSize = options.codeFontSize || DEFAULT_CODE_SIZE;
        this._copyFeedbackTimeoutId = 0;
        this._contextMenu = null;
        this._isDestroyed = false;

        this._buildUI();
        this._setupContextMenu();
        this._refreshCode();

        this.connect('destroy', () => this._onDestroy());
    }

    _buildUI() {
        this._avatar = new St.Bin({
            style_class: 'totp-account-avatar',
            style: `background-color: ${this._account.color || '#1a73e8'};`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (!this._setLogoAvatar(this._account.logoPath || this._account.logoUrl)) {
            this._setLetterAvatar();
            if (this._account.siteUrl) {
                this._fetchAndSetLogo();
            }
        }

        this.add_child(this._avatar);
        this.add_child(this._buildInfoBox());
        this.add_child(this._buildActionsBox());
    }

    _buildInfoBox() {
        const infoBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'totp-account-info',
        });

        infoBox.add_child(new St.Label({
            text: this._account.issuer || 'Unknown',
            style_class: 'totp-account-issuer',
        }));

        infoBox.add_child(new St.Label({
            text: this._account.label || '',
            style_class: 'totp-account-label',
        }));

        this._codeLabel = new St.Label({
            text: '••• •••',
            style_class: 'totp-account-code',
            style: `font-family: ${cssQuotedFontFamily(this._codeFont)}; font-size: ${this._codeFontSize}px;`,
        });
        infoBox.add_child(this._codeLabel);

        return infoBox;
    }

    _buildActionsBox() {
        const actionsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'totp-account-actions',
        });

        this._progressArc = new ProgressArc(this._getPeriod());
        this._progressArc.x_align = Clutter.ActorAlign.CENTER;
        actionsBox.add_child(this._progressArc);

        this._copyIcon = new St.Icon({
            icon_name: 'edit-copy-symbolic',
            icon_size: 16,
        });
        this._copyButton = new St.Button({
            style_class: 'totp-copy-button',
            child: this._copyIcon,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._copyButton.connect('clicked', () => this._copyCodeToClipboard());
        actionsBox.add_child(this._copyButton);

        return actionsBox;
    }

    _setupContextMenu() {
        this._contextMenuManager = new PopupMenu.PopupMenuManager(this);
        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY) {
                return Clutter.EVENT_PROPAGATE;
            }

            this._showContextMenu();
            return Clutter.EVENT_STOP;
        });
    }

    _showContextMenu() {
        this._destroyContextMenu();

        this._contextMenu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
        this._contextMenu.actor.add_style_class_name('totp-account-menu');
        this._contextMenu.actor.hide();
        this._contextMenu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen) {
                this._destroyContextMenu();
            }
        });

        this._addMenuAction('Edit Account', 'account-edit');
        this._addMenuAction('Move Up', 'account-move-up');
        this._addMenuAction('Move Down', 'account-move-down');
        this._contextMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addMenuAction('Delete Account', 'account-delete');

        Main.uiGroup.add_child(this._contextMenu.actor);
        this._contextMenuManager.addMenu(this._contextMenu);
        this._contextMenu.open();
    }

    _addMenuAction(label, signalName) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => this.emit(signalName, this._account.id));
        this._contextMenu.addMenuItem(item);
    }

    _refreshCode() {
        if (this._isDestroyed) {
            return;
        }

        const period = this._getPeriod();
        const remaining = getTimeRemaining(period);

        this._codeLabel.remove_style_class_name('totp-code-error');
        this._codeLabel.remove_style_class_name('totp-code-expiring');

        try {
            if (!this._secretLoaded) {
                this._codeLabel.text = 'Loading';
                this._progressArc.setTimeRemaining(remaining);
                if (!this._secretLoadPromise) {
                    this._secretLoadPromise = AccountManager.getSecret(this._account.id)
                        .then(secret => {
                            if (this._isDestroyed) {
                                return;
                            }
                            this._secret = secret;
                            this._secretLoaded = true;
                            this._secretLoadPromise = null;
                            this._refreshCode();
                        })
                        .catch(error => {
                            if (this._isDestroyed) {
                                return;
                            }
                            this._secretLoaded = true;
                            this._secretLoadPromise = null;
                            this._currentCode = '';
                            this._codeLabel.text = 'Error';
                            this._codeLabel.add_style_class_name('totp-code-error');
                            this._progressArc.setTimeRemaining(remaining);
                            console.error(`[TOTP] Failed to load secret for ${this._account.issuer}: ${error.message}`);
                        });
                }
                return;
            }

            const secret = this._secret;
            if (!secret) {
                this._currentCode = '';
                this._codeLabel.text = 'No Key';
                this._codeLabel.add_style_class_name('totp-code-error');
                this._progressArc.setTimeRemaining(remaining);
                return;
            }

            const code = generateTOTP({
                secret,
                algorithm: this._account.algorithm || 'SHA1',
                digits: this._account.digits || 6,
                period,
            });

            this._currentCode = code;
            this._codeLabel.text = formatCode(code);
            this._updateExpiryState(remaining);
            this._progressArc.setTimeRemaining(remaining);
        } catch (error) {
            this._currentCode = '';
            this._codeLabel.text = 'Error';
            this._codeLabel.add_style_class_name('totp-code-error');
            this._progressArc.setTimeRemaining(remaining);
            console.error(`[TOTP] Code generation error for ${this._account.issuer}: ${error.message}`);
        }
    }

    _updateExpiryState(remaining) {
        if (remaining <= EXPIRING_THRESHOLD_S) {
            this._codeLabel.add_style_class_name('totp-code-expiring');
        } else {
            this._codeLabel.remove_style_class_name('totp-code-expiring');
        }
    }

    _copyCodeToClipboard() {
        if (!this._currentCode) {
            return;
        }

        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._currentCode);
        AccountManager.touchAccount(this._account.id);
        this._showCopyFeedback();
    }

    _showCopyFeedback() {
        if (!this._copyButton || !this._copyIcon) {
            return;
        }

        this._copyIcon.icon_name = 'emblem-ok-symbolic';
        this._copyButton.add_style_class_name('totp-copy-success');

        if (this._copyFeedbackTimeoutId) {
            GLib.source_remove(this._copyFeedbackTimeoutId);
        }

        this._copyFeedbackTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            COPY_FEEDBACK_DURATION_MS,
            () => {
                if (!this._isDestroyed && this._copyButton && this._copyIcon) {
                    this._copyIcon.icon_name = 'edit-copy-symbolic';
                    this._copyButton.remove_style_class_name('totp-copy-success');
                }

                this._copyFeedbackTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _getPeriod() {
        return this._account.period || DEFAULT_PERIOD;
    }

    refresh() {
        this._refreshCode();
    }

    get account() {
        return this._account;
    }

    _setLogoAvatar(logoRef) {
        if (!logoRef || String(logoRef).startsWith('http')) {
            return false;
        }

        const file = Gio.File.new_for_path(logoRef);
        if (!file.query_exists(null)) {
            return false;
        }

        this._avatar.child = new St.Icon({
            gicon: new Gio.FileIcon({ file }),
            icon_size: 24,
            style_class: 'totp-account-avatar-logo',
        });

        return true;
    }

    _setLetterAvatar() {
        const avatarLetter = (this._account.issuer || this._account.label || '?')[0].toUpperCase();
        this._avatar.child = new St.Label({
            text: avatarLetter,
            style: 'font-size: 14px; font-weight: bold; color: white;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    async _fetchAndSetLogo() {
        try {
            const logo = await LogoFetcher.fetchLogo(this._account.siteUrl);
            if (!logo?.url || this._isDestroyed) {
                return;
            }

            this._account.logoUrl = logo.url;
            this._account.logoPath = logo.path ?? null;

            if (logo.path) {
                this._setLogoAvatar(logo.path);
            }

            AccountManager.updateAccount(this._account.id, {
                logoUrl: logo.url,
                logoPath: logo.path ?? null,
            });
        } catch (error) {
            console.error(`[TOTP] Failed to fetch logo for ${this._account.issuer}: ${error.message}`);
        }
    }

    _destroyContextMenu() {
        if (this._contextMenu) {
            this._contextMenu.destroy();
            this._contextMenu = null;
        }
    }

    _onDestroy() {
        this._isDestroyed = true;
        this._secret = null;

        if (this._copyFeedbackTimeoutId) {
            GLib.source_remove(this._copyFeedbackTimeoutId);
            this._copyFeedbackTimeoutId = 0;
        }

        this._destroyContextMenu();
    }
},
);
