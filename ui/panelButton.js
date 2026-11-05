// SPDX-License-Identifier: GPL-3.0-or-later

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { MainPopup } from './mainPopup.js';

export const PanelButton = GObject.registerClass(
class PanelButton extends PanelMenu.Button {
    _init(settings, path, options = {}) {
        super._init(0.0, 'TOTP Authenticator');

        this._mainPopup = null;

        const iconPath = GLib.build_filenamev([path, 'icons', 'shield-symbolic.svg']);
        const iconFile = Gio.File.new_for_path(iconPath);

        this.add_child(new St.Icon({
            gicon: new Gio.FileIcon({ file: iconFile }),
            style_class: 'system-status-icon totp-panel-icon',
        }));

        this._mainPopup = new MainPopup(settings, path, options);

        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(this._mainPopup);
        this.menu.addMenuItem(section);

        this.setPopupWidth(settings ? settings.get_int('popup-width') : 360);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._mainPopup.refreshAccounts();
                this._mainPopup.startRefreshTimer();
            } else {
                this._mainPopup.stopRefreshTimer();
                this._mainPopup.clearSensitiveState();
            }
        });
    }

    setPopupWidth(width) {
        if (this._mainPopup) {
            this._mainPopup.style = `width: ${width}px;`;
        }
    }

    refresh() {
        if (this.menu.isOpen) {
            this._mainPopup?.refreshAccounts();
        }
    }

    closeMenu() {
        this.menu.close();
    }

    destroy() {
        this._mainPopup?.destroy();
        this._mainPopup = null;
        super.destroy();
    }
});
