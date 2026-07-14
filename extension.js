// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME TOTP Authenticator — Main Extension Entry Point

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PanelButton } from './ui/panelButton.js';
import * as AccountManager from './lib/accountManager.js';
import * as QRScanner from './lib/qrScanner.js';

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

        // Create panel button
        this._panelButton = new PanelButton(this._settings, this.path);
        Main.panel.addToStatusArea(this.metadata.uuid, this._panelButton);

        AccountManager.loadAccounts().then(() => {
            if (this._panelButton) {
                this._panelButton.refresh();
            }
        }).catch(e => {
            console.error(`[TOTP] Failed to load accounts: ${e.message}`);
        });

        // Check for missing dependencies and notify user
        this._checkDependencies();

        // Set up screen lock integration
        if (this._settings.get_boolean('lock-on-screen-lock')) {
            this._setupScreenLockListener();
        }

        // Listen for setting changes
        this._settingsSignalIds.push(this._settings.connect('changed::lock-on-screen-lock', () => {
            if (this._settings.get_boolean('lock-on-screen-lock')) {
                this._setupScreenLockListener();
            } else {
                this._teardownScreenLockListener();
            }
        }));

        this._settingsSignalIds.push(this._settings.connect('changed::popup-width', () => {
            if (this._panelButton && this._panelButton._mainPopup) {
                const width = this._settings.get_int('popup-width');
                this._panelButton._mainPopup.style = `width: ${width}px;`;
            }
        }));
    }

    disable() {
        if (this._settings) {
            for (const signalId of this._settingsSignalIds) {
                this._settings.disconnect(signalId);
            }
            this._settingsSignalIds = [];
        }

        // Destroy panel button
        if (this._panelButton) {
            this._panelButton.destroy();
            this._panelButton = null;
        }

        // Clean up screen lock listener
        this._teardownScreenLockListener();

        // Clean up account manager state
        AccountManager.cleanup();

        this._settings = null;
    }

    /**
     * Check for missing system dependencies and show notifications.
     * @private
     */
    _checkDependencies() {
        const deps = QRScanner.checkDependencies();

        if (!deps.zbarimg) {
            const instructions = QRScanner.getInstallInstructions();
            Main.notify(
                'TOTP Authenticator',
                `QR scanning requires zbar-tools.\n${instructions}`
            );
        }
    }

    /**
     * Set up D-Bus listener for screen lock events.
     * When screen is locked, close the popup for security.
     * @private
     */
    _setupScreenLockListener() {
        if (this._screenSaverProxy) return;

        try {
            this._screenSaverProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.gnome.ScreenSaver',
                '/org/gnome/ScreenSaver',
                'org.gnome.ScreenSaver',
                null
            );

            this._screenSaverSignalId = this._screenSaverProxy.connect(
                'g-signal',
                (proxy, senderName, signalName, parameters) => {
                    if (signalName === 'ActiveChanged') {
                        const isActive = parameters.deep_unpack()[0];
                        if (isActive && this._panelButton) {
                            // Screen locked — close popup
                            this._panelButton.menu.close();
                        }
                    }
                }
            );
        } catch (e) {
            console.error(`[TOTP] Failed to set up screen lock listener: ${e.message}`);
        }
    }

    /**
     * Clean up screen lock listener.
     * @private
     */
    _teardownScreenLockListener() {
        if (this._screenSaverProxy && this._screenSaverSignalId) {
            this._screenSaverProxy.disconnect(this._screenSaverSignalId);
            this._screenSaverSignalId = 0;
        }
        this._screenSaverProxy = null;
    }
}
