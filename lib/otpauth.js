// SPDX-License-Identifier: GPL-3.0-or-later
// otpauth:// URI Parser
// Reference: https://github.com/google/google-authenticator/wiki/Key-Uri-Format

import { isValid as isValidBase32, normalize as normalizeBase32 } from './base32.js';

function decodeQueryComponent(value) {
    return decodeURIComponent(value.replace(/\+/g, ' '));
}

function parseIntegerParameter(params, name, defaultValue) {
    const rawValue = params.get(name);
    if (rawValue === undefined) {
        return defaultValue;
    }

    if (!/^\d+$/.test(rawValue)) {
        throw new Error(`Invalid ${name} value: ${rawValue}`);
    }

    const value = Number(rawValue);
    if (!Number.isSafeInteger(value)) {
        throw new Error(`${name} must be a safe integer`);
    }
    return value;
}

/**
 * Parse an otpauth:// URI into an account configuration object.
 *
 * URI format:
 *   otpauth://totp/LABEL?secret=BASE32SECRET&issuer=ISSUER&algorithm=SHA1&digits=6&period=30
 *
 * Label format (both supported):
 *   - "issuer:account"  (e.g., "GitHub:octocat@github.com")
 *   - "account"         (e.g., "octocat@github.com")
 *
 * All query parameters are optional except `secret`.
 *
 * @param {string} uri - otpauth:// URI string
 * @returns {object} Parsed account configuration
 * @throws {Error} If URI is malformed or missing required fields
 */
export function parseOtpauthUri(uri) {
    if (!uri || typeof uri !== 'string') {
        throw new Error('URI must be a non-empty string');
    }

    const trimmed = uri.trim();

    // Validate scheme
    if (!/^otpauth:\/\//i.test(trimmed)) {
        throw new Error('URI must start with "otpauth://"');
    }

    // Remove scheme
    const rest = trimmed.substring('otpauth://'.length);

    // Extract type (totp or hotp)
    const slashIndex = rest.indexOf('/');
    if (slashIndex === -1) {
        throw new Error('URI missing type and label (expected otpauth://totp/LABEL?...)');
    }

    const type = rest.substring(0, slashIndex).toLowerCase();
    if (type !== 'totp' && type !== 'hotp') {
        throw new Error(`Unsupported OTP type: "${type}". Only "totp" and "hotp" are supported.`);
    }

    // Extract label and query string
    const afterType = rest.substring(slashIndex + 1);
    const queryIndex = afterType.indexOf('?');

    let rawLabel;
    let queryString = '';

    if (queryIndex === -1) {
        rawLabel = afterType;
    } else {
        rawLabel = afterType.substring(0, queryIndex);
        queryString = afterType.substring(queryIndex + 1);
    }

    // Decode label (URI-encoded)
    rawLabel = decodeURIComponent(rawLabel);

    // Parse label: "issuer:account" or just "account"
    let labelIssuer = '';
    let labelAccount = rawLabel;

    const colonIndex = rawLabel.indexOf(':');
    if (colonIndex !== -1) {
        labelIssuer = rawLabel.substring(0, colonIndex).trim();
        labelAccount = rawLabel.substring(colonIndex + 1).trim();
    }

    // Parse query parameters
    const params = new Map();
    if (queryString) {
        for (const pair of queryString.split('&')) {
            const eqIndex = pair.indexOf('=');
            if (eqIndex === -1) continue;
            const key = decodeQueryComponent(pair.substring(0, eqIndex)).toLowerCase();
            const value = decodeQueryComponent(pair.substring(eqIndex + 1));
            if (params.has(key)) {
                throw new Error(`Duplicate URI parameter: "${key}"`);
            }
            params.set(key, value);
        }
    }

    // Extract secret (required)
    const secret = params.get('secret');
    if (!secret) {
        throw new Error('URI missing required "secret" parameter');
    }

    // Validate secret is valid Base32
    if (!isValidBase32(secret)) {
        throw new Error('Invalid Base32 secret in URI');
    }

    // Extract issuer — query param takes precedence over label prefix
    const issuer = params.get('issuer') || labelIssuer || '';

    // Extract algorithm with validation
    const rawAlgorithm = (params.get('algorithm') || 'SHA1').toUpperCase();
    const validAlgorithms = ['SHA1', 'SHA256', 'SHA512'];
    if (!validAlgorithms.includes(rawAlgorithm)) {
        throw new Error(`Unsupported algorithm: "${rawAlgorithm}". Use SHA1, SHA256, or SHA512.`);
    }

    // Extract digits with validation
    const rawDigits = parseIntegerParameter(params, 'digits', 6);
    if (![6, 7, 8].includes(rawDigits)) {
        throw new Error(`Invalid digits value: ${rawDigits}. Must be 6, 7, or 8.`);
    }

    // Extract period with validation
    const rawPeriod = parseIntegerParameter(params, 'period', 30);
    if (![30, 60].includes(rawPeriod)) {
        throw new Error(`Invalid period value: ${rawPeriod}. Must be 30 or 60.`);
    }

    // Extract counter (for HOTP only)
    const counter = type === 'hotp'
        ? parseIntegerParameter(params, 'counter', 0)
        : undefined;

    return {
        type,
        label: labelAccount,
        issuer,
        secret: normalizeBase32(secret),
        algorithm: rawAlgorithm,
        digits: rawDigits,
        period: rawPeriod,
        counter,
    };
}

/**
 * Build an otpauth:// URI from account parameters.
 *
 * @param {object} account - Account configuration
 * @param {string} account.label - Account label/email
 * @param {string} account.issuer - Service name
 * @param {string} account.secret - Base32-encoded secret
 * @param {string} [account.algorithm='SHA1'] - Hash algorithm
 * @param {number} [account.digits=6] - Number of digits
 * @param {number} [account.period=30] - Time period in seconds
 * @returns {string} otpauth:// URI
 */
export function buildOtpauthUri(account) {
    const {
        label,
        issuer,
        secret,
        algorithm = 'SHA1',
        digits = 6,
        period = 30,
    } = account;

    if (typeof label !== 'string' || !label.trim()) {
        throw new Error('Account label must be a non-empty string');
    }
    if (typeof issuer !== 'string') {
        throw new Error('Issuer must be a string');
    }
    if (!isValidBase32(secret)) {
        throw new Error('Secret must be a valid Base32 string');
    }

    const normalizedAlgorithm = typeof algorithm === 'string' ? algorithm.toUpperCase() : '';
    if (!['SHA1', 'SHA256', 'SHA512'].includes(normalizedAlgorithm)) {
        throw new Error(`Unsupported algorithm: "${algorithm}"`);
    }
    if (![6, 7, 8].includes(digits) || ![30, 60].includes(period)) {
        throw new Error('Digits must be 6, 7, or 8 and period must be 30 or 60');
    }

    const encodedLabel = issuer
        ? `${encodeURIComponent(issuer)}:${encodeURIComponent(label)}`
        : encodeURIComponent(label);

    const params = [`secret=${encodeURIComponent(normalizeBase32(secret))}`];
    if (issuer) params.push(`issuer=${encodeURIComponent(issuer)}`);
    if (normalizedAlgorithm !== 'SHA1') params.push(`algorithm=${encodeURIComponent(normalizedAlgorithm)}`);
    if (digits !== 6) params.push(`digits=${digits}`);
    if (period !== 30) params.push(`period=${period}`);

    return `otpauth://totp/${encodedLabel}?${params.join('&')}`;
}
