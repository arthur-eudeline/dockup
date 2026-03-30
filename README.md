⚠️ **Under active development**

# Dockup

Dockup is a lightweight, automated backup solution designed for Docker environments. Inspired by Traefik’s dynamic configuration, Dockup uses Docker Labels to automatically discover and back up your services using the power of Restic.
Stop manually configuring backup jobs. Just label your containers, and Dockup handles the rest.

## Features

- 🔍 Auto-Discovery: Automatically detects running containers via Docker labels (no static config files needed).
- 🛡️ Restic Powered: Benefit from deduplication, encryption, and multi-backend support (only S3 is supported at the moment).
- ⚡ Zero-Config Deployment: Deploy Dockup as a single container and let it watch your cluster.
- 🗓️ scheduled Cron Support: Define backup intervals globally or per-container.
- 💾 Volume & Database Support: Designed to back up persistent data safely.

## ⚖️ License & Warranty

This tool is distributed for free under the GNU GPL v3 License.

No Warranty
This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

Disclaimer: The author is not responsible for any data loss, damages, or issues resulting from the use of this tool. Use it at your own risk.
