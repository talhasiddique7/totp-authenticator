// SPDX-License-Identifier: GPL-3.0-or-later
// Account Manager — CRUD operations for TOTP accounts
// Depends on: secretStorage.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as SecretStorage from './secretStorage.js';

// Data directory for non-sensitive account metadata
const DATA_DIR = GLib.build_filenamev([
    GLib.get_home_dir(), '.local', 'share', 'gnome-totp-auth',
]);

const ACCOUNTS_FILE = GLib.build_filenamev([DATA_DIR, 'accounts.json']);

// Predefined accent colors for account avatars
export const ACCENT_COLORS = [
    '#1a73e8', // Blue
    '#e8710a', // Orange
    '#0b8043', // Green
    '#c5221f', // Red
    '#7b1fa2', // Purple
    '#00796b', // Teal
    '#c2185b', // Pink
    '#6d4c41', // Brown
];

/**
 * In-memory account store.
 * @type {Array<object>}
 */
let _accounts = [];
let _loaded = false;
let _loadPromise = null;

/**
 * Ensure the data directory exists.
 */
function ensureDataDir() {
    const dir = Gio.File.new_for_path(DATA_DIR);
    if (!dir.query_exists(null)) {
        dir.make_directory_with_parents(null);
    }
}

/**
 * Load accounts from disk (metadata only — secrets are in Keyring).
 *
 * @returns {Array<object>} Array of account metadata objects
 */
export function loadAccounts() {
    if (_loaded) return Promise.resolve(_accounts);
    if (_loadPromise) return _loadPromise;

    _loadPromise = new Promise(resolve => {
        try {
            ensureDataDir();

            const file = Gio.File.new_for_path(ACCOUNTS_FILE);
            if (!file.query_exists(null)) {
                _accounts = [];
                _loaded = true;
                _loadPromise = null;
                resolve(_accounts);
                return;
            }

            file.load_contents_async(null, (source, result) => {
                try {
                    const [success, contents] = source.load_contents_finish(result);
                    if (success) {
                        const decoder = new TextDecoder('utf-8');
                        const json = decoder.decode(contents);
                        _accounts = JSON.parse(json);
                    }
                } catch (e) {
                    console.error(`[TOTP] Failed to load accounts: ${e.message}`);
                    _accounts = [];
                }

                _loaded = true;
                _loadPromise = null;
                resolve(_accounts);
            });
        } catch (e) {
            console.error(`[TOTP] Failed to load accounts: ${e.message}`);
            _accounts = [];
            _loaded = true;
            _loadPromise = null;
            resolve(_accounts);
        }
    });

    return _loadPromise;
}

/**
 * Save accounts metadata to disk.
 * NOTE: Only non-sensitive metadata is written. Secrets stay in Keyring.
 */
