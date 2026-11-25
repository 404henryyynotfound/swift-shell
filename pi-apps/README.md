# Pi-Apps entry for SwiftShell

`Swift Shell/` is a ready-made [Pi-Apps](https://pi-apps.io/) definition for 64-bit ARM Raspberry Pi systems. Its `install-64` script downloads the arm64 `.deb` from the matching GitHub Release, verifies SHA-256, and installs it with Pi-Apps' `install_packages` helper. `uninstall` uses `purge_packages`, keeping anything installed under `~/.swift-shell`.

## Import without waiting for official inclusion

1. Install Pi-Apps from <https://pi-apps.io/install/>.
2. Open **Pi-Apps Settings → Import app**.
3. Import `Swift-Shell.zip` from this folder (or the copy attached to the GitHub Release).
4. Find **Swift Shell** under Imported and install it.

Rebuild the zip after editing the app definition:

```bash
cd pi-apps
zip -qr Swift-Shell.zip "Swift Shell"
```

## Official submission

Copy `Swift Shell/` into `apps/` of a Pi-Apps fork, add `Swift Shell|Programming` to `etc/categories`, keep scripts executable, and open a pull request against `Botspot/pi-apps` following their CONTRIBUTING guide.
