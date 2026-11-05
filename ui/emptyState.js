// SPDX-License-Identifier: GPL-3.0-or-later
// Empty State — Shown when no accounts are configured

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const EmptyState = GObject.registerClass({
    Signals: {
        'scan-qr': {},
        'enter-manually': {},
    },
}, class EmptyState extends St.BoxLayout {
    _init(path) {
        super._init({
            style_class: 'totp-empty-state',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // TOTP icon from extension icons folder
        const iconPath = GLib.build_filenamev([path, 'icons', 'totp-symbolic.svg']);
        const iconFile = Gio.File.new_for_path(iconPath);
        const icon = new Gio.FileIcon({ file: iconFile });
        const emptyIcon = new St.Icon({
            gicon: icon,
            icon_size: 64,
            style_class: 'totp-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(emptyIcon);

        // Title
        const title = new St.Label({
            text: 'No accounts yet',
            style_class: 'totp-empty-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(title);

        // Description
        const desc = new St.Label({
            text: 'Add your first account by scanning\na QR code or entering a key manually.',
            style_class: 'totp-empty-description',
            x_align: Clutter.ActorAlign.CENTER,
        });
        desc.clutter_text.set_line_wrap(true);
        desc.clutter_text.set_line_alignment(0); // Pango.Alignment.CENTER = 0? Actually let's use x_align
        this.add_child(desc);

        // Action buttons
        const buttonBox = new St.BoxLayout({
            style_class: 'totp-empty-buttons',
            x_align: Clutter.ActorAlign.CENTER,
        });

        const scanButton = new St.Button({
            label: 'Scan QR Code',
            style_class: 'totp-button totp-button-primary',
            can_focus: true,
            reactive: true,
        });
        scanButton.connect('clicked', () => this.emit('scan-qr'));
        buttonBox.add_child(scanButton);

        const manualButton = new St.Button({
            label: 'Enter Manually',
            style_class: 'totp-button totp-button-secondary',
            can_focus: true,
            reactive: true,
        });
        manualButton.connect('clicked', () => this.emit('enter-manually'));
        buttonBox.add_child(manualButton);

        this.add_child(buttonBox);
    }
});
