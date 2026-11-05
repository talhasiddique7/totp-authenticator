// SPDX-License-Identifier: GPL-3.0-or-later
// Account Manager — CRUD operations for TOTP accounts
// Depends on: secretStorage.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as SecretStorage from './secretStorage.js';
import { isValid as isValidBase32, normalize as normalizeBase32 } from './base32.js';

// Data directory for non-sensitive account metadata
const DATA_DIR = GLib.build_filenamev([
    GLib.get_home_dir(), '.local', 'share', 'gnome-totp-auth',
]);

const ACCOUNTS_FILE = GLib.build_filenamev([DATA_DIR, 'accounts.json']);
const MAX_ACCOUNTS_FILE_BYTES = 1024 * 1024;
const VALID_ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512']);
const ACCOUNT_UPDATE_FIELDS = new Set([
    'label',
    'issuer',
    'siteUrl',
    'logoUrl',
    'logoPath',
    'algorithm',
    'digits',
    'period',
    'color',
]);

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
let _loadGeneration = 0;

function startBackgroundLoad() {
    if (_loaded || _loadPromise) {
        return;
    }

    loadAccounts().catch(error => {
        console.error(`[TOTP] Background account load failed: ${error.message}`);
    });
}

function normalizeUpdates(updates) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        throw new Error('Account updates must be an object');
    }

    const result = {};
    for (const [field, value] of Object.entries(updates)) {
        if (field === 'secret') {
            continue;
        }
        if (!ACCOUNT_UPDATE_FIELDS.has(field)) {
            throw new Error(`Account field cannot be updated: ${field}`);
        }
        result[field] = value;
    }

    if (result.algorithm !== undefined) {
        if (typeof result.algorithm !== 'string') {
            throw new Error('Account algorithm must be a string');
        }
        result.algorithm = result.algorithm.toUpperCase();
        if (!VALID_ALGORITHMS.has(result.algorithm)) {
            throw new Error(`Unsupported account algorithm: ${result.algorithm}`);
        }
    }
    if (result.digits !== undefined && ![6, 7, 8].includes(result.digits)) {
        throw new Error('Account digits must be 6, 7, or 8');
    }
    if (result.period !== undefined && ![30, 60].includes(result.period)) {
        throw new Error('Account period must be 30 or 60');
    }
    for (const field of ['label', 'issuer']) {
        if (result[field] !== undefined && typeof result[field] !== 'string') {
            throw new Error(`Account ${field} must be a string`);
        }
    }
    for (const field of ['siteUrl', 'logoUrl', 'logoPath']) {
        if (result[field] !== undefined
            && result[field] !== null
            && typeof result[field] !== 'string') {
            throw new Error(`Account ${field} must be a string or null`);
        }
    }
    if (result.color !== undefined && !/^#[0-9a-f]{6}$/i.test(result.color)) {
        throw new Error('Account color must be a six-digit hexadecimal color');
    }

    return result;
}

