import { KASWARE_INSTALL_URL } from "../wallet/kasware";

/**
 * The one place a visitor is offered the wallet extension. A bare "Install"
 * button reads as a toll gate to someone who only wants to look around, so the
 * note names Kasware, says what it signs for, and says when it is not needed
 * (issue #8).
 */
export function KaswareNote() {
  return (
    <p className="kasware-note">
      Kasware is the wallet that signs for you. You only need it to create, buy or hold a
      ticket — looking around doesn&apos;t.{" "}
      <a
        className="kasware-note-link"
        href={KASWARE_INSTALL_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Get Kasware
      </a>
    </p>
  );
}
