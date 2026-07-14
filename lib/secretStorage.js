// SPDX-License-Identifier: GPL-3.0-or-later
// Secret Storage — GNOME Keyring integration via libsecret
// Stores TOTP secrets exclusively in the system keyring.

import Secret from 'gi://Secret';
import GLib from 'gi://GLib';

let _schema = null;
let _legacySchema = null;

function getSchema() {
    if (!_schema) {
        _schema = new Secret.Schema(
            'org.gnome.shell.extensions.gnome-totp-authenticator',
            Secret.SchemaFlags.NONE,
            {
                'account-id': Secret.SchemaAttributeType.STRING,
            }
        );
    }
    return _schema;
}

function getLegacySchema() {
    if (!_legacySchema) {
        _legacySchema = new Secret.Schema(
            'org.gnome.shell.extensions.totp-auth',
            Secret.SchemaFlags.NONE,
            {
                'account-id': Secret.SchemaAttributeType.STRING,
            }
        );
    }
    return _legacySchema;
}

/**
 * Store a TOTP secret in GNOME Keyring.
 *
 * @param {string} accountId - Unique account ID (UUID)
 * @param {string} secret - Base32-encoded TOTP secret
 * @returns {Promise<boolean>} True if stored successfully
 */
export function storeSecret(accountId, secret) {
    return new Promise((resolve, reject) => {
        Secret.password_store(
            getSchema(),
            { 'account-id': accountId },
            Secret.COLLECTION_DEFAULT,
            `TOTP Secret: ${accountId}`,
            secret,
            null,
            (source, result) => {
                try {
                    Secret.password_store_finish(result);
                    resolve(true);
                } catch (e) {
                    reject(new Error(`Failed to store secret: ${e.message}`));
                }
            }
        );
    });
}

/**
 * Look up a TOTP secret from GNOME Keyring.
 *
 * @param {string} accountId - Unique account ID (UUID)
 * @returns {Promise<string|null>} The Base32 secret, or null if not found
 */
export function lookupSecret(accountId) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(
            getSchema(),
            { 'account-id': accountId },
            null,
            (source, result) => {
                try {
                    const password = Secret.password_lookup_finish(result);
                    if (password) {
                        resolve(password);
                        return;
                    }

                    Secret.password_lookup(
                        getLegacySchema(),
                        { 'account-id': accountId },
                        null,
                        (legacySource, legacyResult) => {
                            try {
                                const legacyPassword = Secret.password_lookup_finish(legacyResult);
                                resolve(legacyPassword || null);
                            } catch (e) {
                                reject(new Error(`Failed to lookup legacy secret: ${e.message}`));
                            }
                        }
                    );
                } catch (e) {
                    reject(new Error(`Failed to lookup secret: ${e.message}`));
                }
            }
        );
    });
}

/**
 * Delete a TOTP secret from GNOME Keyring.
 *
 * @param {string} accountId - Unique account ID (UUID)
 * @returns {Promise<boolean>} True if deleted (or not found)
 */
export function deleteSecret(accountId) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(
            getSchema(),
            { 'account-id': accountId },
            null,
            (source, result) => {
                try {
                    Secret.password_clear_finish(result);
                    Secret.password_clear(
                        getLegacySchema(),
                        { 'account-id': accountId },
                        null,
                        (legacySource, legacyResult) => {
                            try {
                                Secret.password_clear_finish(legacyResult);
                                resolve(true);
                            } catch (e) {
                                reject(new Error(`Failed to delete legacy secret: ${e.message}`));
                            }
                        }
                    );
                } catch (e) {
                    reject(new Error(`Failed to delete secret: ${e.message}`));
                }
            }
        );
    });
}

/**
 * Store a secret synchronously (for use during initialization only).
 * WARNING: May block if keyring is locked. Use async version when possible.
 *
 * @param {string} accountId - Unique account ID
 * @param {string} secret - Base32-encoded TOTP secret
 * @returns {boolean} True if stored
 */
export function storeSecretSync(accountId, secret) {
    try {
        return Secret.password_store_sync(
            getSchema(),
            { 'account-id': accountId },
            Secret.COLLECTION_DEFAULT,
            `TOTP Secret: ${accountId}`,
            secret,
            null
        );
    } catch (e) {
        console.error(`[TOTP] Failed to store secret sync: ${e.message}`);
        return false;
    }
}

/**
 * Look up a secret synchronously.
 * WARNING: May block if keyring is locked. Use async version when possible.
 *
 * @param {string} accountId - Unique account ID
 * @returns {string|null} The Base32 secret, or null
 */
export function lookupSecretSync(accountId) {
    try {
        const password = Secret.password_lookup_sync(
            getSchema(),
            { 'account-id': accountId },
            null
        );

        if (password)
            return password;

        return Secret.password_lookup_sync(
            getLegacySchema(),
            { 'account-id': accountId },
            null
        ) || null;
    } catch (e) {
        console.error(`[TOTP] Failed to lookup secret sync: ${e.message}`);
        return null;
    }
}
