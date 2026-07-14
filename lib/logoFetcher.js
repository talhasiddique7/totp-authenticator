// SPDX-License-Identifier: GPL-3.0-or-later
// Logo Fetcher — Automatically fetch site logos for services

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup";

const LOGO_CACHE_DIR = GLib.build_filenamev([
  GLib.get_user_cache_dir(),
  "gnome-totp-auth",
  "logos",
]);
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_FETCH_TIMEOUT_MS = 3000;

// Common service mappings to their domains
const SERVICE_DOMAINS = {
  google: "google.com",
  macrowhale: "macrowhale.limeox.org",
  edgarpro: "edgarpro.limeox.org",
  github: "github.com",
  facebook: "facebook.com",
  twitter: "twitter.com",
  amazon: "amazon.com",
  microsoft: "microsoft.com",
  apple: "apple.com",
  reddit: "reddit.com",
  linkedin: "linkedin.com",
  instagram: "instagram.com",
  discord: "discord.com",
  slack: "slack.com",
  dropbox: "dropbox.com",
  zoom: "zoom.com",
  notion: "notion.so",
  trello: "trello.com",
  asana: "asana.com",
  figma: "figma.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  jira: "jira.com",
  confluence: "confluence.com",
  aws: "aws.amazon.com",
  azure: "azure.microsoft.com",
  heroku: "heroku.com",
  digitalocean: "digitalocean.com",
  linode: "linode.com",
  stripe: "stripe.com",
  paypal: "paypal.com",
  twilio: "twilio.com",
  sendgrid: "sendgrid.com",
  mailchimp: "mailchimp.com",
  okta: "okta.com",
  auth0: "auth0.com",
  lastpass: "lastpass.com",
  "1password": "1password.com",
  bitwarden: "bitwarden.com",
  dashlane: "dashlane.com",
};

/**
 * Fetch logo URL for a given service/issuer name or site URL
 * Uses DuckDuckGo's icon API as the primary source
 *
 * @param {string} issuerOrUrl - Service name, domain, or full URL
 * @returns {string|null} Logo URL or null if not found
 */
export function getLogoUrl(issuerOrUrl) {
  const domain = getDomain(issuerOrUrl);
  return domain ? getDuckDuckGoLogoUrl(domain) : null;
}

/**
 * Extract a favicon domain from a service/issuer name or site URL.
 *
 * @param {string} issuerOrUrl - Service name, domain, or full URL
 * @returns {string|null} Domain suitable for favicon lookup
 */
export function getDomain(issuerOrUrl) {
  if (!issuerOrUrl) return null;

  const normalized = issuerOrUrl.toLowerCase().trim();
  if (!normalized) return null;

  if (
    normalized.includes("http://") ||
    normalized.includes("https://") ||
    normalized.includes("www.")
  ) {
    return sanitizeDomain(normalized);
  }

  if (normalized.includes('.')) {
    return sanitizeDomain(normalized);
  }

  const domain = SERVICE_DOMAINS[normalized] || normalized;

  if (!domain.includes(".") && !domain.match(/^[a-z0-9\-]+$/i)) {
    return null;
  }

  return sanitizeDomain(domain);
}

function sanitizeDomain(domain) {
  if (!domain) return null;

  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0]
    .split(":")[0]
    .replace(/[^a-z0-9.-]/g, "");
}

/**
 * Get logo URL from DuckDuckGo's icon service
 * @private
 */
function getDuckDuckGoLogoUrl(domain) {
  if (!domain) return null;
  if (!domain.includes(".")) return null;
  // DuckDuckGo provides favicons at: https://icons.duckduckgo.com/ip3/{domain}.ico
  return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
}

function ensureCacheDir() {
  const dir = Gio.File.new_for_path(LOGO_CACHE_DIR);
  if (!dir.query_exists(null)) {
    dir.make_directory_with_parents(null);
  }
}

function getCachePath(domain) {
  const safeDomain = sanitizeDomain(domain)?.replace(/[^a-z0-9.-]/g, "");
  if (!safeDomain) return null;
  return GLib.build_filenamev([LOGO_CACHE_DIR, `${safeDomain}.ico`]);
}

function getUsableCachedPath(domain) {
  const path = getCachePath(domain);
  if (!path) return null;

  const file = Gio.File.new_for_path(path);
  return file.query_exists(null) ? path : null;
}

function clearTimeoutSource(timeoutId) {
  if (timeoutId) {
    GLib.source_remove(timeoutId);
  }
}

async function downloadLogo(url) {
  const session = new Soup.Session();
  const message = Soup.Message.new("GET", url);
  if (!message) return null;

  message.request_headers.append(
    "User-Agent",
    "GNOME TOTP Authenticator",
  );

  const cancellable = Gio.Cancellable.new();
  const timeoutId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    LOGO_FETCH_TIMEOUT_MS,
    () => {
      cancellable.cancel();
      return GLib.SOURCE_REMOVE;
    },
  );

  try {
    const bytes = await new Promise((resolve, reject) => {
      session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        cancellable,
        (source, result) => {
          try {
            resolve(source.send_and_read_finish(result));
          } catch (e) {
            reject(e);
          }
        },
      );
    });

    if (message.status_code < 200 || message.status_code >= 300) {
      return null;
    }
    if (!bytes || bytes.get_size() === 0 || bytes.get_size() > MAX_LOGO_BYTES) {
      return null;
    }

    return bytes.get_data();
  } catch (_) {
    return null;
  } finally {
    clearTimeoutSource(timeoutId);
  }
}

/**
 * Fetch a logo and cache it locally so Shell UI can render it as a GIcon.
 *
 * @param {string} issuerOrUrl - Service name, domain, or full site URL
 * @returns {Promise<{domain: string, url: string, path: string|null}|null>}
 */
export async function fetchLogo(issuerOrUrl) {
  const domain = getDomain(issuerOrUrl);
  const url = getLogoUrl(issuerOrUrl);
  if (!domain || !url) return null;

  const cachedPath = getUsableCachedPath(domain);
  if (cachedPath) {
    return { domain, url, path: cachedPath };
  }

  try {
    ensureCacheDir();
    const contents = await downloadLogo(url);
    if (!contents) return { domain, url, path: null };

    const path = getCachePath(domain);
    if (!path) return { domain, url, path: null };

    const file = Gio.File.new_for_path(path);
    file.replace_contents(
      contents,
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
    );

    return { domain, url, path };
  } catch (_) {
    return { domain, url, path: null };
  }
}

/**
 * Fetch and cache a logo, returning only the local file path if available.
 *
 * @param {string} issuerOrUrl - Service name, domain, or full site URL
 * @returns {Promise<string|null>}
 */
export async function fetchLogoPath(issuerOrUrl) {
  const logo = await fetchLogo(issuerOrUrl);
  return logo?.path ?? null;
}

/**
 * Return the remote logo URL without downloading it.
 *
 * @param {string} issuerOrUrl - Service name, domain, or full site URL
 * @returns {Promise<string|null>} Logo URL or null
 */
export async function fetchLogoUrl(issuerOrUrl) {
  return getLogoUrl(issuerOrUrl);
}

/**
 * Get service suggestion from user input (for autocomplete-like features)
 * Returns null if no match found
 *
 * @param {string} input - Partial service name
 * @returns {string|null} Matched service name
 */
export function getSuggestion(input) {
  if (!input || input.length < 2) return null;

  const normalized = input.toLowerCase();
  const matches = Object.keys(SERVICE_DOMAINS).filter((service) =>
    service.startsWith(normalized)
  );

  return matches.length > 0 ? matches[0] : null;
}