export function saveAccounts() {
    ensureDataDir();

    // Strip any secret fields that might accidentally exist
    const safeAccounts = _accounts.map(acct => {
        const { secret, ...safe } = acct;
        return safe;
    });

    const json = JSON.stringify(safeAccounts, null, 2);
    const file = Gio.File.new_for_path(ACCOUNTS_FILE);

    try {
        file.replace_contents(
            new TextEncoder().encode(json),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    } catch (e) {
        console.error(`[TOTP] Failed to save accounts: ${e.message}`);
    }
}

/**
 * Get all accounts sorted by current sort preference.
 *
 * @param {string} [sortOrder='manual'] - Sort method: 'manual', 'alphabetical', 'last-used'
 * @returns {Array<object>} Sorted accounts
 */
export function getAccounts(sortOrder = 'manual') {
    loadAccounts();

    const sorted = [..._accounts];
    switch (sortOrder) {
        case 'alphabetical':
            sorted.sort((a, b) => {
                const nameA = `${a.issuer} ${a.label}`.toLowerCase();
                const nameB = `${b.issuer} ${b.label}`.toLowerCase();
                return nameA.localeCompare(nameB);
            });
            break;
        case 'last-used':
            sorted.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
            break;
        case 'manual':
        default:
            sorted.sort((a, b) => (a.order || 0) - (b.order || 0));
            break;
    }

    return sorted;
}

/**
 * Get an account by ID.
 *
 * @param {string} id - Account UUID
 * @returns {object|null} Account object or null
 */
export function getAccount(id) {
    loadAccounts();
    return _accounts.find(a => a.id === id) || null;
}

/**
 * Add a new TOTP account.
 *
 * @param {object} params - Account parameters
 * @param {string} params.label - Display name / email
 * @param {string} params.issuer - Service name
 * @param {string} params.secret - Base32-encoded secret (stored in Keyring)
 * @param {string} [params.algorithm='SHA1'] - Hash algorithm
 * @param {number} [params.digits=6] - Number of digits
 * @param {number} [params.period=30] - Time period
 * @param {string|null} [params.siteUrl] - Service website URL
 * @param {string|null} [params.logoUrl] - Remote favicon URL
 * @param {string|null} [params.logoPath] - Cached local favicon path
 * @param {string} [params.color] - Accent color
 * @returns {Promise<object>} The created account (without secret)
 */
export async function addAccount({
    label,
    issuer,
    secret,
    siteUrl = null,
    logoUrl = null,
    logoPath = null,
    algorithm = 'SHA1',
    digits = 6,
    period = 30,
    color = null,
}) {
    await loadAccounts();

    const id = GLib.uuid_string_random();
    const now = Date.now();

    // Pick a color if not specified
    if (!color) {
        color = ACCENT_COLORS[_accounts.length % ACCENT_COLORS.length];
    }

    const account = {
        id,
        label,
        issuer,
        siteUrl,
        logoUrl,
        logoPath,
        algorithm: algorithm.toUpperCase(),
        digits,
        period,
        icon: null,
        color,
        order: _accounts.length,
        addedAt: now,
        lastUsed: now,
    };

    // Store secret in Keyring
    await SecretStorage.storeSecret(id, secret);

    // Add to in-memory list and persist metadata
    _accounts.push(account);
    saveAccounts();

    return account;
}

/**
 * Update an existing account's metadata.
 *
 * @param {string} id - Account UUID
 * @param {object} updates - Fields to update
 * @returns {object|null} Updated account or null if not found
 */
export function updateAccount(id, updates) {
    loadAccounts();

    const index = _accounts.findIndex(a => a.id === id);
    if (index === -1) return null;

    // Never allow secret to be stored in metadata
    const { secret, ...safeUpdates } = updates;
    if (safeUpdates.algorithm) {
        safeUpdates.algorithm = safeUpdates.algorithm.toUpperCase();
    }
    Object.assign(_accounts[index], safeUpdates);
    saveAccounts();

    return _accounts[index];
}

/**
 * Update an existing account, optionally rotating its secret in Keyring.
 *
 * @param {string} id - Account UUID
 * @param {object} updates - Metadata fields to update
 * @param {string|null} [newSecret=null] - New Base32 secret (optional)
 * @returns {Promise<object|null>} Updated account or null if not found
 */
export async function updateAccountWithSecret(id, updates = {}, newSecret = null) {
    await loadAccounts();

    const index = _accounts.findIndex(a => a.id === id);
    if (index === -1) return null;

    const normalizedSecret = (newSecret || '').trim();
    if (normalizedSecret) {
        await SecretStorage.storeSecret(id, normalizedSecret);
    }

    const { secret, ...safeUpdates } = updates;
    if (safeUpdates.algorithm) {
        safeUpdates.algorithm = safeUpdates.algorithm.toUpperCase();
    }

    Object.assign(_accounts[index], safeUpdates);
    saveAccounts();
    return _accounts[index];
}

/**
 * Delete an account and its secret.
 *
 * @param {string} id - Account UUID
 * @returns {Promise<boolean>} True if deleted
 */
export async function deleteAccount(id) {
    await loadAccounts();

    const index = _accounts.findIndex(a => a.id === id);
    if (index === -1) return false;

    // Delete from Keyring
    await SecretStorage.deleteSecret(id);

    // Remove from list
    _accounts.splice(index, 1);

    // Re-index order
    _accounts.forEach((a, i) => a.order = i);

    saveAccounts();
    return true;
}

function _moveAccount(id, direction) {
    loadAccounts();

    const sorted = [..._accounts].sort((a, b) => (a.order || 0) - (b.order || 0));
    const index = sorted.findIndex(a => a.id === id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= sorted.length) return false;

    [sorted[index], sorted[targetIndex]] = [sorted[targetIndex], sorted[index]];
    sorted.forEach((a, i) => a.order = i);
    _accounts = sorted;
    saveAccounts();
    return true;
}

/**
 * Move an account up in the sort order.
 *
 * @param {string} id - Account UUID
 * @returns {boolean} True if moved
 */
export function moveAccountUp(id) {
    return _moveAccount(id, -1);
}

/**
 * Move an account down in the sort order.
 *
 * @param {string} id - Account UUID
 * @returns {boolean} True if moved
 */
export function moveAccountDown(id) {
    return _moveAccount(id, 1);
}

/**
 * Update the lastUsed timestamp for an account.
 *
 * @param {string} id - Account UUID
 */
export function touchAccount(id) {
    const account = getAccount(id);
    if (account) {
        account.lastUsed = Date.now();
        saveAccounts();
    }
}

/**
 * Get the secret for an account from Keyring.
 * The caller is responsible for zeroing the returned value after use.
 *
 * @param {string} id - Account UUID
 * @returns {Promise<string|null>} Base32 secret or null
 */
export async function getSecret(id) {
    return await SecretStorage.lookupSecret(id);
}

/**
 * Get the secret synchronously. Use sparingly — may block.
 *
 * @param {string} id - Account UUID
 * @returns {string|null} Base32 secret or null
 */
export function getSecretSync(id) {
    return SecretStorage.lookupSecretSync(id);
}

/**
 * Get total account count.
 *
 * @returns {number} Number of accounts
 */
export function getAccountCount() {
    loadAccounts();
    return _accounts.length;
}

/**
 * Force reload accounts from disk (used after external changes).
 */
export function reloadAccounts() {
    _loaded = false;
    loadAccounts();
}

/**
 * Clear all in-memory state (called on extension disable).
 */
export function cleanup() {
    _accounts = [];
    _loaded = false;
}
