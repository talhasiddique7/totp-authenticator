// SPDX-License-Identifier: GPL-3.0-or-later
// HOTP Algorithm — RFC 4226 compliant
// Depends on: GLib (for HMAC), base32.js

import GLib from 'gi://GLib';
import { decode as base32Decode } from './base32.js';

/**
 * Map algorithm name to GLib.ChecksumType and digest length.
 */
const ALGORITHMS = {
    'SHA1':   { type: GLib.ChecksumType.SHA1,   digestLen: 20 },
    'SHA256': { type: GLib.ChecksumType.SHA256,  digestLen: 32 },
    'SHA512': { type: GLib.ChecksumType.SHA512,  digestLen: 64 },
};

/**
 * Convert a hex string to a Uint8Array.
 * @param {string} hex - Hex-encoded string
 * @returns {Uint8Array} Binary data
 */
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

/**
 * Convert a 64-bit counter value to an 8-byte big-endian Uint8Array.
 * @param {number} counter - Counter value (integer)
 * @returns {Uint8Array} 8-byte big-endian representation
 */
function counterToBytes(counter) {
    const bytes = new Uint8Array(8);
    // JavaScript bitwise ops work on 32-bit integers,
    // so we split into high and low 32-bit parts.
    let value = counter;
    for (let i = 7; i >= 0; i--) {
        bytes[i] = value & 0xff;
        value = Math.floor(value / 256);
    }
    return bytes;
}

/**
 * Dynamic Truncation as defined in RFC 4226 §5.3.
 *
 * Takes the HMAC digest and extracts a 4-byte dynamic binary code,
 * then reduces it to the desired number of digits.
 *
 * @param {Uint8Array} hmacResult - Full HMAC digest bytes
 * @param {number} digits - Number of output digits (6, 7, or 8)
 * @returns {string} Zero-padded OTP string
 */
function dynamicTruncation(hmacResult, digits) {
    // Step 1: Determine offset from last nibble
    const offset = hmacResult[hmacResult.length - 1] & 0x0f;

    // Step 2: Extract 4 bytes starting at offset
    const binCode =
        ((hmacResult[offset] & 0x7f) << 24) |
        ((hmacResult[offset + 1] & 0xff) << 16) |
        ((hmacResult[offset + 2] & 0xff) << 8) |
        (hmacResult[offset + 3] & 0xff);

    // Step 3: Reduce to desired digits
    const modulus = Math.pow(10, digits);
    const otp = binCode % modulus;

    // Step 4: Zero-pad to the required length
    return otp.toString().padStart(digits, '0');
}

/**
 * Generate an HOTP code per RFC 4226.
 *
 * @param {object} params - HOTP parameters
 * @param {string} params.secret - Base32-encoded secret key
 * @param {number} params.counter - Counter value (moving factor)
 * @param {string} [params.algorithm='SHA1'] - Hash algorithm (SHA1, SHA256, SHA512)
 * @param {number} [params.digits=6] - Number of digits (6, 7, or 8)
 * @returns {string} HOTP code string (zero-padded)
 * @throws {Error} If algorithm is unsupported or secret is invalid
 */
export function generateHOTP({
    secret,
    counter,
    algorithm = 'SHA1',
    digits = 6,
}) {
    // Validate algorithm
    if (typeof algorithm !== 'string') {
        throw new Error('Algorithm must be a string');
    }
    const algo = ALGORITHMS[algorithm.toUpperCase()];
    if (!algo) {
        throw new Error(`Unsupported algorithm: ${algorithm}. Use SHA1, SHA256, or SHA512.`);
    }

    // Validate digits
    if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
        throw new Error(`Digits must be 6, 7, or 8. Got: ${digits}`);
    }

    if (!Number.isSafeInteger(counter) || counter < 0) {
        throw new Error('Counter must be a non-negative safe integer');
    }

    const keyBytes = base32Decode(secret);
    if (keyBytes.length === 0) {
        throw new Error('Secret must decode to at least one byte');
    }

    const counterBytes = counterToBytes(counter);

    try {
        const hmacHex = GLib.compute_hmac_for_data(
            algo.type,
            keyBytes,
            counterBytes
        );

        const hmacBytes = hexToBytes(hmacHex);
        try {
            return dynamicTruncation(hmacBytes, digits);
        } finally {
            hmacBytes.fill(0);
        }
    } finally {
        keyBytes.fill(0);
        counterBytes.fill(0);
    }

}
