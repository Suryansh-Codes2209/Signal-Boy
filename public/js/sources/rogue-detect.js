/**
 * Heuristic rogue-/evil-twin access-point detection over a single scan.
 *
 * This is defensive and honest about its limits: a WebView cannot see 802.11
 * management frames, so it cannot catch a deauth flood or a KARMA responder in
 * the act. What it CAN do is compare the access points a normal scan returns
 * and flag the shapes an evil twin usually takes:
 *
 *   - an OPEN network advertising the same name as a SECURED one (the classic
 *     lure: your device auto-joins the open copy and the attacker sees traffic)
 *   - one SSID advertised by BSSIDs from clearly different hardware vendors,
 *     which a legitimate single network rarely is
 *
 * Every finding is a suspicion to investigate, not a verdict -- the view labels
 * them that way. Pure over the mapScanResults() shape, `node --test` covered.
 */

import { OUI_VENDORS } from '../data/oui.js';

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

/** The 24-bit vendor prefix of a BSSID ("aa:bb:cc"), lowercased, or null. */
export function ouiOf(bssid) {
  if (!bssid) return null;
  const match = String(bssid)
    .toLowerCase()
    .match(/^([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}):/);
  return match ? match[1] : null;
}

/** Vendor name for a BSSID from the small display map, or null when unlisted. */
export function vendorOf(bssid) {
  const oui = ouiOf(bssid);
  return oui ? (OUI_VENDORS[oui] ?? null) : null;
}

function isOpen(security) {
  return !security || String(security).toUpperCase() === 'OPEN';
}

/**
 * Suspicious SSID groups from a scan, worst-first. Each finding is
 * { ssid, severity, reason, bssids, vendors }.
 */
export function detectRogues(networks) {
  const groups = new Map();
  for (const n of networks ?? []) {
    if (!n.ssid) continue; // a hidden network has no name to be twinned
    if (!groups.has(n.ssid)) groups.set(n.ssid, []);
    groups.get(n.ssid).push(n);
  }

  const findings = [];
  for (const [ssid, aps] of groups) {
    if (aps.length < 2) continue; // nothing to compare a lone AP against

    const bssids = aps.map((a) => a.bssid).filter(Boolean);
    const vendors = [...new Set(aps.map((a) => vendorOf(a.bssid)).filter(Boolean))];
    const distinctOuis = new Set(aps.map((a) => ouiOf(a.bssid)).filter(Boolean));
    const anyOpen = aps.some((a) => isOpen(a.security));
    const anySecured = aps.some((a) => !isOpen(a.security));

    if (anyOpen && anySecured) {
      // The strongest signal, and the one with the fewest false positives: a
      // secured network does not also advertise an open twin of itself.
      findings.push({
        ssid,
        severity: 'high',
        reason: 'OPEN COPY OF A SECURED NETWORK -- POSSIBLE EVIL-TWIN LURE',
        bssids,
        vendors,
      });
    } else if (distinctOuis.size > 1) {
      // Same name, different hardware vendors. Big managed deployments can look
      // like this legitimately, so it is a lead to check, not a high alarm.
      findings.push({
        ssid,
        severity: 'medium',
        reason: `SAME NAME ON ${distinctOuis.size} DIFFERENT HARDWARE VENDORS -- VERIFY BEFORE JOINING`,
        bssids,
        vendors,
      });
    }
  }

  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}
