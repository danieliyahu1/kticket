import { useWallet } from "../hooks/use-wallet";

export default function EventsPage() {
  const { state } = useWallet();

  if (state.status !== "connected") {
    return <p>Connect your wallet to browse events.</p>;
  }

  return <p>No events yet.</p>;
}
