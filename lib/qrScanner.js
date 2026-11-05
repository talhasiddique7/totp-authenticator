// SPDX-License-Identifier: GPL-3.0-or-later
// QR Code Scanner — zbar subprocess wrapper
// Spawns zbarimg/zbarcam for QR code detection

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Check if a program is available on the system.
 *
 * @param {string} program - Program name to find
 * @returns {boolean} True if available
 */
export function isProgramAvailable(program) {
    return GLib.find_program_in_path(program) !== null;
}

/**
 * Check all required dependencies for QR scanning.
 *
 * @returns {object} Dependency status
 */
export function checkDependencies() {
    return {
        zbarimg: isProgramAvailable('zbarimg'),
        zbarcam: isProgramAvailable('zbarcam'),
        gnomeScreenshot: isProgramAvailable('gnome-screenshot'),
        // grim is the Wayland alternative
        grim: isProgramAvailable('grim'),
        slurp: isProgramAvailable('slurp'),
        hasScreenCapture: isProgramAvailable('gnome-screenshot') ||
                          (isProgramAvailable('grim') && isProgramAvailable('slurp')),
        hasCamera: isProgramAvailable('zbarcam'),
    };
}

/**
 * Get install instructions for missing dependencies.
 *
 * @returns {string} Installation command string
 */
export function getInstallInstructions() {
    const deps = checkDependencies();
    const missing = [];

    if (!deps.zbarimg) missing.push('zbar-tools');
    if (!deps.gnomeScreenshot && !deps.hasScreenCapture) {
        if (deps.grim) {
            missing.push('slurp');
        } else if (deps.slurp) {
            missing.push('grim');
        } else {
            missing.push('gnome-screenshot');
        }
    }

    if (missing.length === 0) return '';

    // Detect package manager
    if (isProgramAvailable('apt')) {
        return `sudo apt install ${missing.join(' ')}`;
    } else if (isProgramAvailable('dnf')) {
        return `sudo dnf install ${missing.join(' ')}`;
    } else if (isProgramAvailable('pacman')) {
        return `sudo pacman -S ${missing.join(' ')}`;
    }

    return `Install: ${missing.join(', ')}`;
}

/**
 * Run a subprocess and capture stdout.
 *
 * @param {Array<string>} argv - Command and arguments
 * @param {number} [timeoutMs=15000] - Timeout in milliseconds
 * @returns {Promise<string>} stdout output
 */
function runSubprocess(argv, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        let timeoutId = 0;
        const cancellable = Gio.Cancellable.new();

        const clearTimeout = () => {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
        };

        try {
            const executable = GLib.find_program_in_path(argv[0]);
            if (!executable) {
                reject(new Error(`${argv[0]} not found`));
                return;
            }

            const proc = Gio.Subprocess.new(
                [executable, ...argv.slice(1)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timeoutId = 0;
                cancellable.cancel();
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });

            proc.communicate_utf8_async(null, cancellable, (source, result) => {
                clearTimeout();

                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(result);
                    const output = (stdout || '').trim();
                    const errorOutput = (stderr || '').trim();

                    if (!source.get_successful() && !output) {
                        const status = source.get_exit_status();
                        reject(new Error(errorOutput || `Process exited with status ${status}`));
                        return;
                    }

                    resolve(output);
                } catch (e) {
                    if (cancellable.is_cancelled()) {
                        reject(new Error(`Process timed out after ${Math.round(timeoutMs / 1000)} seconds`));
                    } else {
                        reject(new Error(`Failed to run subprocess: ${e.message}`));
                    }
                }
            });
        } catch (e) {
            clearTimeout();
            reject(new Error(`Failed to spawn subprocess: ${e.message}`));
        }
    });
}

/**
 * Capture a screen area and scan for QR codes.
 *
 * Flow:
 *   1. Launch gnome-screenshot (or grim+slurp) for area selection
 *   2. Run zbarimg on the captured image
 *   3. Return decoded URI
 *   4. Clean up temp file
 *
 * @returns {Promise<string>} Decoded QR code content (typically otpauth:// URI)
 */
export async function scanScreenArea() {
    const deps = checkDependencies();

    if (!deps.zbarimg) {
        throw new Error('zbarimg not found. Install zbar-tools.');
    }

    if (!deps.hasScreenCapture) {
        throw new Error('No screen capture tool found. Install gnome-screenshot.');
    }

    const capture = createCaptureLocation();

    try {
        // Step 1: Capture screen area
        if (deps.grim && deps.slurp) {
            // Wayland: use slurp for selection, grim for capture
            const geometry = await runSubprocess(['slurp'], 30000);
            await runSubprocess(['grim', '-g', geometry, capture.path], 5000);
        } else {
            // X11/XWayland: gnome-screenshot area capture
            await runSubprocess(
                ['gnome-screenshot', '-a', '-f', capture.path],
                30000  // Longer timeout for user selection
            );
        }

        // Verify capture file exists
        const captureFile = Gio.File.new_for_path(capture.path);
        if (!captureFile.query_exists(null)) {
            throw new Error('Screen capture was cancelled or failed');
        }

        // Step 2: Decode QR code
        const decoded = await runSubprocess(
            ['zbarimg', '-q', '--raw', capture.path],
            10000
        );

        if (!decoded) {
            throw new Error('No QR code found in the captured area');
        }

        return decoded;
    } finally {
        cleanupCaptureLocation(capture);
    }
}

/**
 * Scan QR code from webcam.
 *
 * Spawns zbarcam with a preview window and exits after the first scan.
 *
 * @returns {Promise<string>} Decoded QR code content
 */
export async function scanCamera() {
    const deps = checkDependencies();

    if (!deps.hasCamera) {
        throw new Error('zbarcam not found. Install zbar-tools.');
    }

    const decoded = await runSubprocess(
        ['zbarcam', '--raw', '--prescale=640x480', '-q', '--oneshot'],
        30000  // 30 second timeout for camera scanning
    );

    if (!decoded) {
        throw new Error('No QR code detected from camera');
    }

    return decoded;
}

/**
 * Decode a QR code from an existing image file.
 *
 * @param {string} filePath - Absolute path to image file
 * @returns {Promise<string>} Decoded QR content
 */
export async function scanFile(filePath) {
    if (!isProgramAvailable('zbarimg')) {
        throw new Error('zbarimg not found. Install zbar-tools.');
    }

    const decoded = await runSubprocess(
        ['zbarimg', '-q', '--raw', filePath],
        10000
    );

    if (!decoded) {
        throw new Error('No QR code found in the image');
    }

    return decoded;
}

/**
 * Clean up temporary capture file.
 * @private
 */
function createCaptureLocation() {
    const directory = GLib.dir_make_tmp('gnome-totp-qr-XXXXXX');
    return {
        directory,
        path: GLib.build_filenamev([directory, 'capture.png']),
    };
}

function cleanupCaptureLocation(location) {
    const image = Gio.File.new_for_path(location.path);
    const directory = Gio.File.new_for_path(location.directory);

    if (image.query_exists(null)) {
        try {
            image.delete(null);
        } catch (error) {
            console.error(`[TOTP] Failed to remove QR capture: ${error.message}`);
        }
    }

    if (directory.query_exists(null)) {
        try {
            directory.delete(null);
        } catch (error) {
            console.error(`[TOTP] Failed to remove QR capture directory: ${error.message}`);
        }
    }
}
