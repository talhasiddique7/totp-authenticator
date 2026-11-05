// SPDX-License-Identifier: GPL-3.0-or-later
// TOTP Algorithm — RFC 6238 compliant
// Depends on: hotp.js

import GLib from 'gi://GLib';
import { generateHOTP } from './hotp.js';

/**
 * Calculate the TOTP time counter value.
 *
 * T = floor((currentTime - T0) / period)
 *
 * @param {number} [time] - Unix timestamp in seconds (defaults to now)
 * @param {number} [period=30] - Time step in seconds
 * @param {number} [t0=0] - Unix epoch start time
 * @returns {number} Time counter value
 */
export function getTimeCounter(time = null, period = 30, t0 = 0) {
    if (time === null) {
        time = Math.floor(GLib.get_real_time() / 1000000);
    }
    if (!Number.isFinite(time) || !Number.isFinite(t0)) {
        throw new Error('Time and T0 must be finite numbers');
    }
    if (!Number.isSafeInteger(period) || period <= 0) {
        throw new Error('Period must be a positive safe integer');
    }

    const counter = Math.floor((time - t0) / period);
    if (!Number.isSafeInteger(counter) || counter < 0) {
        throw new Error('Time counter must be a non-negative safe integer');
    }
    return counter;
}

/**
 * Get the number of seconds remaining in the current TOTP period.
 *
 * @param {number} [period=30] - Time step in seconds
 * @returns {number} Seconds remaining (1 to period)
 */
export function getTimeRemaining(period = 30) {
    if (!Number.isSafeInteger(period) || period <= 0) {
        throw new Error('Period must be a positive safe integer');
    }
    const now = Math.floor(GLib.get_real_time() / 1000000);
    const elapsed = now % period;
    return period - elapsed;
}

/**
 * Get the current Unix timestamp in seconds.
 *
 * @returns {number} Current Unix time in seconds
 */
export function getCurrentTime() {
    return Math.floor(GLib.get_real_time() / 1000000);
}

/**
 * Generate a TOTP code per RFC 6238.
 *
 * @param {object} params - TOTP parameters
 * @param {string} params.secret - Base32-encoded secret key
 * @param {string} [params.algorithm='SHA1'] - Hash algorithm (SHA1, SHA256, SHA512)
 * @param {number} [params.digits=6] - Number of output digits (6, 7, or 8)
 * @param {number} [params.period=30] - Time step in seconds (30 or 60)
 * @param {number} [params.time] - Override Unix timestamp (for testing)
 * @returns {string} TOTP code string (zero-padded)
 */
export function generateTOTP({
    secret,
    algorithm = 'SHA1',
    digits = 6,
    period = 30,
    time = null,
}) {
    const counter = getTimeCounter(time, period);

    return generateHOTP({
        secret,
        counter,
        algorithm,
        digits,
    });
}

/**
 * Generate a TOTP code for a specific time window offset.
 * Useful for clock drift tolerance — checking adjacent windows.
 *
 * @param {object} params - Same as generateTOTP
 * @param {number} windowOffset - Window offset (-1, 0, +1, etc.)
 * @returns {string} TOTP code for the adjusted window
 */
export function generateTOTPWithOffset({
    secret,
    algorithm = 'SHA1',
    digits = 6,
    period = 30,
    time = null,
}, windowOffset = 0) {
    if (!Number.isSafeInteger(windowOffset)) {
        throw new Error('Window offset must be a safe integer');
    }
    const counter = getTimeCounter(time, period) + windowOffset;
    if (!Number.isSafeInteger(counter) || counter < 0) {
        throw new Error('Adjusted time counter must be a non-negative safe integer');
    }

    return generateHOTP({
        secret,
        counter,
        algorithm,
        digits,
    });
}
