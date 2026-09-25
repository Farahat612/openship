import { networkInterfaces } from "node:os";
import { getPlatform } from "@repo/adapters";

/**
 * An offline desktop cannot observe its remote servers. Check the machine that
 * owns the SSH connections, not the browser viewing its dashboard.
 *
 * An assigned external interface only means connectivity is POSSIBLE: VPNs,
 * captive portals and a lost upstream link can still prevent a connection. In
 * that case the normal server probe remains authoritative. No public Internet
 * endpoint is required, so isolated LANs keep working.
 */
export function desktopNetworkDisconnected(): boolean {
  if (getPlatform().target !== "desktop") return false;
  try {
    return !Object.values(networkInterfaces()).some((addresses) =>
      addresses?.some((address) => !address.internal),
    );
  } catch {
    // Failure to inspect this machine is not evidence that any server is down.
    return false;
  }
}
