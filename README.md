# GNOME TOTP Authenticator

A native TOTP (Time-Based One-Time Password) authenticator extension for the GNOME desktop. Access your two-factor authentication codes directly from the top panel — no separate app needed.

## ✨ Features

- **🔐 Live OTP Codes** — Auto-refreshing TOTP codes in a sleek dropdown panel
- **📷 QR Code Scanning** — Add accounts by capturing QR codes from your screen or webcam
- **⌨️ Manual Entry** — Enter secret keys manually with full configuration options
- **🔒 Secure Storage** — Secrets stored exclusively in GNOME Keyring (never on disk)
- **⏱ Countdown Timer** — Visual countdown arc with color transitions (blue → amber → red)
- **🔍 Search** — Quickly filter accounts when you have many
- **🏷 Account Logos** — Fetches and caches service favicons when a site URL is provided
- **🎨 Customizable** — Configurable fonts, colors, popup width, and sort order
- **🛡 Screen Lock Integration** — Auto-closes popup when screen locks

## 📋 Requirements

| Requirement | Version |
|---|---|
| GNOME Shell | 45 or later |
| libsecret | Any (GNOME Keyring) |
| zbar-tools | Optional (for QR scanning) |

### Supported GNOME Versions

GNOME Shell 45, 46, 47, 48, 49, 50

## 🚀 Installation

### Quick Install

```bash
git clone <repo-url>
cd totp
chmod +x install.sh
./install.sh
```

### Manual Install

```bash
# Copy extension files
mkdir -p ~/.local/share/gnome-shell/extensions/gnome-totp-authenticator@local
cp -r gnome-totp-authenticator@local/* ~/.local/share/gnome-shell/extensions/gnome-totp-authenticator@local/

# Compile schemas
glib-compile-schemas ~/.local/share/gnome-shell/extensions/gnome-totp-authenticator@local/schemas/

# Enable
gnome-extensions enable gnome-totp-authenticator@local
```

Then restart GNOME Shell:
- **Wayland**: Log out and log back in
- **X11**: Press `Alt+F2`, type `r`, press Enter

### Install QR Scanning Dependencies (Optional)

```bash
# Ubuntu / Debian
sudo apt install zbar-tools

# Fedora / RHEL
sudo dnf install zbar

# Arch Linux
sudo pacman -S zbar
```

## 📖 Usage

### Adding an Account

1. Click the 🔐 shield icon in the top panel
2. Click the **+** button
3. Choose **Scan QR Code** or **Enter Manually**

#### QR Code Scanning
- Click **Capture Screen Area** to select a QR code on your screen
- Or click **Use Camera** to scan with your webcam
- Review the detected account details and confirm

#### Manual Entry
- Enter the **Service Name** (e.g., GitHub)
- Enter the **Account** label (e.g., your email)
- Enter the **Secret Key** (Base32 format)
- Optionally adjust Algorithm, Digits, and Period

### Managing Accounts

- **Right-click** any account for options: Edit, Delete, Move Up, Move Down
- Accounts can be sorted by Manual order, Alphabetical, or Last Used

### Preferences

Open preferences via:
```bash
gnome-extensions prefs gnome-totp-authenticator@local
```

Or click the ⚙ gear icon in the popup header.

## 🔒 Security

- **Secrets** are stored exclusively in **GNOME Keyring** — never written to disk
- **Local code generation** — TOTP generation stays local; optional logo fetching only downloads service favicons
- **Screen lock integration** — popup closes when the screen locks
- **No logging** — secrets are never printed to console or journal

## 🛠 Configuration

| Setting | Default | Description |
|---|---|---|
| Code Font | Monospace | Font for OTP code display |
| Code Size | 28pt | Font size for OTP codes |
| Popup Width | 360px | Dropdown panel width (320-480) |
| Sort Order | Manual | Manual, Alphabetical, or Last Used |
| Clock Drift | ±1 window | Tolerance for clock skew |
| Lock on Screen Lock | On | Close popup when screen locks |

## 📜 License

GPL-3.0-or-later
