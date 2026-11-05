// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as AccountManager from './lib/accountManager.js';
import { PanelButton } from './ui/panelButton.js';

export default class TOTPAuthenticatorExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._panelButton = null;
        this._settings = null;
        this._screenSaverProxy = null;
        this._screenSaverSignalId = 0;
        this._settingsSignalIds = [];
    }

    enable() {
        this._settings = this.getSettings();
        this._panelButton = new PanelButton(this._settings, this.path, {
            onOpenPreferences: () => this.openPreferences(),
        });

        Main.panel.addToStatusArea(this.metadata.uuid, this._panelButton);

        this._connectSettingsSignals();
        this._loadAccounts();

        if (this._settings.get_boolean('lock-on-screen-lock')) {
            this._setupScreenLockListener();
        }
    }

    disable() {
        this._disconnectSettingsSignals();

        if (this._panelButton) {
            this._panelButton.destroy();
            this._panelButton = null;
        }

        this._teardownScreenLockListener();
        AccountManager.cleanup();
        this._settings = null;
    }

    _loadAccounts() {
        AccountManager.loadAccounts()
            .then(() => this._panelButton?.refresh())
            .catch(error => {
                console.error(`[TOTP] Failed to load accounts: ${error.message}`);
            });
    }

    _connectSettingsSignals() {
        if (!this._settings) {
            return;
        }

        this._settingsSignalIds.push(
            this._settings.connect('changed::lock-on-screen-lock', () => {
                if (this._settings.get_boolean('lock-on-screen-lock')) {
                    this._setupScreenLockListener();
                } else {
                    this._teardownScreenLockListener();
                }
            }),
        );

        this._settingsSignalIds.push(
            this._settings.connect('changed::popup-width', () => {
                this._panelButton?.setPopupWidth(this._settings.get_int('popup-width'));
            }),
        );
    }

    _disconnectSettingsSignals() {
        if (!this._settings) {
            return;
        }

        for (const signalId of this._settingsSignalIds) {
            this._settings.disconnect(signalId);
        }

        this._settingsSignalIds = [];
    }

    _setupScreenLockListener() {
        if (this._screenSaverProxy) {
            return;
        }

        try {
            this._screenSaverProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.gnome.ScreenSaver',
                '/org/gnome/ScreenSaver',
                'org.gnome.ScreenSaver',
                null,
            );

            this._screenSaverSignalId = this._screenSaverProxy.connect(
                'g-signal',
                (_proxy, _senderName, signalName, parameters) => {
                    if (signalName !== 'ActiveChanged') {
                        return;
                    }

                    const [isActive] = parameters.deep_unpack();
                    if (isActive) {
                        this._panelButton?.closeMenu();
                    }
                },
            );
        } catch (error) {
            console.error(`[TOTP] Failed to set up screen lock listener: ${error.message}`);
        }
    }

    _teardownScreenLockListener() {
        if (this._screenSaverProxy && this._screenSaverSignalId) {
            this._screenSaverProxy.disconnect(this._screenSaverSignalId);
            this._screenSaverSignalId = 0;
        }

        this._screenSaverProxy = null;
    }
}
