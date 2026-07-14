// SPDX-License-Identifier: GPL-3.0-or-later
// Panel Button — Top bar indicator button

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { MainPopup } from './mainPopup.js';

export const PanelButton = GObject.registerClass(
class PanelButton extends PanelMenu.Button {
    _init(settings, path) {
        super._init(0.0, 'TOTP Authenticator');

        this._settings = settings;

        // Panel icon
        const iconPath = GLib.build_filenamev([path, 'icons', 'shield-symbolic.svg']);
        const iconFile = Gio.File.new_for_path(iconPath);
        const icon = new Gio.FileIcon({ file: iconFile });
        this._icon = new St.Icon({
            gicon: icon,
            style_class: 'system-status-icon totp-panel-icon',
        });
        this.add_child(this._icon);

        // Build popup content
        this._mainPopup = new MainPopup(settings, path);

        // Add popup to menu
        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(this._mainPopup);
        this.menu.addMenuItem(section);

        // Set popup width
        const popupWidth = settings ? settings.get_int('popup-width') : 360;
        this._mainPopup.style = `width: ${popupWidth}px;`;

        // Connect menu signals
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._mainPopup.refreshAccounts();
                this._mainPopup.startRefreshTimer();
            } else {
                this._mainPopup.stopRefreshTimer();
            }
        });
    }

    /**
     * Refresh the accounts display.
     */
    refresh() {
        this._mainPopup.refreshAccounts();
    }

    destroy() {
        if (this._mainPopup) {
            this._mainPopup.destroy();
            this._mainPopup = null;
        }
        super.destroy();
    }
});