function validateAccounts(value) {
    if (!Array.isArray(value)) {
        throw new Error('Account data must be a JSON array');
    }

    const ids = new Set();
    return value.map((account, index) => {
        if (!account || typeof account !== 'object' || Array.isArray(account)) {
            throw new Error(`Account ${index + 1} must be an object`);
        }
        if (typeof account.id !== 'string' || !account.id.trim() || ids.has(account.id)) {
            throw new Error(`Account ${index + 1} has a missing or duplicate ID`);
        }
        ids.add(account.id);

        const stringField = (name, fallback = '') => {
            const field = account[name];
            if (field === undefined || field === null) {
                return fallback;
            }
            if (typeof field !== 'string') {
                throw new Error(`Account ${account.id} has an invalid ${name}`);
            }
            return field;
        };
        const integerField = (name, fallback, allowedValues = null) => {
            const field = account[name] ?? fallback;
            if (!Number.isSafeInteger(field)
                || (allowedValues && !allowedValues.includes(field))) {
                throw new Error(`Account ${account.id} has an invalid ${name}`);
            }
            return field;
        };
        const timestampField = name => {
            const field = account[name] ?? 0;
            if (!Number.isFinite(field) || field < 0) {
                throw new Error(`Account ${account.id} has an invalid ${name}`);
            }
            return field;
        };

        const algorithm = stringField('algorithm', 'SHA1').toUpperCase();
        if (!VALID_ALGORITHMS.has(algorithm)) {
            throw new Error(`Account ${account.id} has an unsupported algorithm`);
        }

        const color = stringField('color', '#1a73e8');
        if (!/^#[0-9a-f]{6}$/i.test(color)) {
            throw new Error(`Account ${account.id} has an invalid color`);
        }

        return {
            id: account.id,
            label: stringField('label'),
            issuer: stringField('issuer'),
            siteUrl: stringField('siteUrl', null),
            logoUrl: stringField('logoUrl', null),
            logoPath: stringField('logoPath', null),
            algorithm,
            digits: integerField('digits', 6, [6, 7, 8]),
            period: integerField('period', 30, [30, 60]),
            color,
            order: integerField('order', index),
            addedAt: timestampField('addedAt'),
            lastUsed: timestampField('lastUsed'),
        };
    });
}

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

    const generation = _loadGeneration;
    _loadPromise = new Promise((resolve, reject) => {
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
                if (generation !== _loadGeneration) {
                    resolve([]);
                    return;
                }

                try {
                    const [success, contents] = source.load_contents_finish(result);
                    if (!success) {
                        throw new Error('The accounts file could not be read');
                    }
                    if (contents.length > MAX_ACCOUNTS_FILE_BYTES) {
                        throw new Error('The accounts file exceeds the 1 MiB size limit');
                    }

                    const decoder = new TextDecoder('utf-8', { fatal: true });
                    const json = decoder.decode(contents);
                    const parsedAccounts = JSON.parse(json);
                    _accounts = validateAccounts(parsedAccounts);
                    _loaded = true;
                    _loadPromise = null;
                    resolve(_accounts);
                } catch (error) {
                    if (generation !== _loadGeneration) {
                        resolve([]);
                        return;
                    }
                    _loaded = false;
                    _loadPromise = null;
                    const loadError = new Error(`Failed to load accounts: ${error.message}`);
                    console.error(`[TOTP] ${loadError.message}`);
                    reject(loadError);
                }
            });
        } catch (error) {
            _loadPromise = null;
            _loaded = false;
            const loadError = new Error(`Failed to load accounts: ${error.message}`);
            console.error(`[TOTP] ${loadError.message}`);
            reject(loadError);
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

    const safeAccounts = _accounts.map(account => {
        const { secret, ...safe } = account;
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
    } catch (error) {
        const saveError = new Error(`Failed to save accounts: ${error.message}`);
        console.error(`[TOTP] ${saveError.message}`);
        throw saveError;
    }
}

/**
 * Get all accounts sorted by current sort preference.
 *
 * @param {string} [sortOrder='manual'] - Sort method: 'manual', 'alphabetical', 'last-used'
 * @returns {Array<object>} Sorted accounts
 */
export function getAccounts(sortOrder = 'manual') {
    startBackgroundLoad();

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
    startBackgroundLoad();
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

    if (typeof label !== 'string' || typeof issuer !== 'string') {
        throw new Error('Account label and issuer must be strings');
    }
    if (!isValidBase32(secret)) {
        throw new Error('Secret must be a valid Base32 string');
    }
    if (typeof algorithm !== 'string' || !VALID_ALGORITHMS.has(algorithm.toUpperCase())) {
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    if (![6, 7, 8].includes(digits) || ![30, 60].includes(period)) {
        throw new Error('Digits must be 6, 7, or 8 and period must be 30 or 60');
    }
    secret = normalizeBase32(secret);

    const id = GLib.uuid_string_random();
    const now = Date.now();

    // Pick a color if not specified
    if (!color) {
        color = ACCENT_COLORS[_accounts.length % ACCENT_COLORS.length];
    }
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
        throw new Error('Account color must be a six-digit hexadecimal color');
    }
    for (const [field, value] of Object.entries({ siteUrl, logoUrl, logoPath })) {
        if (value !== null && typeof value !== 'string') {
            throw new Error(`Account ${field} must be a string or null`);
        }
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
    try {
        saveAccounts();
    } catch (error) {
        _accounts.pop();
        try {
            await SecretStorage.deleteSecret(id);
        } catch (cleanupError) {
            throw new Error(
                `${error.message}; failed to remove the unreferenced keyring secret: ${cleanupError.message}`,
            );
        }
        throw error;
    }

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
    startBackgroundLoad();

    const index = _accounts.findIndex(a => a.id === id);
    if (index === -1) return null;

    const previous = _accounts[index];
    _accounts[index] = { ...previous, ...normalizeUpdates(updates) };
    try {
        saveAccounts();
    } catch (error) {
        _accounts[index] = previous;
        throw error;
    }

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

    const safeUpdates = normalizeUpdates(updates);
    const normalizedSecret = (newSecret || '').trim();
    if (normalizedSecret && !isValidBase32(normalizedSecret)) {
        throw new Error('Secret must be a valid Base32 string');
    }
    const secretToStore = normalizedSecret ? normalizeBase32(normalizedSecret) : null;
    const previousSecret = secretToStore ? await SecretStorage.lookupSecret(id) : null;
    if (secretToStore) {
        await SecretStorage.storeSecret(id, secretToStore);
    }

    const previousAccount = _accounts[index];
    _accounts[index] = { ...previousAccount, ...safeUpdates };

    try {
        saveAccounts();
    } catch (error) {
        _accounts[index] = previousAccount;
        if (secretToStore) {
            try {
                if (previousSecret === null) {
                    await SecretStorage.deleteSecret(id);
                } else {
                    await SecretStorage.storeSecret(id, previousSecret);
                }
            } catch (rollbackError) {
                throw new Error(
                    `${error.message}; failed to restore the previous keyring secret: ${rollbackError.message}`,
                );
            }
        }
        throw error;
    }
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

    const [account] = _accounts.splice(index, 1);
    _accounts.forEach((entry, order) => entry.order = order);
    try {
        saveAccounts();
    } catch (error) {
        _accounts.splice(index, 0, account);
        _accounts.forEach((entry, order) => entry.order = order);
        throw error;
    }

    try {
        await SecretStorage.deleteSecret(id);
    } catch (error) {
        _accounts.splice(index, 0, account);
        _accounts.forEach((entry, order) => entry.order = order);
        try {
            saveAccounts();
        } catch (rollbackError) {
            throw new Error(
                `Failed to delete keyring secret: ${error.message}; failed to restore account metadata: ${rollbackError.message}`,
            );
        }
        throw error;
    }
    return true;
}

function _moveAccount(id, direction) {
    startBackgroundLoad();

    const previousAccounts = _accounts;
    const previousOrders = previousAccounts.map(account => [account, account.order]);
    const sorted = [..._accounts].sort((a, b) => (a.order || 0) - (b.order || 0));
    const index = sorted.findIndex(a => a.id === id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= sorted.length) return false;

    [sorted[index], sorted[targetIndex]] = [sorted[targetIndex], sorted[index]];
    sorted.forEach((a, i) => a.order = i);
    _accounts = sorted;
    try {
        saveAccounts();
    } catch (error) {
        _accounts = previousAccounts;
        previousOrders.forEach(([account, order]) => account.order = order);
        throw error;
    }
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
        const previousLastUsed = account.lastUsed;
        account.lastUsed = Date.now();
        try {
            saveAccounts();
        } catch (error) {
            account.lastUsed = previousLastUsed;
            console.error(`[TOTP] Failed to update last-used time: ${error.message}`);
        }
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
    startBackgroundLoad();
    return _accounts.length;
}

/**
 * Force reload accounts from disk (used after external changes).
 */
export function reloadAccounts() {
    _loadGeneration++;
    _loaded = false;
    _loadPromise = null;
    startBackgroundLoad();
}

/**
 * Clear all in-memory state (called on extension disable).
 */
export function cleanup() {
    _loadGeneration++;
    _accounts = [];
    _loaded = false;
    _loadPromise = null;
}
